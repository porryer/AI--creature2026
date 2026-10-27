import { artSvg, estimateCredits, mockTransform, mockWriting, sizeForRatio, type ModelInfo, type TransformKind } from '@creature/shared';
import { createHash } from 'node:crypto';
import type { RawOutput } from '../safety/labeling.service';
import { encodeWav, synth } from '../safety/wav';
import { AdapterRequest, AdapterResult, ProviderAdapter, ReferenceInput, VendorError } from './provider';

const LONG_SIDE: Record<string, number> = { '1k': 1024, '2k': 1536, '4k': 2048 };
const PENTATONIC = [262, 294, 330, 392, 440, 523, 587, 659, 784, 880];
const SAMPLE_RATE = 8000;
/** 超过该大小的参考图不内嵌到 SVG 中 */
const MAX_EMBED_BYTES = 8 * 1024 * 1024;

const wrap = (w: number, h: number, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`;

/** 把参考图内嵌为 SVG <image>（data URI），用于模拟"参考图生成" */
function imageTag(r: ReferenceInput, x: number, y: number, w: number, h: number, fit: 'slice' | 'meet'): string {
  const href = `data:${r.mime};base64,${r.data.toString('base64')}`;
  return `<image href="${href}" x="${Math.round(x)}" y="${Math.round(y)}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid ${fit}"/>`;
}

/**
 * Mock 供应商：不调用任何外部服务，按提示词确定性地生成真实文件
 * （SVG 图像、SVG 动画视频、WAV 音频、文本），用于开发、测试与演示。
 *
 * 演示标记（只在 Mock 模式生效）：
 * - 提示词含“失败”：所有候选模型均报错，任务失败并返还积分；
 * - 提示词含“超时”：主模型超时，网关切换备选模型后成功；
 * - 提示词含“敏感画面”：输出审核拦截，返还积分。
 *
 * 参考图：图像的主体 / 角色参考会被放进新场景中央，风格参考作为底图；视频的首帧 / 尾帧直接驱动画面。
 */
export class MockProvider implements ProviderAdapter {
  readonly name = 'mock';

  constructor(private readonly latencyMs: Record<string, number>) {}

  supports(_: ModelInfo) {
    return true;
  }

  async generate(req: AdapterRequest, onProgress: (pct: number) => void): Promise<AdapterResult> {
    const total = Math.round((this.latencyMs[req.modality] ?? 0) * (req.model.speed >= 4 ? 0.8 : 1.2));
    const steps = total > 0 ? 6 : 1;
    for (let i = 1; i <= steps; i++) {
      if (req.signal.aborted) throw new VendorError('VENDOR_TIMEOUT', '供应商响应超时', true);
      if (total > 0) await sleep(total / steps, req.signal);
      if (req.prompt.includes('超时') && req.candidateIndex === 0 && i >= steps / 2) throw new VendorError('VENDOR_TIMEOUT', `${req.model.name} 响应超时`, true);
      if (req.prompt.includes('失败') && i >= steps / 2) throw new VendorError('VENDOR_ERROR', `${req.model.name} 返回错误`, true);
      onProgress(Math.round((i / steps) * 85));
    }
    const flags = req.prompt.includes('敏感画面') ? ['sensitive'] : undefined;
    const outputs = this.render(req).map((o) => ({ ...o, flags }));
    return { outputs, vendorCostFen: estimateCredits(req.model, req.params) * 3 };
  }

  private render(req: AdapterRequest): RawOutput[] {
    const p = req.params;
    const ref = (...roles: string[]) => req.references.find((r) => roles.includes(r.role) && r.data.length <= MAX_EMBED_BYTES);
    if (req.modality === 'image') {
      const { w, h } = sizeForRatio(p.ratio ?? '3:4', LONG_SIDE[p.resolution ?? '1k'] ?? 1024);
      const subject = ref('subject', 'character');
      const style = ref('style');
      return Array.from({ length: p.count ?? 1 }, (_, i) => {
        const art = artSvg(req.prompt + (style ? ':style' : ''), { w, h, variant: i });
        let svg = art;
        // 风格参考：以参考图为底，叠加生成画面；主体 / 角色参考：把参考图放进新场景的中央
        if (style) svg = wrap(w, h, `${imageTag(style, 0, 0, w, h, 'slice')}<g opacity="0.55">${art}</g>`);
        if (subject) {
          const sw = Math.round(w * 0.62);
          const sh = Math.round(h * 0.62);
          svg = wrap(w, h, `${style ? svg : art}${imageTag(subject, (w - sw) / 2, (h - sh) / 2 + h * 0.06, sw, sh, 'meet')}`);
        }
        return { kind: 'image' as const, mime: 'image/svg+xml', data: Buffer.from(svg), width: w, height: h };
      });
    }
    if (req.modality === 'video') {
      const { w, h } = sizeForRatio(p.ratio ?? '9:16', p.resolution === '1080p' ? 1920 : 1280);
      const sec = p.duration ?? 5;
      const first = ref('first_frame');
      const last = ref('last_frame');
      // 图生视频：以首帧为画面主体；有尾帧时在后半段渐变到尾帧
      let inner = first ? wrap(w, h, imageTag(first, 0, 0, w, h, 'slice')) : artSvg(req.prompt, { w, h, variant: 0 });
      if (last) inner = wrap(w, h, `${inner}<g opacity="0">${imageTag(last, 0, 0, w, h, 'slice')}<animate attributeName="opacity" values="0;0;1" dur="${sec}s" repeatCount="indefinite"/></g>`);
      // 以 SVG 动画模拟视频画面（缓慢推近），时长写入 data-duration
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" data-duration="${sec}">` +
        `<g><animateTransform attributeName="transform" type="scale" values="1;1.12;1" dur="${sec}s" repeatCount="indefinite" additive="sum"/>` +
        `<animateTransform attributeName="transform" type="translate" values="0 0;${-w * 0.06} ${-h * 0.06};0 0" dur="${sec}s" repeatCount="indefinite" additive="sum"/>` +
        `${inner}</g></svg>`;
      return [{ kind: 'video', mime: 'image/svg+xml', data: Buffer.from(svg), width: w, height: h, durationMs: sec * 1000 }];
    }
    if (req.modality === 'audio') {
      const music = req.model.code === 'creature-music';
      const sec = Math.min(120, Math.max(2, p.seconds ?? (music ? 30 : Math.ceil(req.prompt.length / 4.5))));
      const noteSec = music ? 0.5 : 0.18;
      const seed = createHash('sha256').update(req.prompt).digest();
      const notes = Array.from({ length: Math.ceil(sec / noteSec) }, (_, i) => (music || seed[i % seed.length] % 5 ? PENTATONIC[seed[i % seed.length] % PENTATONIC.length] : 0));
      const samples = synth(notes, noteSec, SAMPLE_RATE).subarray(0, sec * SAMPLE_RATE);
      return [{ kind: 'audio', mime: 'audio/wav', data: encodeWav(samples, SAMPLE_RATE), durationMs: sec * 1000 }];
    }
    const text = req.operation === 'edit' ? mockTransform((p.transform as TransformKind) ?? '改写', req.prompt) : mockWriting(p.template, req.prompt, p.tone);
    return [{ kind: 'text', mime: 'text/plain; charset=utf-8', data: Buffer.from(text), text }];
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}
