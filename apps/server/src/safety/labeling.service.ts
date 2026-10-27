import { Inject, Injectable } from '@nestjs/common';
import { AI_TEXT_LABEL, type Modality } from '@creature/shared';
import { createHash, randomBytes } from 'node:crypto';
import { AppConfig, CONFIG } from '../config';
import { cnDateKey } from '../common/time';
import { decodeWav, encodeWav, synth } from './wav';

/** 模型网关返回的原始产物 */
export interface RawOutput {
  kind: Modality;
  mime: string;
  data: Buffer;
  width?: number;
  height?: number;
  durationMs?: number;
  text?: string;
  /** Mock 供应商用于模拟输出审核结果的标记 */
  flags?: string[];
}

export interface AigcMeta {
  Label: string;
  ContentProducer: string;
  ProduceID: string;
  ReservedCode1: string;
  ContentPropagator: string;
  PropagateID: string;
  ReservedCode2: string;
}

export interface LabeledOutput extends RawOutput {
  contentId: string;
  aigc: AigcMeta;
}

export const AI_LABEL_TEXT = 'AI 生成';

/**
 * 生成合成内容标识（docs/08-compliance.md 第 3 节）：
 * - 显式标识：图像 / 视频画面角标，音频开头提示音，文本末尾提示语；
 * - 隐式标识：在文件元数据写入 AIGC 字段（内容属性、服务提供者、内容编号、校验值）。
 * 字段名与取值需在上线前按 GB 45438-2025 原文逐条核对。
 */
@Injectable()
export class LabelingService {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  newContentId(now = new Date()): string {
    return `CRT-${cnDateKey(now)}-${randomBytes(4).toString('hex').toUpperCase()}`;
  }

  meta(contentId: string, raw: Buffer): AigcMeta {
    return {
      Label: '1',
      ContentProducer: this.config.serviceProviderCode,
      ProduceID: contentId,
      ReservedCode1: createHash('sha256').update(raw).digest('hex').slice(0, 32),
      ContentPropagator: this.config.serviceProviderCode,
      PropagateID: contentId,
      ReservedCode2: '',
    };
  }

  apply(raw: RawOutput): LabeledOutput {
    const contentId = this.newContentId();
    const aigc = this.meta(contentId, raw.data);
    if (raw.mime === 'image/svg+xml') return { ...raw, data: Buffer.from(labelSvg(raw.data.toString('utf8'), aigc, raw.width, raw.height)), contentId, aigc };
    if (raw.mime === 'audio/wav') {
      const wav = decodeWav(raw.data);
      const cue = synth([880, 880, 1320], 0.12, wav.sampleRate, 0.08);
      const samples = new Int16Array(cue.length + wav.samples.length);
      samples.set(cue, 0);
      samples.set(wav.samples, cue.length);
      const data = encodeWav(samples, wav.sampleRate, { ...wav.info, ICMT: JSON.stringify({ AIGC: aigc }), ISFT: 'Creature' });
      return { ...raw, data, durationMs: Math.round((samples.length / wav.sampleRate) * 1000), contentId, aigc };
    }
    if (raw.kind === 'text') {
      const text = `${raw.text ?? raw.data.toString('utf8')}\n\n${AI_TEXT_LABEL}`;
      return { ...raw, text, data: Buffer.from(text, 'utf8'), contentId, aigc };
    }
    throw new Error(`暂不支持为 ${raw.mime} 添加标识`);
  }
}

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 在 SVG 中写入隐式标识（metadata）并在右下角绘制显式角标 */
export function labelSvg(svg: string, aigc: AigcMeta, width = 1024, height = 1024): string {
  const open = svg.indexOf('>', svg.indexOf('<svg'));
  const close = svg.lastIndexOf('</svg>');
  if (open < 0 || close < 0) throw new Error('无效的 SVG');
  // 显式标识文字高度不低于画面最短边的 5%
  const fs = Math.max(12, Math.ceil(Math.min(width, height) * 0.05));
  const pad = Math.round(fs * 0.4);
  const bw = Math.round(fs * 3.6) + pad * 2;
  const bh = fs + pad * 2;
  const x = width - bw - pad;
  const y = height - bh - pad;
  const badge =
    `<g id="aigc-label" aria-label="${AI_LABEL_TEXT}">` +
    `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="${Math.round(fs * 0.3)}" fill="#000" fill-opacity="0.55"/>` +
    `<text x="${x + bw / 2}" y="${y + pad + fs * 0.85}" font-size="${fs}" font-family="sans-serif" fill="#fff" text-anchor="middle">${AI_LABEL_TEXT}</text></g>`;
  const metadata = `<metadata id="aigc">${escapeXml(JSON.stringify({ AIGC: aigc }))}</metadata>`;
  return svg.slice(0, open + 1) + metadata + svg.slice(open + 1, close) + badge + svg.slice(close);
}
