import { artSvg, findModel } from '@creature/shared';
import { loadConfig } from '../src/config';
import { MockProvider } from '../src/gateway/mock.provider';
import { ModelGateway } from '../src/gateway/model-gateway.service';
import { AI_LABEL_TEXT, LabelingService } from '../src/safety/labeling.service';
import { decodeWav, encodeWav, synth } from '../src/safety/wav';

const config = loadConfig({ NODE_ENV: 'test' });
const labeling = new LabelingService(config);
const model = (code: string) => findModel(code)!;

describe('AI 生成内容标识', () => {
  it('SVG 写入隐式元数据并绘制显式角标，字号不小于最短边 5%', () => {
    const svg = artSvg('秋日咖啡', { w: 600, h: 800 });
    const out = labeling.apply({ kind: 'image', mime: 'image/svg+xml', data: Buffer.from(svg), width: 600, height: 800 });
    const text = out.data.toString('utf8');
    expect(out.contentId).toMatch(/^CRT-\d{8}-[0-9A-F]{8}$/);
    expect(text).toContain('<metadata id="aigc">');
    expect(text).toContain(`"ProduceID":"${out.contentId}"`);
    expect(text).toContain(`>${AI_LABEL_TEXT}</text>`);
    expect(Number(text.match(/font-size="(\d+)"/)![1])).toBeGreaterThanOrEqual(30);
    expect(text.trim().endsWith('</svg>')).toBe(true);
    // 校验值基于原始文件
    expect(out.aigc.ReservedCode1).toHaveLength(32);
  });

  it('WAV 在开头加入提示音，并把 AIGC 字段写入 INFO 块', () => {
    const raw = encodeWav(synth([440, 523], 0.5, 8000), 8000);
    const out = labeling.apply({ kind: 'audio', mime: 'audio/wav', data: raw, durationMs: 1000 });
    const wav = decodeWav(out.data);
    expect(wav.samples.length).toBeGreaterThan(decodeWav(raw).samples.length);
    expect(JSON.parse(wav.info.ICMT).AIGC.ProduceID).toBe(out.contentId);
    expect(out.durationMs).toBeGreaterThan(1000);
  });

  it('文本末尾附加提示语', () => {
    const out = labeling.apply({ kind: 'text', mime: 'text/plain; charset=utf-8', data: Buffer.from('正文'), text: '正文' });
    expect(out.text).toBe('正文\n\n（本内容由 AI 生成）');
  });
});

describe('模型网关', () => {
  const gw = () => new ModelGateway(config, [new MockProvider({ image: 0, video: 0, text: 0, audio: 0 })]);
  const req = (prompt: string, modality: 'image' | 'audio' = 'image') => ({ taskId: 'tsk_x', modality, operation: 'generate' as const, prompt, params: { count: 1 } });

  it('主模型超时后切换备选模型', async () => {
    const r = await gw().generate(model('seedream-4'), req('超时 测试'), () => undefined);
    expect(r.model.code).not.toBe('seedream-4');
    expect(r.attempts).toEqual([{ model: 'seedream-4', code: 'VENDOR_TIMEOUT' }]);
    expect(r.outputs).toHaveLength(1);
  });

  it('所有候选模型失败时抛出 ALL_MODELS_FAILED，最多尝试 3 个', async () => {
    await expect(gw().generate(model('seedream-4'), req('失败 测试'), () => undefined)).rejects.toMatchObject({ code: 'ALL_MODELS_FAILED' });
    const g = gw();
    const err = await g.generate(model('seedream-4'), req('失败'), () => undefined).catch((e) => e);
    expect(err.attempts).toHaveLength(3);
  });

  it('连续失败达到阈值后熔断，熔断的模型不再参与路由', async () => {
    const g = gw();
    for (let i = 0; i < 10; i++) await g.generate(model('wanx-2.5'), req('失败'), () => undefined).catch(() => undefined);
    expect(g.health().find((h) => h.code === 'wanx-2.5')?.breakerOpen).toBe(true);
    expect(g.available('image').map((m) => m.code)).not.toContain('wanx-2.5');
    expect(g.route('image', '水墨国风插画', 'auto')?.model.code).not.toBe('wanx-2.5');
  });

  it('配乐失败不会退化成配音', async () => {
    const err = await gw()
      .generate(model('creature-music'), req('失败 配乐', 'audio'), () => undefined)
      .catch((e) => e);
    expect(err.attempts.map((a: { model: string }) => a.model)).toEqual(['creature-music']);
  });

  it('没有适配器时模型不可用', () => {
    const g = new ModelGateway(config, []);
    expect(g.available()).toHaveLength(0);
    expect(g.route('image', '任意', 'auto')).toBeNull();
  });
});
