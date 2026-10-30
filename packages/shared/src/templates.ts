// 官方模板（docs/02-prd.md 4.8）：单步模板替换关键词或上传图片即可生成；工作流模板在画布上展开为一组节点。
// 目录随代码发布，前后端共用：后端按同一份定义渲染提示词并创建任务，前端用它展示表单与预估积分。

import { estimateCredits, modelByCode, routeModel } from './models';
import type { GenerationParams, Modality, ReferenceRole, RoutingStrategy } from './types';

export type TemplateKind = 'single' | 'workflow';

export interface TemplateInputDef {
  key: string;
  label: string;
  /** text：替换提示词中的 {key}；image：用户的图像资产，作为参考图（role）随请求提交 */
  type: 'text' | 'image';
  required?: boolean;
  placeholder?: string;
  /** 示例值：用于示例图与输入框提示；可选的文字输入留空时使用 */
  example?: string;
  maxLength?: number;
  role?: ReferenceRole;
}

export interface TemplateStep {
  kind: Modality;
  title: string;
  credits: number;
}

export interface TemplateDef {
  id: string;
  kind: TemplateKind;
  title: string;
  desc: string;
  category: string;
  /** 示例图的生成种子 */
  cover: string;
  ratio: string;
  modality: Modality;
  /** 单步：提示词模板，{key} 由输入替换；工作流：示例主题（画布节点以它为前缀） */
  prompt: string;
  inputs: TemplateInputDef[];
  params: GenerationParams;
  strategy?: RoutingStrategy;
  /** 固定使用的模型（配音、配乐） */
  model?: string;
  /** 工作流的执行步骤（单步模板为空，积分按模型与参数计算） */
  steps: TemplateStep[];
}

export const TEMPLATE_CATEGORIES = ['全部', '电商', '自媒体', '设计', '头像', '广告', '漫剧', '文案', '音频'];
const TEXT_MAX = 40;

const single = (t: Omit<TemplateDef, 'kind' | 'steps'>): TemplateDef => ({ ...t, kind: 'single', steps: [] });
const img = (key: string, label: string, role: ReferenceRole): TemplateInputDef => ({ key, label, type: 'image', required: true, role });

