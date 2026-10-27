import type { Modality, ModelInfo, RoutingStrategy } from './types';

// 接入模型示例（名称、能力与价格为原型演示数据，价格规则对应 docs/02-prd.md 4.10 节）
export const MODELS: ModelInfo[] = [
  // 图像
  { code: 'creature-swift', name: '造物·极速', vendor: '自部署开源模型', modality: 'image', tier: 'standard', quality: 3, speed: 5, price: 2, unit: '张', tags: ['低成本', '草图'], desc: '出图最快，适合找灵感和批量草稿' },
  { code: 'seedream-4', name: 'Seedream 4.0', vendor: '火山方舟', modality: 'image', tier: 'advanced', quality: 5, speed: 4, price: 4, unit: '张', tags: ['中文文字', '写实', '产品'], desc: '中文排版与写实光影表现好' },
  { code: 'wanx-2.5', name: '通义万相 2.5', vendor: '阿里云百炼', modality: 'image', tier: 'advanced', quality: 4, speed: 4, price: 4, unit: '张', tags: ['插画', '国风'], desc: '插画、国风与海报风格稳定' },
  { code: 'seedream-5', name: 'Seedream 5.0', vendor: '火山方舟', modality: 'image', tier: 'flagship', quality: 5, speed: 3, price: 6, unit: '张', tags: ['旗舰', '4K', '多参考'], desc: '最高细节，支持多张参考图融合' },
  // 视频
  { code: 'creature-motion', name: '造物·标准视频', vendor: '自部署 Wan', modality: 'video', tier: 'standard', quality: 3, speed: 4, price: 8, unit: '秒', tags: ['低成本'], desc: '基础运动与运镜，适合素材与草稿', maxDuration: 10 },
  { code: 'wan-2.6', name: '万相 Wan 2.6', vendor: '阿里云百炼', modality: 'video', tier: 'advanced', quality: 4, speed: 4, price: 8, unit: '秒', tags: ['性价比'], desc: '画面稳定、性价比高', maxDuration: 15 },
  { code: 'vidu-q3', name: 'Vidu Q3', vendor: '生数科技', modality: 'video', tier: 'advanced', quality: 4, speed: 3, price: 8, unit: '秒', tags: ['动漫', '多主体一致'], desc: '动漫风格与多主体一致性强', maxDuration: 10 },
  { code: 'hailuo-2.3', name: '海螺 Hailuo 2.3', vendor: 'MiniMax', modality: 'video', tier: 'advanced', quality: 4, speed: 3, price: 8, unit: '秒', tags: ['人物表演'], desc: '人物表情与肢体表演自然', maxDuration: 10 },
  { code: 'kling-3.0', name: 'Kling 3.0', vendor: '可灵', modality: 'video', tier: 'flagship', quality: 5, speed: 2, price: 15, unit: '秒', tags: ['旗舰', '多镜头', '原生音频'], desc: '多镜头叙事、主体一致、原生音频', maxDuration: 15, nativeAudio: true },
  { code: 'seedance-2.5', name: 'Seedance 2.5', vendor: '火山方舟', modality: 'video', tier: 'flagship', quality: 5, speed: 3, price: 15, unit: '秒', tags: ['旗舰', '运镜', '原生音频'], desc: '复杂运镜与音画同步', maxDuration: 15, nativeAudio: true },
  // 文本
  { code: 'qwen-max', name: '通义千问 Max', vendor: '阿里云百炼', modality: 'text', tier: 'advanced', quality: 5, speed: 4, price: 1, unit: '2000 字', tags: ['长文', '剧本'], desc: '长文结构与剧本创作' },
  { code: 'doubao-pro', name: '豆包 Pro', vendor: '火山方舟', modality: 'text', tier: 'advanced', quality: 4, speed: 5, price: 1, unit: '2000 字', tags: ['口语化', '种草'], desc: '口语化表达与种草文案' },
  { code: 'deepseek-v3', name: 'DeepSeek V3', vendor: '深度求索', modality: 'text', tier: 'advanced', quality: 5, speed: 4, price: 1, unit: '2000 字', tags: ['逻辑', '结构化'], desc: '逻辑清晰，适合分镜表等结构化输出' },
  // 音频
  { code: 'creature-tts', name: '造物·配音', vendor: '多供应商 TTS', modality: 'audio', tier: 'advanced', quality: 4, speed: 5, price: 1, unit: '300 字', tags: ['多音色', '情绪'], desc: '40+ 中文音色，支持情绪与语速' },
  { code: 'creature-music', name: '造物·配乐', vendor: '已备案音乐模型', modality: 'audio', tier: 'advanced', quality: 4, speed: 3, price: 15, unit: '首', tags: ['配乐', '可选人声'], desc: '按风格与情绪生成 2 分钟内配乐' },
];

