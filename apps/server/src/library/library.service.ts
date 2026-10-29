import { Inject, Injectable } from '@nestjs/common';
import {
  CONTEXT_MODALITIES,
  LIBRARY_LIMITS,
  LIBRARY_QUOTA,
  type BrandColor,
  type BrandKitDTO,
  type CharacterDTO,
  type CharacterView,
  type ContextSnapshot,
  type GenerationContextInput,
  type Likeness,
  type LogoVariant,
  type Modality,
  type PlanCode,
} from '@creature/shared';
import { AppError, Errors } from '../common/errors';
import { newId } from '../common/ids';
import { Db, DB, type Queryable } from '../db/db';
import { ModerationService } from '../safety/moderation.service';
import { StorageService } from '../storage/storage.service';

export interface CharacterInput {
  name: string;
  description: string;
  likeness: Likeness;
  consent_asset_id?: string | null;
  refs: { asset_id: string; view?: CharacterView | null }[];
}

export interface BrandKitInput {
  name: string;
  tone: string;
  colors: BrandColor[];
  fonts: string[];
  banned: string[];
  logos: { asset_id: string; variant: LogoVariant }[];
}

interface CharacterRow {
  id: string;
  name: string;
  description: string;
  likeness: Likeness;
  consent_asset_id: string | null;
  used_count: number;
  created_at: Date;
  updated_at: Date;
}

interface RefRow {
  character_id: string;
  position: number;
  asset_id: string;
  view: CharacterView | null;
  storage_key: string;
  width: number | null;
  height: number | null;
}

interface BrandRow {
  id: string;
  name: string;
  tone: string;
  colors: BrandColor[];
  fonts: string[];
  banned: string[];
  logos: { asset_id: string; variant: LogoVariant }[];
  used_count: number;
  created_at: Date;
  updated_at: Date;
}

const PLAN_MESSAGE = '角色库与品牌套件是专业版功能，升级套餐后即可使用';
/** 生成时挑选角色参考图的视角优先级 */
const VIEW_ORDER: (CharacterView | null)[] = ['front', 'full_body', 'side', 'expression', 'back', null];
const iso = (d: Date) => new Date(d).toISOString();

/**
 * 角色库与品牌套件（专业版、团队版）：参考图与 Logo 都引用用户自己的图像资产；
 * 名称、描述、调性等文字过审；生成时由 snapshot() 生成快照随任务保存。
 */
