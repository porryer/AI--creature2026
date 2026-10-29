// 角色库与品牌套件（docs/02-prd.md 4.7）：类型、限额，以及生成时把角色与品牌约束注入提示词

import type { PlanCode } from './plans';
import type { Modality } from './types';

export type CharacterView = 'front' | 'side' | 'back' | 'full_body' | 'expression';
export const CHARACTER_VIEWS: Record<CharacterView, string> = { front: '正面', side: '侧面', back: '背面', full_body: '全身', expression: '表情' };

/** 肖像声明：none 虚构角色 / 品牌 IP；self 本人肖像；authorized 他人肖像，需上传授权材料 */
export type Likeness = 'none' | 'self' | 'authorized';
export const LIKENESS_LABEL: Record<Likeness, string> = { none: '虚构角色 / 品牌 IP', self: '本人肖像', authorized: '已获授权的他人肖像' };

export interface CharacterRefDTO {
  asset_id: string;
  url: string;
  view: CharacterView | null;
  width?: number;
  height?: number;
}

export interface CharacterDTO {
  id: string;
  name: string;
  description: string;
  likeness: Likeness;
  refs: CharacterRefDTO[];
  used_count: number;
  created_at: string;
  updated_at: string;
}

export type LogoVariant = 'primary' | 'light' | 'dark' | 'mono';
export const LOGO_VARIANTS: Record<LogoVariant, string> = { primary: '主 Logo', light: '浅色版', dark: '深色版', mono: '单色版' };

export interface BrandColor {
  name: string;
  hex: string;
}

export interface BrandKitDTO {
  id: string;
  name: string;
  tone: string;
  colors: BrandColor[];
  fonts: string[];
  banned: string[];
  logos: { asset_id: string; url: string; variant: LogoVariant }[];
  used_count: number;
  created_at: string;
  updated_at: string;
}

export const LIBRARY_LIMITS = {
  characterRefs: { min: 3, max: 8 },
  /** 一次生成最多引用的角色数 */
  charactersPerGeneration: 2,
  /** 每个角色随生成请求传给模型的参考图数（按正面、全身、侧面……的顺序挑选） */
  refsPerCharacter: 3,
  brandColors: 8,
  brandFonts: 4,
  brandBanned: 12,
  brandLogos: 3,
};

/** 各套餐可建的角色与品牌套件数；0 表示该套餐不提供（角色库与品牌套件是专业版、团队版功能） */
export const LIBRARY_QUOTA: Record<PlanCode, { characters: number; brandKits: number }> = {
  free: { characters: 0, brandKits: 0 },
  basic: { characters: 0, brandKits: 0 },
  pro: { characters: 20, brandKits: 5 },
  team: { characters: 50, brandKits: 20 },
};

/** 哪些模态可以引用角色 / 品牌套件 */
export const CONTEXT_MODALITIES = { characters: ['image', 'video'] as Modality[], brand: ['image', 'video', 'text'] as Modality[] };

/** 生成请求中的引用 */
export interface GenerationContextInput {
  character_ids?: string[];
  brand_kit_id?: string | null;
  /** 在画面中放置品牌 Logo（仅图像，品牌套件需有 Logo） */
  place_logo?: boolean;
}

/** 任务创建时保存的快照：之后修改或删除角色、品牌套件不影响已提交的任务 */
export interface ContextSnapshot {
  characters: { id: string; name: string; description: string; ref_asset_ids: string[] }[];
  brand_kit: { id: string; name: string; tone: string; colors: BrandColor[]; fonts: string[]; banned: string[]; logo_asset_id: string | null } | null;
  place_logo: boolean;
}

/** 任务中展示的引用摘要 */
export interface TaskContextDTO {
  characters: { id: string; name: string }[];
  brand_kit: { id: string; name: string } | null;
  place_logo: boolean;
}

export const contextSummary = (s: ContextSnapshot | null): TaskContextDTO | null =>
  s ? { characters: s.characters.map((c) => ({ id: c.id, name: c.name })), brand_kit: s.brand_kit ? { id: s.brand_kit.id, name: s.brand_kit.name } : null, place_logo: s.place_logo } : null;

/**
 * 发给模型的提示词：在用户提示词之后附加角色设定与品牌规范。任务记录与界面展示的仍是用户原始提示词。
 */
export function composePrompt(prompt: string, modality: Modality, ctx: ContextSnapshot | null): string {
  if (!ctx || (!ctx.characters.length && !ctx.brand_kit)) return prompt;
  const lines = [prompt];
  if (ctx.characters.length) {
    lines.push(`【角色】${ctx.characters.map((c) => (c.description ? `${c.name}：${c.description}` : c.name)).join('；')}（外观与对应的角色参考图保持一致）`);
  }
  const b = ctx.brand_kit;
  if (b) {
    const rules = [`品牌「${b.name}」`];
    if (b.tone) rules.push(`调性：${b.tone}`);
    if (modality !== 'text' && b.colors.length) rules.push(`主色调使用标准色 ${b.colors.map((c) => `${c.name} ${c.hex}`).join('、')}`);
    if (modality === 'image' && b.fonts.length) rules.push(`画面中的文字使用 ${b.fonts.join('、')}`);
    if (b.banned.length) rules.push(`${modality === 'text' ? '文中不要出现' : '画面中不要出现'}：${b.banned.join('、')}`);
    // 右下角留给法定的"AI 生成"显式标识
    if (ctx.place_logo && b.logo_asset_id) rules.push('在画面右上角放置品牌 Logo（见 Logo 参考图），不改变 Logo 的形状与颜色');
    lines.push(`【品牌规范】${rules.join('；')}`);
  }
  return lines.join('\n');
}
