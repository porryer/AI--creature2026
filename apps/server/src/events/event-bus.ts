import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { ServerEvent, TaskDTO, TaskStatus } from '@creature/shared';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Observable } from 'rxjs';
import { AppConfig, CONFIG } from '../config';
import { Db, DB } from '../db/db';

type TaskEventType = 'task.progress' | 'task.succeeded' | 'task.failed';

/** 跨实例消息：任务内容放得下时随通知发送，否则只传引用（通知有 8000 字节上限），由收到的实例重新读取 */
type Remote =
  | { o: string; k: 'task'; u: string; t: TaskEventType; id: string; task?: TaskDTO }
  | { o: string; k: 'credits'; u: string; c: Extract<ServerEvent, { type: 'credits.changed' }>['credits'] }
  | { o: string; k: 'ctl'; n: string; d: Record<string, unknown> };

/** 同一任务在同一状态内的进度更新跨实例广播的最小间隔；状态变化与完成 / 失败事件总是广播 */
const PROGRESS_THROTTLE_MS = 1500;
/** 随通知发送任务内容的上限（字节），留出余量 */
const INLINE_MAX_BYTES = 7000;

/**
 * 事件总线：按用户分发任务进度与积分变化，并承载少量控制消息（如账号状态变更）。
 * - 本实例的推送连接直接收到事件；
 * - 使用 PostgreSQL 时同时通过 LISTEN / NOTIFY 广播给其他实例，因此 Worker 与用户的推送连接可以在不同实例上：
 *   任务内容随通知发送，放不下时只发引用，由持有该用户推送连接的实例重新读取；其他实例直接丢弃；
 * - 使用内嵌 PGlite（单进程）时只在本实例分发。
 */
@Injectable()
export class EventBus implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('EventBus');
  private readonly emitter = new EventEmitter();
  /** 本实例标识：忽略自己发出的通知 */
  readonly instanceId = randomBytes(6).toString('hex');
  private unlisten?: () => Promise<void>;
  private taskLoader?: (userId: string, taskId: string) => Promise<TaskDTO | null>;
  private readonly controls = new Map<string, (data: Record<string, unknown>) => void>();
  private readonly lastProgress = new Map<string, { at: number; status: TaskStatus }>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {
    this.emitter.setMaxListeners(0);
  }

  /** 是否与其他实例互通（真实 PostgreSQL） */
  get fanout(): boolean {
    return !!this.db.listen && !!this.db.notify;
  }

  async onApplicationBootstrap() {
    if (!this.db.listen) return;
    this.unlisten = await this.db.listen(
      this.config.eventsChannel,
      (payload) => void this.onRemote(payload),
      () => this.resync(),
    );
  }

  async onApplicationShutdown() {
    await this.unlisten?.();
  }

  /** 由生成任务模块注册：其他实例广播任务事件时，用它读取最新的任务 */
  setTaskLoader(fn: (userId: string, taskId: string) => Promise<TaskDTO | null>) {
    this.taskLoader = fn;
  }

  /** 注册控制消息处理（只处理其他实例发来的，本实例自行处理） */
  onControl(name: string, fn: (data: Record<string, unknown>) => void) {
    this.controls.set(name, fn);
  }

  emit(userId: string, event: ServerEvent) {
    this.emitter.emit(userId, event);
    if (event.type === 'credits.changed') this.broadcast({ o: this.instanceId, k: 'credits', u: userId, c: event.credits });
    else if (event.type !== 'sync') this.broadcastTask(userId, event.type, event.task, event.task);
  }

  /** 只通知其他实例；不带任务内容时（如本实例没有该用户的推送连接，省去读取任务）由收到的实例读取 */
  broadcastTask(userId: string, type: TaskEventType, at: { id: string; status: TaskStatus }, task?: TaskDTO) {
    if (!this.fanout) return;
    if (type === 'task.progress') {
      const now = Date.now();
      const last = this.lastProgress.get(at.id);
      if (last && last.status === at.status && now - last.at < PROGRESS_THROTTLE_MS) return;
      if (this.lastProgress.size > 10_000) this.lastProgress.clear();
      this.lastProgress.set(at.id, { at: now, status: at.status });
    } else {
      this.lastProgress.delete(at.id);
    }
    const ref: Remote = { o: this.instanceId, k: 'task', u: userId, t: type, id: at.id };
    if (task) {
      const inline = JSON.stringify({ ...ref, task });
      if (Buffer.byteLength(inline) <= INLINE_MAX_BYTES) return this.send(inline);
    }
    this.broadcast(ref);
  }

  control(name: string, data: Record<string, unknown>) {
    this.broadcast({ o: this.instanceId, k: 'ctl', n: name, d: data });
  }

  stream(userId: string): Observable<ServerEvent> {
    return new Observable<ServerEvent>((sub) => {
      const fn = (e: ServerEvent) => sub.next(e);
      this.emitter.on(userId, fn);
      return () => this.emitter.off(userId, fn);
    });
  }

  listenerCount(userId: string) {
    return this.emitter.listenerCount(userId);
  }

  /** 监听连接重连后，断开期间其他实例的通知已丢失：提示本实例的所有推送连接重新拉取 */
  private resync() {
    const users = this.emitter.eventNames();
    this.logger.warn(`事件监听已重连，通知本实例 ${users.length} 个用户的推送连接重新同步`);
    for (const u of users) this.emitter.emit(u, { type: 'sync' } satisfies ServerEvent);
  }

  private broadcast(msg: Remote) {
    if (this.fanout) this.send(JSON.stringify(msg));
  }

  private send(payload: string) {
    this.db.notify!(this.config.eventsChannel, payload).catch((e) => this.logger.warn(`广播事件失败：${e instanceof Error ? e.message : String(e)}`));
  }

  private async onRemote(payload: string) {
    let msg: Remote;
    try {
      msg = JSON.parse(payload) as Remote;
    } catch {
      return;
    }
    if (msg.o === this.instanceId) return;
    if (msg.k === 'ctl') return this.controls.get(msg.n)?.(msg.d);
    if (!this.listenerCount(msg.u)) return;
    if (msg.k === 'credits') return void this.emitter.emit(msg.u, { type: 'credits.changed', credits: msg.c });
    try {
      const task = msg.task ?? (await this.taskLoader?.(msg.u, msg.id));
      if (task) this.emitter.emit(msg.u, { type: msg.t, task });
    } catch (e) {
      this.logger.warn(`读取任务 ${msg.id} 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
