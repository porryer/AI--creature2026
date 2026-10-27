import { Inject, Injectable } from '@nestjs/common';
import type { OutputDTO, TaskStatus } from '@creature/shared';
import { z } from 'zod';
import { AssetsService } from '../assets/assets.service';
import { AppError, Errors } from '../common/errors';
import { newId } from '../common/ids';
import { parse } from '../common/http';
import { Db, DB } from '../db/db';

const MAX_DOC_BYTES = 1024 * 1024;

const NodeSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(['image', 'video', 'text', 'audio']),
  title: z.string().max(100),
  prompt: z.string().max(4000),
  x: z.number().finite(),
  y: z.number().finite(),
  modelCode: z.string().max(40),
  params: z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean()])),
  count: z.number().int().min(1).max(12),
  status: z.string().max(20),
  taskId: z.string().max(64).optional(),
  /** 节点被修改后，上一次运行的任务：继续展示它的产物，直到重新运行 */
  prevTaskId: z.string().max(64).optional(),
});
// 未知字段（如前端带上的 outputs 签名地址）会被丢弃，不落库
export const DocSchema = z.object({
  nodes: z.array(NodeSchema).max(500, '单个画布最多 500 个节点'),
  edges: z.array(z.object({ id: z.string().max(64), from: z.string().max(64), to: z.string().max(64) })).max(2000),
  messages: z.array(z.record(z.string(), z.unknown())).max(300).default([]),
  viewport: z.object({ x: z.number().finite(), y: z.number().finite(), k: z.number().min(0.1).max(4) }).optional(),
});
export type CanvasDoc = z.infer<typeof DocSchema>;

interface CanvasRow {
  id: string;
  project_id: string;
  user_id: string;
  name: string;
  doc: CanvasDoc;
  version: number;
  updated_at: Date;
}

export interface CanvasNodeView extends z.infer<typeof NodeSchema> {
  outputs?: OutputDTO[];
}

const emptyDoc = (): CanvasDoc => ({ nodes: [], edges: [], messages: [] });

/**
 * 项目与画布：画布文档整体保存，PUT 时必须带上读取到的版本号，版本不一致返回 409，
 * 避免两个窗口互相覆盖。节点只保存 taskId，读取时按任务状态与资产补全产物（签名地址不落库）。
 */
