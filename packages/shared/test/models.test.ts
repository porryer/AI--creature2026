import { EDIT_MODEL, editLabel, estimateCredits, fallbackModels, findModel, modelByCode, modelsFor, normalizeParams, routeModel } from '../src/models';
import { orderAmountFen, PLANS } from '../src/plans';

const m = (code: string) => {
  const model = findModel(code);
  if (!model) throw new Error(`unknown model ${code}`);
  return model;
};

describe('estimateCredits：与 PRD 4.10 价目表一致', () => {
  it.each([
    ['creature-swift', { resolution: '1k', count: 1 }, 2],
    ['seedream-4', { resolution: '2k', count: 1 }, 6],
    ['seedream-5', { resolution: '4k', count: 1 }, 12],
    ['seedream-4', { resolution: '2k', count: 4 }, 24],
  ])('图像 %s %j = %i 积分', (code, params, credits) => {
    expect(estimateCredits(m(code), params)).toBe(credits);
  });

  it.each([
    ['creature-motion', { resolution: '720p', duration: 5 }, 40],
    ['wan-2.6', { resolution: '1080p', duration: 5 }, 80],
    ['kling-3.0', { resolution: '1080p', duration: 10 }, 300],
    ['kling-3.0', { resolution: '1080p', duration: 10, audio: true }, 450],
  ])('视频 %s %j = %i 积分', (code, params, credits) => {
    expect(estimateCredits(m(code), params)).toBe(credits);
  });

  it('文本按每 2000 字 1 积分、至少 1 积分', () => {
    expect(estimateCredits(m('qwen-max'), { chars: 100 })).toBe(1);
    expect(estimateCredits(m('qwen-max'), { chars: 4001 })).toBe(3);
  });

  it('配音每 300 字 1 积分，配乐每首 15 积分', () => {
    expect(estimateCredits(m('creature-tts'), { chars: 301 })).toBe(2);
    expect(estimateCredits(m('creature-music'), { seconds: 120 })).toBe(15);
  });
});

describe('routeModel：智能路由', () => {
  it('需要中文文字排版时选 Seedream 4.0', () => {
    expect(routeModel('image', '秋季海报，标题文字“秋天的第一杯”', 'auto').model.code).toBe('seedream-4');
  });
  it('国风插画选通义万相', () => {
    expect(routeModel('image', '水墨国风的山间小屋，留白构图', 'auto').model.code).toBe('wanx-2.5');
  });
  it('动漫视频选 Vidu，多镜头选 Kling', () => {
    expect(routeModel('video', '动漫风格的樱花电车', 'auto').model.code).toBe('vidu-q3');
    expect(routeModel('video', '柠檬气泡水广告片，多镜头', 'auto').model.code).toBe('kling-3.0');
  });
  it('省积分选最便宜，最佳质量选质量最高', () => {
    expect(routeModel('image', '任意', 'cheap').model.code).toBe('creature-swift');
    expect(routeModel('image', '任意', 'best').model.tier).toBe('flagship');
  });
  it('首选模型不在可用池中时退回池内第一个', () => {
    const pool = modelsFor('image').filter((x) => x.code !== 'seedream-4');
    const r = routeModel('image', '产品白底图', 'auto', pool);
    expect(r.model.code).toBe(pool[0].code);
  });
  it('配乐模型不参与路由', () => {
    expect(modelsFor('audio').map((x) => x.code)).not.toContain('creature-music');
  });
});

describe('fallbackModels 与 normalizeParams', () => {
  it('备选模型不含主模型且同模态', () => {
    const list = fallbackModels(m('kling-3.0'));
    expect(list.map((x) => x.code)).not.toContain('kling-3.0');
    expect(list.every((x) => x.modality === 'video')).toBe(true);
    expect(list[0].code).toBe('seedance-2.5');
  });
  it('视频时长被限制在模型上限内，原生音频仅限支持的模型', () => {
    expect(normalizeParams(m('vidu-q3'), { duration: 15, audio: true })).toMatchObject({ duration: 10, audio: false });
    expect(normalizeParams(m('kling-3.0'), { duration: 15, audio: true })).toMatchObject({ duration: 15, audio: true });
  });
  it('图像数量限制在 1–12 张', () => {
    expect(normalizeParams(m('seedream-4'), { count: 13 }).count).toBe(12);
    expect(normalizeParams(m('seedream-4'), { count: 0 }).count).toBe(1);
  });
  it('modelByCode 对未知编码返回默认模型', () => {
    expect(modelByCode('nope').code).toBe('creature-swift');
  });
});

describe('图像编辑', () => {
  const edit = findModel(EDIT_MODEL)!;
  it('编辑模型不参与生成路由，也不作为备选模型', () => {
    expect(modelsFor('image').map((x) => x.code)).not.toContain(EDIT_MODEL);
    expect(fallbackModels(modelByCode('seedream-4')).map((x) => x.code)).not.toContain(EDIT_MODEL);
    for (const s of ['auto', 'cheap', 'best'] as const) expect(routeModel('image', '抠图换背景', s).model.code).not.toBe(EDIT_MODEL);
  });
  it('按次计费：超分 2× / 4× 为 2 / 4 积分，其余工具 2 积分', () => {
    expect(estimateCredits(edit, { tool: 'inpaint' })).toBe(2);
    expect(estimateCredits(edit, { tool: 'cutout', count: 4, resolution: '4k' })).toBe(2);
    expect(estimateCredits(edit, { tool: 'upscale', scale: 2 })).toBe(2);
    expect(estimateCredits(edit, { tool: 'upscale', scale: 4 })).toBe(4);
  });
  it('只保留当前工具需要的参数', () => {
    expect(normalizeParams(edit, { tool: 'outpaint', ratio: '16:9', scale: 4, resolution: '4k', count: 3 })).toEqual({ tool: 'outpaint', ratio: '16:9', count: 1 });
    expect(normalizeParams(edit, { tool: 'upscale', ratio: '1:1' })).toEqual({ tool: 'upscale', scale: 2, count: 1 });
    expect(editLabel({ tool: 'upscale', scale: 4 })).toBe('超分 4×');
    expect(editLabel({ tool: 'erase' })).toBe('消除');
  });
});

describe('orderAmountFen', () => {
  it('专业版年付 = 79 元 × 12，发放 1800 积分', () => {
    expect(orderAmountFen('subscription', 'pro', 'year')).toEqual({ amountFen: 94800, credits: PLANS.pro.monthlyCredits });
  });
  it('积分包与非法输入', () => {
    expect(orderAmountFen('credit_pack', '500', null)).toEqual({ amountFen: 4500, credits: 500 });
    expect(orderAmountFen('credit_pack', '999', null)).toBeNull();
    expect(orderAmountFen('subscription', 'free', 'month')).toBeNull();
  });
});