@Injectable()
export class LibraryService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly moderation: ModerationService,
  ) {}

  /** 当前有效套餐的配额；套餐过期按免费版 */
  async quota(userId: string, q: Queryable = this.db) {
    const [u] = await q.query<{ plan_code: PlanCode; plan_expires_at: Date | null }>('SELECT plan_code, plan_expires_at FROM users WHERE id = $1', [userId]);
    const active = u && (!u.plan_expires_at || new Date(u.plan_expires_at).getTime() > Date.now());
    return LIBRARY_QUOTA[active ? u.plan_code : 'free'] ?? LIBRARY_QUOTA.free;
  }

  // ---------- 角色 ----------

  async listCharacters(userId: string): Promise<{ data: CharacterDTO[]; quota: { used: number; limit: number } }> {
    const rows = await this.db.query<CharacterRow>('SELECT * FROM characters WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC', [userId]);
    const refs = await this.refsOf(rows.map((r) => r.id));
    return { data: rows.map((r) => this.characterDTO(r, refs.get(r.id) ?? [])), quota: { used: rows.length, limit: (await this.quota(userId)).characters } };
  }

  async getCharacter(userId: string, id: string): Promise<CharacterDTO> {
    const r = await this.characterRow(userId, id);
    return this.characterDTO(r, (await this.refsOf([id])).get(id) ?? []);
  }

  async createCharacter(userId: string, b: CharacterInput): Promise<CharacterDTO> {
    await this.requirePlan(userId);
    await this.checkCharacter(userId, b);
    const id = newId('chr');
    await this.db.tx(async (q) => {
      // 锁住用户行，避免并发创建超出配额
      await q.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
      const [{ n }] = await q.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM characters WHERE user_id = $1 AND deleted_at IS NULL', [userId]);
      const limit = (await this.quota(userId, q)).characters;
      if (n >= limit) throw Errors.conflict('LIBRARY_LIMIT', `角色数量已达上限（${limit} 个）`);
      await q.query('INSERT INTO characters (id, user_id, name, description, likeness, consent_asset_id) VALUES ($1, $2, $3, $4, $5, $6)', [
        id,
        userId,
        b.name,
        b.description,
        b.likeness,
        b.likeness === 'authorized' ? b.consent_asset_id : null,
      ]);
      await this.writeRefs(q, id, b.refs);
    });
    return this.getCharacter(userId, id);
  }

  async updateCharacter(userId: string, id: string, patch: Partial<CharacterInput>): Promise<CharacterDTO> {
    await this.requirePlan(userId);
    const cur = await this.getCharacter(userId, id);
    const next: CharacterInput = {
      name: patch.name ?? cur.name,
      description: patch.description ?? cur.description,
      likeness: patch.likeness ?? cur.likeness,
      consent_asset_id: patch.consent_asset_id !== undefined ? patch.consent_asset_id : (await this.characterRow(userId, id)).consent_asset_id,
      refs: patch.refs ?? cur.refs.map((r) => ({ asset_id: r.asset_id, view: r.view })),
    };
    await this.checkCharacter(userId, next);
    await this.db.tx(async (q) => {
      await q.query('UPDATE characters SET name = $3, description = $4, likeness = $5, consent_asset_id = $6, updated_at = now() WHERE id = $1 AND user_id = $2', [
        id,
        userId,
        next.name,
        next.description,
        next.likeness,
        next.likeness === 'authorized' ? next.consent_asset_id : null,
      ]);
      if (patch.refs) {
        await q.query('DELETE FROM character_refs WHERE character_id = $1', [id]);
        await this.writeRefs(q, id, next.refs);
      }
    });
    return this.getCharacter(userId, id);
  }

  /** 删除角色（软删除）；已提交的任务保留当时的快照 */
  async removeCharacter(userId: string, id: string): Promise<void> {
    await this.characterRow(userId, id);
    await this.db.query('UPDATE characters SET deleted_at = now() WHERE id = $1 AND user_id = $2', [id, userId]);
  }

  // ---------- 品牌套件 ----------

  async listBrandKits(userId: string): Promise<{ data: BrandKitDTO[]; quota: { used: number; limit: number } }> {
    const rows = await this.db.query<BrandRow>('SELECT * FROM brand_kits WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC', [userId]);
    const logos = await this.liveImages(rows.flatMap((r) => r.logos.map((l) => l.asset_id)));
    return { data: rows.map((r) => this.brandDTO(r, logos)), quota: { used: rows.length, limit: (await this.quota(userId)).brandKits } };
  }

  async getBrandKit(userId: string, id: string): Promise<BrandKitDTO> {
    const r = await this.brandRow(userId, id);
    return this.brandDTO(r, await this.liveImages(r.logos.map((l) => l.asset_id)));
  }

  async createBrandKit(userId: string, b: BrandKitInput): Promise<BrandKitDTO> {
    await this.requirePlan(userId);
    const kit = await this.checkBrand(userId, b);
    const id = newId('bk');
    await this.db.tx(async (q) => {
      await q.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
      const [{ n }] = await q.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM brand_kits WHERE user_id = $1 AND deleted_at IS NULL', [userId]);
      const limit = (await this.quota(userId, q)).brandKits;
      if (n >= limit) throw Errors.conflict('LIBRARY_LIMIT', `品牌套件数量已达上限（${limit} 个）`);
      await q.query('INSERT INTO brand_kits (id, user_id, name, tone, colors, fonts, banned, logos) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
        id,
        userId,
        kit.name,
        kit.tone,
        JSON.stringify(kit.colors),
        JSON.stringify(kit.fonts),
        JSON.stringify(kit.banned),
        JSON.stringify(kit.logos),
      ]);
    });
    return this.getBrandKit(userId, id);
  }

  async updateBrandKit(userId: string, id: string, patch: Partial<BrandKitInput>): Promise<BrandKitDTO> {
    await this.requirePlan(userId);
    const cur = await this.brandRow(userId, id);
    const kit = await this.checkBrand(userId, {
      name: patch.name ?? cur.name,
      tone: patch.tone ?? cur.tone,
      colors: patch.colors ?? cur.colors,
      fonts: patch.fonts ?? cur.fonts,
      banned: patch.banned ?? cur.banned,
      logos: patch.logos ?? cur.logos,
    });
    await this.db.query('UPDATE brand_kits SET name = $3, tone = $4, colors = $5, fonts = $6, banned = $7, logos = $8, updated_at = now() WHERE id = $1 AND user_id = $2', [
      id,
      userId,
      kit.name,
      kit.tone,
      JSON.stringify(kit.colors),
      JSON.stringify(kit.fonts),
      JSON.stringify(kit.banned),
      JSON.stringify(kit.logos),
    ]);
    return this.getBrandKit(userId, id);
  }

  async removeBrandKit(userId: string, id: string): Promise<void> {
    await this.brandRow(userId, id);
    await this.db.query('UPDATE brand_kits SET deleted_at = now() WHERE id = $1 AND user_id = $2', [id, userId]);
  }

  // ---------- 生成时引用 ----------

  /** 生成任务引用角色 / 品牌套件时的快照；没有引用返回 null。校验失败抛出 400，不冻结积分 */
  async snapshot(userId: string, modality: Modality, ctx: GenerationContextInput | undefined): Promise<ContextSnapshot | null> {
    const ids = [...new Set(ctx?.character_ids ?? [])];
    const brandId = ctx?.brand_kit_id ?? null;
    if (!ids.length && !brandId) {
      if (ctx?.place_logo) throw Errors.invalid('放置 Logo 需要同时选择品牌套件');
      return null;
    }
    if (!(await this.quota(userId)).characters) throw Errors.planRequired(PLAN_MESSAGE, 'pro');
    if (ids.length > LIBRARY_LIMITS.charactersPerGeneration) throw Errors.invalid(`一次最多引用 ${LIBRARY_LIMITS.charactersPerGeneration} 个角色`);
    if (ids.length && !CONTEXT_MODALITIES.characters.includes(modality)) throw Errors.invalid('只有图像与视频可以引用角色');
    if (brandId && !CONTEXT_MODALITIES.brand.includes(modality)) throw Errors.invalid('该创作类型不支持品牌套件');

    const characters: ContextSnapshot['characters'] = [];
    if (ids.length) {
      const rows = await this.db.query<CharacterRow>('SELECT * FROM characters WHERE id = ANY($1::text[]) AND user_id = $2 AND deleted_at IS NULL', [ids, userId]);
      const refs = await this.refsOf(ids);
      for (const id of ids) {
        const c = rows.find((r) => r.id === id);
        if (!c) throw Errors.invalid('引用的角色不存在');
        const picked = [...(refs.get(id) ?? [])]
          .sort((a, b) => VIEW_ORDER.indexOf(a.view) - VIEW_ORDER.indexOf(b.view) || a.position - b.position)
          .slice(0, LIBRARY_LIMITS.refsPerCharacter);
        if (!picked.length) throw Errors.invalid(`角色「${c.name}」的参考图已全部删除，请先编辑角色`);
        characters.push({ id: c.id, name: c.name, description: c.description, ref_asset_ids: picked.map((r) => r.asset_id) });
      }
    }

    let brand: ContextSnapshot['brand_kit'] = null;
    if (brandId) {
      const b = await this.brandRow(userId, brandId).catch(() => {
        throw Errors.invalid('引用的品牌套件不存在');
      });
      const live = await this.liveImages(b.logos.map((l) => l.asset_id));
      const logo = [...b.logos].sort((x, y) => Number(y.variant === 'primary') - Number(x.variant === 'primary')).find((l) => live.has(l.asset_id));
      brand = { id: b.id, name: b.name, tone: b.tone, colors: b.colors, fonts: b.fonts, banned: b.banned, logo_asset_id: logo?.asset_id ?? null };
    }
    const placeLogo = !!ctx?.place_logo;
    if (placeLogo && modality !== 'image') throw Errors.invalid('只有图像可以放置 Logo');
    if (placeLogo && !brand?.logo_asset_id) throw Errors.invalid('品牌套件还没有 Logo，无法放置');
    return { characters, brand_kit: brand, place_logo: placeLogo };
  }

  /** 引用次数（与任务创建在同一事务中） */
  async markUsed(q: Queryable, s: ContextSnapshot) {
    if (s.characters.length) await q.query('UPDATE characters SET used_count = used_count + 1 WHERE id = ANY($1::text[])', [s.characters.map((c) => c.id)]);
    if (s.brand_kit) await q.query('UPDATE brand_kits SET used_count = used_count + 1 WHERE id = $1', [s.brand_kit.id]);
  }

  // ---------- 内部 ----------

  private async requirePlan(userId: string) {
    if (!(await this.quota(userId)).characters) throw Errors.planRequired(PLAN_MESSAGE, 'pro');
  }

  private async checkCharacter(userId: string, b: CharacterInput) {
    const { min, max } = LIBRARY_LIMITS.characterRefs;
    const ids = b.refs.map((r) => r.asset_id);
    if (new Set(ids).size !== ids.length) throw Errors.invalid('参考图不能重复');
    if (ids.length < min || ids.length > max) throw Errors.invalid(`角色需要 ${min}–${max} 张参考图`);
    if ((await this.ownImages(userId, ids)).size !== ids.length) throw Errors.invalid('参考图不存在或不是图像');
    if (b.likeness === 'authorized') {
      if (!b.consent_asset_id) throw Errors.invalid('使用他人肖像需要上传肖像授权材料');
      if (!(await this.ownImages(userId, [b.consent_asset_id], true)).size) throw Errors.invalid('肖像授权材料需要是你上传的图片');
    }
    await this.checkText(userId, 'character', [b.name, b.description]);
  }

  private async checkBrand(userId: string, b: BrandKitInput): Promise<BrandKitInput> {
    const variants = b.logos.map((l) => l.variant);
    if (new Set(variants).size !== variants.length) throw Errors.invalid('每种 Logo 版本只能有一个');
    const logoIds = b.logos.map((l) => l.asset_id);
    if ((await this.ownImages(userId, logoIds)).size !== new Set(logoIds).size) throw Errors.invalid('Logo 不存在或不是图像');
    await this.checkText(userId, 'brand_kit', [b.name, b.tone, ...b.colors.map((c) => c.name), ...b.fonts, ...b.banned]);
    return { ...b, colors: b.colors.map((c) => ({ name: c.name, hex: c.hex.toUpperCase() })) };
  }

  private async checkText(userId: string, targetType: 'character' | 'brand_kit', parts: string[]) {
    const verdict = this.moderation.checkText(parts.join('\n'));
    if (verdict.verdict !== 'block') return;
    await this.moderation.record({ userId, targetType, targetId: null, result: verdict });
    throw new AppError('CONTENT_REJECTED', 422, '内容可能违反社区规范，请修改后再保存', { reason_code: verdict.labels[0] ?? 'policy' });
  }

  /** 用户自己未删除的图像资产；uploadedOnly 时只算本人上传的 */
  private async ownImages(userId: string, ids: string[], uploadedOnly = false): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM assets WHERE id = ANY($1::text[]) AND user_id = $2 AND kind = 'image' AND deleted_at IS NULL AND ($3::boolean = false OR source = 'uploaded')`,
      [ids, userId, uploadedOnly],
    );
    return new Set(rows.map((r) => r.id));
  }

  /** 未删除的图像资产及其访问信息 */
  private async liveImages(ids: string[]): Promise<Map<string, { storage_key: string }>> {
    if (!ids.length) return new Map();
    const rows = await this.db.query<{ id: string; storage_key: string }>(`SELECT id, storage_key FROM assets WHERE id = ANY($1::text[]) AND deleted_at IS NULL`, [ids]);
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async writeRefs(q: Queryable, characterId: string, refs: CharacterInput['refs']) {
    for (const [i, r] of refs.entries()) {
      await q.query('INSERT INTO character_refs (character_id, position, asset_id, view) VALUES ($1, $2, $3, $4)', [characterId, i, r.asset_id, r.view ?? null]);
    }
  }

  /** 角色的参考图（跳过已删除的资产） */
  private async refsOf(ids: string[]): Promise<Map<string, RefRow[]>> {
    const out = new Map<string, RefRow[]>();
    if (!ids.length) return out;
    const rows = await this.db.query<RefRow>(
      `SELECT r.character_id, r.position, r.asset_id, r.view, a.storage_key, a.width, a.height
         FROM character_refs r JOIN assets a ON a.id = r.asset_id AND a.deleted_at IS NULL
        WHERE r.character_id = ANY($1::text[]) ORDER BY r.position`,
      [ids],
    );
    for (const r of rows) out.set(r.character_id, [...(out.get(r.character_id) ?? []), r]);
    return out;
  }

  private async characterRow(userId: string, id: string): Promise<CharacterRow> {
    const [r] = await this.db.query<CharacterRow>('SELECT * FROM characters WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [id, userId]);
    if (!r) throw Errors.notFound('角色');
    return r;
  }

  private async brandRow(userId: string, id: string): Promise<BrandRow> {
    const [r] = await this.db.query<BrandRow>('SELECT * FROM brand_kits WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [id, userId]);
    if (!r) throw Errors.notFound('品牌套件');
    return r;
  }

  private characterDTO(r: CharacterRow, refs: RefRow[]): CharacterDTO {
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      likeness: r.likeness,
      refs: refs.map((x) => ({ asset_id: x.asset_id, url: this.storage.signedUrl(x.storage_key), view: x.view, width: x.width ?? undefined, height: x.height ?? undefined })),
      used_count: r.used_count,
      created_at: iso(r.created_at),
      updated_at: iso(r.updated_at),
    };
  }

  private brandDTO(r: BrandRow, live: Map<string, { storage_key: string }>): BrandKitDTO {
    return {
      id: r.id,
      name: r.name,
      tone: r.tone,
      colors: r.colors,
      fonts: r.fonts,
      banned: r.banned,
      logos: r.logos.flatMap((l) => {
        const a = live.get(l.asset_id);
        return a ? [{ asset_id: l.asset_id, url: this.storage.signedUrl(a.storage_key), variant: l.variant }] : [];
      }),
      used_count: r.used_count,
      created_at: iso(r.created_at),
      updated_at: iso(r.updated_at),
    };
  }
}
