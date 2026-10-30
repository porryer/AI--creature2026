import { Inject, Injectable } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { newId } from '../common/ids';
import { Db, DB, Queryable } from '../db/db';
import type { RawOutput } from './labeling.service';

export interface Verdict {
  verdict: 'pass' | 'review' | 'block';
  labels: string[];
}

const BASE_WORDS = ['违规', '血腥', '暴恐', '色情'];
// 发布到广场时需要人工复核的词（公众人物、医疗与投资功效等高风险宣传）
const REVIEW_WORDS = ['明星', '代言', '疗效', '肖像', '投资回报'];

/**
 * 内容审核（docs/08-compliance.md 第 4 节）。
 * 当前为关键词规则实现，用于打通"提示词 → 生成结果"两道审核与记录；
 * 上线前接入第三方审核服务（文本 / 图像 / 视频 / 音频），并保留规则库作为兜底。
 */
@Injectable()
export class ModerationService {
  private readonly words: string[];
  readonly provider = 'keyword-rules';

  constructor(
    @Inject(CONFIG) config: AppConfig,
    @Inject(DB) private readonly db: Db,
  ) {
    this.words = [...BASE_WORDS, ...config.moderationExtraWords];
  }

  checkText(text: string): Verdict {
    const hits = this.words.filter((w) => text.includes(w));
    return hits.length ? { verdict: 'block', labels: hits.map((w) => `keyword:${w}`) } : { verdict: 'pass', labels: [] };
  }

  /** 上传素材审核：当前只检查文件名，图像内容审核待接入第三方服务 */
  checkUpload(u: { filename: string }): Verdict {
    const r = this.checkText(u.filename);
    return r.verdict === 'block' ? { verdict: 'block', labels: r.labels.map((l) => `filename:${l}`) } : r;
  }

  /** 广场发布审核：命中拦截词直接拒绝，命中复核词进入人工复核 */
  checkPost(p: { title: string; tags: string[]; prompt: string }): Verdict {
    const text = [p.title, ...p.tags, p.prompt].join(' ');
    const block = this.checkText(text);
    if (block.verdict === 'block') return block;
    const hits = REVIEW_WORDS.filter((w) => text.includes(w));
    return hits.length ? { verdict: 'review', labels: hits.map((w) => `review:${w}`) } : { verdict: 'pass', labels: [] };
  }

  checkOutput(out: RawOutput): Verdict {
    if (out.flags?.includes('sensitive')) return { verdict: 'block', labels: ['image:sensitive'] };
    if (out.kind === 'text') return this.checkText(out.text ?? out.data.toString('utf8'));
    return { verdict: 'pass', labels: [] };
  }

  /** 记录审核结果；人工复核时带上 reviewerId */
  async record(
    r: { userId: string; targetType: 'prompt' | 'upload' | 'output' | 'post' | 'character' | 'brand_kit' | 'comment'; targetId: string | null; result: Verdict; reviewerId?: string },
    q: Queryable = this.db,
  ) {
    await q.query('INSERT INTO moderation_records (id, user_id, target_type, target_id, verdict, labels, provider, stage, reviewer_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
      newId('mod'),
      r.userId,
      r.targetType,
      r.targetId,
      r.result.verdict,
      JSON.stringify(r.result.labels),
      r.reviewerId ? 'human' : this.provider,
      r.reviewerId ? 'human' : 'machine',
      r.reviewerId ?? null,
    ]);
  }
}