export const modelsFor = (m: Modality) => MODELS.filter((x) => x.modality === m && x.code !== 'creature-music');
export const modelByCode = (code: string) => MODELS.find((m) => m.code === code) ?? MODELS[0];

export const TIER_LABEL: Record<string, string> = { standard: '标准', advanced: '高级', flagship: '旗舰' };

const RES_MULT: Record<string, number> = { '1k': 1, '2k': 1.5, '4k': 2, '720p': 1, '1080p': 2 };

/** 积分预估：与 PRD 价目表一致 */
export function estimateCredits(model: ModelInfo, p: Record<string, string | number | boolean>): number {
  switch (model.modality) {
    case 'image': {
      const count = Number(p.count ?? 1);
      return Math.ceil(model.price * (RES_MULT[String(p.resolution ?? '1k')] ?? 1)) * count;
    }
    case 'video': {
      const sec = Number(p.duration ?? 5);
      const audio = p.audio ? 1.5 : 1;
      return Math.ceil(model.price * (RES_MULT[String(p.resolution ?? '720p')] ?? 1) * sec * audio);
    }
    case 'text':
      return Math.max(1, Math.ceil(Number(p.chars ?? 800) / 2000));
    case 'audio':
      if (model.code === 'creature-music') return model.price;
      return Math.max(1, Math.ceil(Number(p.chars ?? 100) / 300));
  }
}

interface RouteResult {
  model: ModelInfo;
  reason: string;
}

/** 智能路由（原型版）：按提示词特征 + 策略打分，对应 docs/03-architecture.md 5.1 节 */
export function routeModel(modality: Modality, prompt: string, strategy: RoutingStrategy): RouteResult {
  const pool = modelsFor(modality);
  if (strategy === 'cheap') {
    const m = [...pool].sort((a, b) => a.price - b.price || b.quality - a.quality)[0];
    return { model: m, reason: `「省积分」策略：在可用模型中选择单价最低的 ${m.name}` };
  }
  if (strategy === 'best') {
    const m = [...pool].sort((a, b) => b.quality - a.quality || b.price - a.price)[0];
    return { model: m, reason: `「最佳质量」策略：选择质量评分最高的 ${m.name}` };
  }
  const has = (...k: string[]) => k.some((w) => prompt.includes(w));
  const pickCode = (code: string, why: string): RouteResult => ({ model: pool.find((m) => m.code === code) ?? pool[0], reason: why });

  if (modality === 'image') {
    if (has('文字', '标题', '海报', '字体', 'logo', 'Logo')) return pickCode('seedream-4', '提示词需要在画面中排版中文文字，推荐中文字形最稳定的 Seedream 4.0');
    if (has('国风', '水墨', '插画', '古风', '绘本')) return pickCode('wanx-2.5', '识别到插画 / 国风风格，推荐风格表现稳定的通义万相 2.5');
    if (has('产品', '商品', '白底', '电商', '写实', '摄影')) return pickCode('seedream-4', '写实产品类画面，推荐光影与材质表现好的 Seedream 4.0');
    if (prompt.trim().length < 12) return pickCode('creature-swift', '提示词较短，先用极速模型低成本探索方向');
    return pickCode('seedream-4', '综合质量、速度与成本，推荐 Seedream 4.0');
  }
  if (modality === 'video') {
    if (has('动漫', '二次元', '漫剧', '卡通')) return pickCode('vidu-q3', '动漫风格视频，推荐多主体一致性强的 Vidu Q3');
    if (has('多镜头', '剧情', '广告片', '短片', '对白')) return pickCode('kling-3.0', '需要多镜头叙事，推荐支持多镜头与原生音频的 Kling 3.0');
    if (has('运镜', '环绕', '航拍', '推进')) return pickCode('seedance-2.5', '包含复杂运镜描述，推荐 Seedance 2.5');
    if (has('人物', '表情', '跳舞', '口播')) return pickCode('hailuo-2.3', '人物表演类画面，推荐表情自然的海螺 Hailuo 2.3');
    return pickCode('wan-2.6', '通用场景，推荐性价比高的万相 Wan 2.6');
  }
  if (modality === 'text') {
    if (has('分镜', '剧本', '表格')) return pickCode('deepseek-v3', '需要结构化输出，推荐 DeepSeek V3');
    if (has('小红书', '种草', '口播')) return pickCode('doubao-pro', '口语化种草文案，推荐豆包 Pro');
    return pickCode('qwen-max', '长文与通用写作，推荐通义千问 Max');
  }
  return { model: pool[0], reason: '默认配音模型' };
}
