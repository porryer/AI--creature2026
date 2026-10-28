/**
 * 滑动窗口限流（进程内）。多实例部署时每个实例单独计数，
 * 需要全局一致时换成 Redis（docs/04-database.md 第 4 节的限流键）。
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** 记录一次请求；超出限制时返回需要等待的秒数，否则返回 0 */
  take(key: string, now = Date.now()): number {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return Math.max(1, Math.ceil((list[0] + this.windowMs - now) / 1000));
    }
    list.push(now);
    this.hits.set(key, list);
    // 定期清理不活跃的键，避免无限增长
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    return 0;
  }
}