export const TEMPLATE_CATALOG: TemplateDef[] = [
  // ---------- 图像 ----------
  single({
    id: 'scene-swap',
    title: '商品白底图换场景',
    desc: '上传白底商品图，生成 4 张生活化场景图，保持商品外观不变',
    category: '电商',
    cover: '产品 白底 耳机 极简',
    ratio: '1:1',
    modality: 'image',
    prompt: '把参考图中的商品放在{scene}中，保持商品外观、颜色与 Logo 不变，真实摄影质感，柔和自然光',
    inputs: [img('photo', '商品图', 'subject'), { key: 'scene', label: '场景', type: 'text', example: '温暖的木质桌面上，旁边有绿植和咖啡，窗边自然光' }],
    params: { ratio: '1:1', resolution: '2k', count: 4 },
  }),
  single({
    id: 'main-image',
    title: '电商白底主图',
    desc: '输入商品与卖点，生成平台规范的白底主图，右侧留出卖点文字',
    category: '电商',
    cover: '产品 白底 极简 科技',
    ratio: '1:1',
    modality: 'image',
    prompt: '{product}电商主图，纯白背景，产品居中，45 度视角，棚拍柔光，细节清晰，右侧排版文字「{selling}」',
    inputs: [
      { key: 'product', label: '商品', type: 'text', required: true, example: '无线降噪耳机' },
      { key: 'selling', label: '卖点', type: 'text', example: '续航 40 小时' },
    ],
    params: { ratio: '1:1', resolution: '2k', count: 4 },
  }),
  single({
    id: 'model-wear',
    title: '服装模特上身图',
    desc: '上传服装平铺图，生成模特上身效果，款式与图案保持不变',
    category: '电商',
    cover: '复古 胶片 旅行 人像',
    ratio: '3:4',
    modality: 'image',
    prompt: '模特上身展示参考图中的服装，{model}，{place}，保持服装款式、颜色与图案不变，时尚摄影',
    inputs: [
      img('garment', '服装图', 'subject'),
      { key: 'model', label: '模特', type: 'text', example: '25 岁亚洲女性，自然站姿' },
      { key: 'place', label: '场景', type: 'text', example: '城市街头，午后阳光' },
    ],
    params: { ratio: '3:4', resolution: '2k', count: 4 },
  }),
  single({
    id: 'food-photo',
    title: '美食摄影',
    desc: '输入菜品，生成杂志质感的美食大片',
    category: '电商',
    cover: '面包 清晨 暖 咖啡',
    ratio: '4:3',
    modality: 'image',
    prompt: '{dish}的美食摄影，{mood}，浅景深，微距细节，食欲感强，杂志质感',
    inputs: [
      { key: 'dish', label: '菜品', type: 'text', required: true, example: '枫糖拿铁与可颂' },
      { key: 'mood', label: '氛围', type: 'text', example: '清晨窗边，暖色逆光' },
    ],
    params: { ratio: '4:3', resolution: '2k', count: 4 },
  }),
  single({
    id: 'xhs-cover',
    title: '小红书封面',
    desc: '输入标题，生成标题醒目、留白干净的竖版封面',
    category: '自媒体',
    cover: '秋日 小红书 封面 咖啡',
    ratio: '3:4',
    modality: 'image',
    prompt: '小红书竖版封面，大标题文字「{title}」，{style}，构图干净，标题醒目，四周留白',
    inputs: [
      { key: 'title', label: '标题', type: 'text', required: true, example: '秋天的第一杯咖啡', maxLength: 20 },
      { key: 'style', label: '风格', type: 'text', example: '奶油色调，胶片质感' },
    ],
    params: { ratio: '3:4', resolution: '2k', count: 4 },
  }),
  single({
    id: 'festival-poster',
    title: '节日营销海报',
    desc: '输入品牌、节日与优惠，生成带中文标题的竖版海报',
    category: '设计',
    cover: '海报 节日 橙 活力',
    ratio: '3:4',
    modality: 'image',
    prompt: '{festival}营销海报，主标题文字「{brand} · {offer}」，节日氛围元素，中文排版清晰，竖版构图',
    inputs: [
      { key: 'brand', label: '品牌', type: 'text', required: true, example: '山野咖啡', maxLength: 12 },
      { key: 'festival', label: '节日', type: 'text', required: true, example: '中秋', maxLength: 10 },
      { key: 'offer', label: '优惠', type: 'text', example: '全场 8 折', maxLength: 16 },
    ],
    params: { ratio: '3:4', resolution: '2k', count: 4 },
  }),
  single({
    id: 'event-banner',
    title: '活动横幅',
    desc: '输入活动名称与时间，生成扁平插画风格的横版 Banner',
    category: '设计',
    cover: '柠檬 活力 运动 饮料',
    ratio: '16:9',
    modality: 'image',
    prompt: '活动宣传横幅，标题文字「{event}」，副标题「{date}」，扁平插画风格，明快配色，横版构图，文字区域清晰',
    inputs: [
      { key: 'event', label: '活动名称', type: 'text', required: true, example: '周末咖啡市集', maxLength: 16 },
      { key: 'date', label: '时间地点', type: 'text', example: '11 月 2 日 · 城南创意园', maxLength: 24 },
    ],
    params: { ratio: '16:9', resolution: '2k', count: 2 },
  }),
  single({
    id: 'recruit-poster',
    title: '招聘海报',
    desc: '输入公司与岗位，生成简洁现代的招聘海报',
    category: '设计',
    cover: '极简 科技 产品 白底',
    ratio: '3:4',
    modality: 'image',
    prompt: '招聘海报，大标题文字「{company} 招聘 {position}」，{perks}，简洁现代的版式，温暖友好的氛围，竖版',
    inputs: [
      { key: 'company', label: '公司', type: 'text', required: true, example: '山野咖啡', maxLength: 12 },
      { key: 'position', label: '岗位', type: 'text', required: true, example: '咖啡师', maxLength: 12 },
      { key: 'perks', label: '亮点', type: 'text', example: '五险一金，免费咖啡畅饮' },
    ],
    params: { ratio: '3:4', resolution: '2k', count: 2 },
  }),
  single({
    id: 'wallpaper',
    title: '手机壁纸',
    desc: '一句话主题，生成留出时钟区域的竖屏壁纸',
    category: '设计',
    cover: '霓虹 都市 夜 赛博',
    ratio: '9:16',
    modality: 'image',
    prompt: '{theme}，手机竖屏壁纸，高细节，氛围感强，画面上方留出时钟区域',
    inputs: [{ key: 'theme', label: '主题', type: 'text', required: true, example: '雨夜的城市霓虹' }],
    params: { ratio: '9:16', resolution: '2k', count: 4 },
  }),
  single({
    id: 'ink-avatar',
    title: '国风头像',
    desc: '上传照片，生成水墨国风头像，保留五官特征',
    category: '头像',
    cover: '水墨 国风 人像',
    ratio: '1:1',
    modality: 'image',
    prompt: '根据参考照片中人物的五官特征生成头像，{style}，半身像，正面',
    inputs: [img('photo', '本人照片', 'character'), { key: 'style', label: '风格', type: 'text', example: '水墨国风，古装，留白背景，朱砂点缀' }],
    params: { ratio: '1:1', resolution: '2k', count: 4 },
  }),
  single({
    id: 'anime-avatar',
    title: '动漫头像',
    desc: '上传照片，生成保留发型与五官特征的动漫头像',
    category: '头像',
    cover: '樱 粉 少女 动漫',
    ratio: '1:1',
    modality: 'image',
    prompt: '把参考照片中的人物画成{mood}动漫风格头像，保留发型与五官特征，干净背景',
    inputs: [img('photo', '本人照片', 'character'), { key: 'mood', label: '画风', type: 'text', example: '清新日系' }],
    params: { ratio: '1:1', resolution: '2k', count: 4 },
  }),
  single({
    id: 'storyboard-frame',
    title: '漫剧分镜画面',
    desc: '描述一个镜头，生成电影感的 16:9 分镜画面',
    category: '漫剧',
    cover: '动漫 樱花 少女 漫剧',
    ratio: '16:9',
    modality: 'image',
    prompt: '漫剧分镜画面：{scene}，{style}，宽画幅，构图有叙事感',
    inputs: [
      { key: 'scene', label: '镜头内容', type: 'text', required: true, example: '雨夜，少年站在便利店门口回头', maxLength: 60 },
      { key: 'style', label: '画风', type: 'text', example: '日系动漫，电影感光影' },
    ],
    params: { ratio: '16:9', resolution: '2k', count: 4 },
  }),
  // ---------- 视频 ----------
  single({
    id: 'photo-motion',
    title: '让照片动起来',
    desc: '上传一张照片，生成 5 秒的动态视频',
    category: '自媒体',
    cover: '海 蓝 夏 水',
    ratio: '9:16',
    modality: 'video',
    prompt: '{motion}，画面自然流畅，保持主体外观不变',
    inputs: [img('photo', '照片', 'first_frame'), { key: 'motion', label: '动态', type: 'text', example: '镜头缓慢推进，微风吹动头发与树叶' }],
    params: { ratio: '9:16', resolution: '720p', duration: 5 },
  }),
  single({
    id: 'product-spin',
    title: '商品 360° 展示',
    desc: '上传商品图，生成在展台上旋转的展示视频',
    category: '电商',
    cover: '产品 科技 耳机 极简',
    ratio: '1:1',
    modality: 'video',
    prompt: '{product}在展台上缓慢旋转 360 度，棚拍灯光，深色背景，光影掠过表面',
    inputs: [img('photo', '商品图', 'first_frame'), { key: 'product', label: '商品', type: 'text', example: '无线耳机' }],
    params: { ratio: '1:1', resolution: '720p', duration: 5 },
  }),
  single({
    id: 'logo-reveal',
    title: '品牌 Logo 动效',
    desc: '上传 Logo，生成 5 秒开场动效视频',
    category: '广告',
    cover: '极简 科技 产品',
    ratio: '16:9',
    modality: 'video',
    prompt: '{effect}，结尾定格在完整的 Logo',
    inputs: [img('logo', 'Logo', 'first_frame'), { key: 'effect', label: '动效', type: 'text', example: 'Logo 从粒子中汇聚成形，深色背景，光效扫过' }],
    params: { ratio: '16:9', resolution: '1080p', duration: 5 },
  }),
  // ---------- 写作 ----------
  single({
    id: 'xhs-note',
    title: '小红书种草笔记',
    desc: '输入商品与亮点，生成带标题、正文与话题标签的种草笔记',
    category: '文案',
    cover: '樱 粉 春 花',
    ratio: '3:4',
    modality: 'text',
    prompt: '为「{product}」写一篇小红书种草笔记，突出：{points}',
    inputs: [
      { key: 'product', label: '商品', type: 'text', required: true, example: '山野枫糖拿铁' },
      { key: 'points', label: '亮点', type: 'text', example: '真枫糖、燕麦奶、秋季限定' },
    ],
    params: { template: 'xhs', tone: '亲切', chars: 600 },
  }),
  single({
    id: 'live-script',
    title: '15 秒口播脚本',
    desc: '输入商品与人群，生成分镜头的 15 秒口播脚本',
    category: '文案',
    cover: '柠檬 饮料 活力 广告',
    ratio: '9:16',
    modality: 'text',
    prompt: '「{product}」15 秒短视频口播脚本，目标人群：{audience}',
    inputs: [
      { key: 'product', label: '商品', type: 'text', required: true, example: '柠檬气泡水' },
      { key: 'audience', label: '目标人群', type: 'text', example: '20–30 岁上班族' },
    ],
    params: { template: 'script', tone: '活泼', chars: 300 },
  }),
  single({
    id: 'ad-copy',
    title: '广告文案',
    desc: '输入商品与卖点，生成主副标题与卖点文案',
    category: '文案',
    cover: '复古 胶片 沙漠',
    ratio: '4:3',
    modality: 'text',
    prompt: '「{product}」广告文案，核心卖点：{selling}',
    inputs: [
      { key: 'product', label: '商品', type: 'text', required: true, example: '山野秋季限定拿铁' },
      { key: 'selling', label: '卖点', type: 'text', example: '真枫糖、燕麦奶基底、每日现烘豆' },
    ],
    params: { template: 'ad', tone: '专业', chars: 500 },
  }),
  // ---------- 音频 ----------
  single({
    id: 'ad-voiceover',
    title: '广告配音',
    desc: '粘贴广告词，生成温暖女声配音',
    category: '音频',
    cover: '海 蓝 宁静 播客',
    ratio: '1:1',
    modality: 'audio',
    prompt: '{script}',
    inputs: [{ key: 'script', label: '广告词', type: 'text', required: true, example: '秋天的第一杯，山野枫糖拿铁，限时 8 折。', maxLength: 300 }],
    params: { voice: '晚晴' },
    model: 'creature-tts',
  }),
  single({
    id: 'bgm',
    title: '短视频背景音乐',
    desc: '描述风格，生成 30 秒无人声背景音乐',
    category: '音频',
    cover: '星空 宇宙 梦 极光',
    ratio: '1:1',
    modality: 'audio',
    prompt: '{style}，适合短视频背景，无人声',
    inputs: [{ key: 'style', label: '风格', type: 'text', example: '轻快的 Lo-fi 爵士' }],
    params: { seconds: 30 },
    model: 'creature-music',
  }),
  // ---------- 工作流（在画布中展开） ----------
  {
    id: 't1',
    kind: 'workflow',
    title: '小红书封面 3 连图',
    desc: '输入主题，自动生成标题文案与 3 张风格统一的竖版封面',
    category: '自媒体',
    cover: '秋日 小红书 封面 咖啡',
    ratio: '3:4',
    modality: 'image',
    prompt: '秋季咖啡探店',
    inputs: [],
    params: {},
    steps: [
      { kind: 'text', title: '生成标题与卖点文案', credits: 1 },
      { kind: 'image', title: '主封面 · 3:4', credits: 6 },
      { kind: 'image', title: '副图 ×2 · 统一风格', credits: 12 },
    ],
  },
  {
    id: 't3',
    kind: 'workflow',
    title: '15 秒产品广告片',
    desc: '脚本 → 关键帧 → 3 个镜头视频 → 配音，一条龙生成竖版广告',
    category: '广告',
    cover: '柠檬 饮料 活力 广告',
    ratio: '9:16',
    modality: 'video',
    prompt: '柠檬气泡水夏日广告',
    inputs: [],
    params: {},
    steps: [
      { kind: 'text', title: '15 秒分镜脚本', credits: 1 },
      { kind: 'image', title: '关键帧 ×3', credits: 18 },
      { kind: 'video', title: '镜头视频 ×3 · 5 秒', credits: 240 },
      { kind: 'audio', title: '旁白配音', credits: 1 },
    ],
  },
  {
    id: 't4',
    kind: 'workflow',
    title: '漫剧单集分镜',
    desc: '粘贴剧本，自动拆出角色、场景与 12 个分镜，并批量生成镜头画面',
    category: '漫剧',
    cover: '动漫 樱花 少女 漫剧',
    ratio: '16:9',
    modality: 'image',
    prompt: '第 4 集：雨夜重逢',
    inputs: [],
    params: {},
    steps: [
      { kind: 'text', title: '剧本拆分镜表', credits: 1 },
      { kind: 'image', title: '分镜画面 ×12', credits: 72 },
      { kind: 'audio', title: '角色配音', credits: 3 },
    ],
  },
  {
    id: 't7',
    kind: 'workflow',
    title: '探店 Vlog 脚本 + 配图',
    desc: '输入店名与特色，生成口播脚本、6 张配图和片头音乐',
    category: '自媒体',
    cover: '面包 清晨 暖 探店',
    ratio: '9:16',
    modality: 'text',
    prompt: '城南新开的法式面包店',
    inputs: [],
    params: {},
    steps: [
      { kind: 'text', title: '口播脚本', credits: 1 },
      { kind: 'image', title: '配图 ×6', credits: 36 },
      { kind: 'audio', title: '片头音乐', credits: 15 },
    ],
  },
  {
    id: 't9',
    kind: 'workflow',
    title: '儿童绘本 8 页',
    desc: '一句话故事梗概 → 8 页绘本文字与插画，角色全程一致',
    category: '漫剧',
    cover: '奇幻 星空 鲸 绘本',
    ratio: '4:3',
    modality: 'image',
    prompt: '小鲸鱼寻找星星的故事',
    inputs: [],
    params: {},
    steps: [
      { kind: 'text', title: '故事文本 · 8 页', credits: 1 },
      { kind: 'image', title: '角色设定', credits: 6 },
      { kind: 'image', title: '插画 ×8', credits: 48 },
    ],
  },
  {
    id: 't10',
    kind: 'workflow',
    title: '播客封面 + 片头',
    desc: '生成播客封面与 15 秒片头音乐',
    category: '音频',
    cover: '海 蓝 宁静 播客',
    ratio: '1:1',
    modality: 'audio',
    prompt: '一档聊城市漫游的播客',
    inputs: [],
    params: {},
    steps: [
      { kind: 'image', title: '封面 1:1', credits: 6 },
      { kind: 'audio', title: '片头音乐', credits: 15 },
    ],
  },
];