@Injectable()
export class CanvasesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly assets: AssetsService,
  ) {}

  async listProjects(userId: string) {
    const projects = await this.db.query<{ id: string; name: string; updated_at: Date; created_at: Date }>(
      'SELECT id, name, created_at, updated_at FROM projects WHERE user_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100',
      [userId],
    );
    const canvases = projects.length
      ? await this.db.query<{ id: string; project_id: string; name: string; updated_at: Date; node_count: number }>(
          `SELECT id, project_id, name, updated_at, jsonb_array_length(doc->'nodes')::int AS node_count FROM canvases WHERE project_id = ANY($1::text[]) ORDER BY updated_at DESC`,
          [projects.map((p) => p.id)],
        )
      : [];
    return {
      data: projects.map((p) => ({
        id: p.id,
        name: p.name,
        created_at: new Date(p.created_at).toISOString(),
        updated_at: new Date(p.updated_at).toISOString(),
        canvases: canvases.filter((c) => c.project_id === p.id).map((c) => ({ id: c.id, name: c.name, node_count: c.node_count, updated_at: new Date(c.updated_at).toISOString() })),
      })),
    };
  }

  /** 新建项目并附带一个画布（可传入初始文档，如模板或 Agent 计划） */
  async createProject(userId: string, name: string, rawDoc?: unknown) {
    const doc = rawDoc === undefined ? emptyDoc() : this.validDoc(rawDoc);
    const projectId = newId('prj');
    const canvasId = newId('cvs');
    await this.db.tx(async (q) => {
      await q.query('INSERT INTO projects (id, user_id, name) VALUES ($1, $2, $3)', [projectId, userId, name]);
      await q.query('INSERT INTO canvases (id, project_id, user_id, name, doc) VALUES ($1, $2, $3, $4, $5)', [canvasId, projectId, userId, name, JSON.stringify(doc)]);
    });
    return this.get(userId, canvasId);
  }

  async renameProject(userId: string, id: string, name: string) {
    const r = await this.db.query('UPDATE projects SET name = $3, updated_at = now() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id', [id, userId, name]);
    if (!r.length) throw Errors.notFound('项目');
  }

  async deleteProject(userId: string, id: string) {
    const r = await this.db.query('UPDATE projects SET deleted_at = now() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id', [id, userId]);
    if (!r.length) throw Errors.notFound('项目');
  }

  /** 最近编辑的画布；没有任何画布时返回 null */
  async latest(userId: string) {
    const [r] = await this.db.query<{ id: string }>(
      `SELECT c.id FROM canvases c JOIN projects p ON p.id = c.project_id WHERE c.user_id = $1 AND p.deleted_at IS NULL ORDER BY c.updated_at DESC LIMIT 1`,
      [userId],
    );
    return r ? this.get(userId, r.id) : null;
  }

  async get(userId: string, id: string) {
    const c = await this.row(userId, id);
    return { id: c.id, project_id: c.project_id, name: c.name, version: c.version, updated_at: new Date(c.updated_at).toISOString(), doc: { ...c.doc, nodes: await this.enrich(userId, c.doc.nodes) } };
  }

  /** 保存画布：版本号不一致时返回 409，客户端应重新读取后合并 */
  async save(userId: string, id: string, body: { doc: unknown; version: number; name?: string }) {
    const doc = this.validDoc(body.doc);
    const current = await this.row(userId, id);
    const rows = await this.db.query<{ version: number; updated_at: Date }>(
      `UPDATE canvases SET doc = $3, version = version + 1, name = COALESCE($5, name), updated_at = now()
       WHERE id = $1 AND user_id = $2 AND version = $4 RETURNING version, updated_at`,
      [id, userId, JSON.stringify(doc), body.version, body.name ?? null],
    );
    if (!rows.length) {
      const [latest] = await this.db.query<{ version: number }>('SELECT version FROM canvases WHERE id = $1', [id]);
      throw new AppError('CANVAS_VERSION_CONFLICT', 409, '画布已在其他窗口修改，请刷新后再保存', { current_version: latest?.version ?? current.version });
    }
    await this.db.query('UPDATE projects SET updated_at = now(), name = CASE WHEN $3::text IS NULL THEN name ELSE $3 END WHERE id = $1 AND user_id = $2', [current.project_id, userId, body.name ?? null]);
    return { version: rows[0].version, updated_at: new Date(rows[0].updated_at).toISOString() };
  }

  private validDoc(raw: unknown): CanvasDoc {
    const doc = parse(DocSchema, raw);
    if (Buffer.byteLength(JSON.stringify(doc)) > MAX_DOC_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', 413, '画布内容过大，请拆分到多个画布');
    const ids = new Set(doc.nodes.map((n) => n.id));
    if (ids.size !== doc.nodes.length) throw Errors.invalid('画布中存在重复的节点 ID');
    if (doc.edges.some((e) => !ids.has(e.from) || !ids.has(e.to))) throw Errors.invalid('连线指向了不存在的节点');
    return doc;
  }

  private async row(userId: string, id: string): Promise<CanvasRow> {
    const [c] = await this.db.query<CanvasRow>(
      'SELECT c.* FROM canvases c JOIN projects p ON p.id = c.project_id WHERE c.id = $1 AND c.user_id = $2 AND p.deleted_at IS NULL',
      [id, userId],
    );
    if (!c) throw Errors.notFound('画布');
    return c;
  }

  /** 按节点关联的任务补全状态与产物；修改过的节点展示上一次运行的产物 */
  private async enrich(userId: string, nodes: CanvasDoc['nodes']): Promise<CanvasNodeView[]> {
    const taskIds = [...new Set(nodes.flatMap((n) => [n.taskId, n.prevTaskId]).filter((x): x is string => !!x))];
    if (!taskIds.length) return nodes;
    const tasks = await this.db.query<{ id: string; status: TaskStatus }>('SELECT id, status FROM generation_tasks WHERE id = ANY($1::text[]) AND user_id = $2', [taskIds, userId]);
    const status = new Map(tasks.map((t) => [t.id, t.status === 'post_processing' ? 'running' : t.status]));
    const outputs = await this.assets.outputsFor(tasks.filter((t) => t.status === 'succeeded').map((t) => t.id));
    return nodes.map((n) => {
      if (n.taskId && status.has(n.taskId)) return { ...n, status: status.get(n.taskId)!, outputs: outputs.get(n.taskId) ?? [] };
      if (n.prevTaskId && outputs.has(n.prevTaskId)) return { ...n, outputs: outputs.get(n.prevTaskId) };
      return n;
    });
  }
}
