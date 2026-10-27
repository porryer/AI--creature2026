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

  checkOutput(out: RawOutput): Verdict {
    if (out.flags?.includes('sensitive')) return { verdict: 'block', labels: ['image:sensitive'] };
    if (out.kind === 'text') return this.checkText(out.text ?? out.data.toString('utf8'));
    return { verdict: 'pass', labels: [] };
  }

  async record(
    r: { userId: string; targetType: 'prompt' | 'upload' | 'output'; targetId: string | null; result: Verdict },
    q: Queryable = this.db,
  ) {
    await q.query('INSERT INTO moderation_records (id, user_id, target_type, target_id, verdict, labels, provider) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      newId('mod'),
      r.userId,
      r.targetType,
      r.targetId,
      r.result.verdict,
      JSON.stringify(r.result.labels),
      this.provider,
    ]);
  }
}