export const findTemplate = (id: string) => TEMPLATE_CATALOG.find((t) => t.id === id);

/** 输入不合法时的说明；全部合法返回 null。images 为已提供的图片输入（键） */
export function checkTemplateInputs(t: TemplateDef, values: Record<string, string>, images: string[]): string | null {
  for (const i of t.inputs) {
    if (i.type === 'image') {
      if (i.required && !images.includes(i.key)) return `请上传${i.label}`;
      continue;
    }
    const v = (values[i.key] ?? '').trim();
    if (i.required && !v) return `请填写${i.label}`;
    if (v.length > (i.maxLength ?? TEXT_MAX)) return `${i.label}最多 ${i.maxLength ?? TEXT_MAX} 个字`;
  }
  return null;
}

/** 用输入替换提示词中的 {key}；可选输入留空时用示例值 */
export function renderTemplate(t: TemplateDef, values: Record<string, string>): string {
  return t.prompt.replace(/\{(\w+)\}/g, (_, key: string) => {
    const def = t.inputs.find((i) => i.key === key);
    const v = (values[key] ?? '').trim();
    return v || def?.example || '';
  });
}

/** 生成参数：配音按文字长度计费 */
export function templateParams(t: TemplateDef, prompt: string): GenerationParams {
  if (t.model === 'creature-tts') return { ...t.params, chars: prompt.length, seconds: Math.max(4, Math.round(prompt.length / 4.5)) };
  return { ...t.params };
}

/** 示例输入（全部用示例值） */
export const exampleValues = (t: TemplateDef) => Object.fromEntries(t.inputs.filter((i) => i.type === 'text').map((i) => [i.key, i.example ?? '']));

/** 预估积分：单步模板按示例输入路由到的模型与参数计算；工作流为各步骤之和 */
export function templateCredits(t: TemplateDef): number {
  if (t.kind === 'workflow') return t.steps.reduce((a, s) => a + s.credits, 0);
  const prompt = renderTemplate(t, exampleValues(t));
  const model = t.model ? modelByCode(t.model) : routeModel(t.modality, prompt, t.strategy ?? 'auto').model;
  return estimateCredits(model, templateParams(t, prompt));
}

/** 模板市场返回的模板：目录定义 + 使用统计 */
export interface TemplateDTO extends TemplateDef {
  uses: number;
  rating: { avg: number | null; count: number };
  /** 当前用户的评分；用过模板才能评分 */
  my_rating: number | null;
  used_by_me: boolean;
  estimated_credits: number;
}
