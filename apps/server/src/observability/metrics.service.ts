import { Injectable } from '@nestjs/common';

type Labels = Record<string, string>;

const key = (labels: Labels) =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/["\\\n]/g, '_')}"`)
    .join(',');

/** 耗时直方图分桶（秒） */
const BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * 进程内指标（Prometheus 文本格式）。计数器与直方图随请求累积；
 * 队列长度、模型健康度等状态在抓取时由 MetricsController 现查现算。
 */
@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, { help: string; values: Map<string, number> }>();
  private readonly histograms = new Map<string, { help: string; values: Map<string, { buckets: number[]; sum: number; count: number }> }>();

  inc(name: string, help: string, labels: Labels = {}, by = 1) {
    const c = this.counters.get(name) ?? { help, values: new Map() };
    this.counters.set(name, c);
    const k = key(labels);
    c.values.set(k, (c.values.get(k) ?? 0) + by);
  }

  observe(name: string, help: string, labels: Labels, seconds: number) {
    const h = this.histograms.get(name) ?? { help, values: new Map() };
    this.histograms.set(name, h);
    const k = key(labels);
    const v = h.values.get(k) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
    BUCKETS.forEach((b, i) => {
      if (seconds <= b) v.buckets[i]++;
    });
    v.sum += seconds;
    v.count++;
    h.values.set(k, v);
  }

  /** 输出全部指标；gauges 为抓取时计算的瞬时值 */
  render(gauges: { name: string; help: string; samples: { labels?: Labels; value: number }[] }[] = []): string {
    const out: string[] = [];
    for (const [name, c] of this.counters) {
      out.push(`# HELP ${name} ${c.help}`, `# TYPE ${name} counter`);
      for (const [k, v] of c.values) out.push(`${name}${k ? `{${k}}` : ''} ${v}`);
    }
    for (const [name, h] of this.histograms) {
      out.push(`# HELP ${name} ${h.help}`, `# TYPE ${name} histogram`);
      for (const [k, v] of h.values) {
        const sep = k ? `${k},` : '';
        BUCKETS.forEach((b, i) => out.push(`${name}_bucket{${sep}le="${b}"} ${v.buckets[i]}`));
        out.push(`${name}_bucket{${sep}le="+Inf"} ${v.count}`, `${name}_sum${k ? `{${k}}` : ''} ${v.sum.toFixed(6)}`, `${name}_count${k ? `{${k}}` : ''} ${v.count}`);
      }
    }
    for (const g of gauges) {
      out.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`);
      for (const s of g.samples) {
        const k = key(s.labels ?? {});
        out.push(`${g.name}${k ? `{${k}}` : ''} ${Number.isFinite(s.value) ? s.value : 0}`);
      }
    }
    return out.join('\n') + '\n';
  }
}
