import { randomBytes } from 'node:crypto';

let lastMs = 0;
let seq = 0;

/**
 * 生成带类型前缀、按时间有序的 ID（如 tsk_0mh2x9k1a00f3c9e…）。
 * 同一毫秒内用递增序号保证顺序，可直接作为游标分页的排序键。
 */
export function newId(prefix: string): string {
  const now = Date.now();
  if (now === lastMs) seq++;
  else {
    lastMs = now;
    seq = 0;
  }
  return `${prefix}_${now.toString(36).padStart(9, '0')}${seq.toString(36).padStart(3, '0')}${randomBytes(6).toString('hex')}`;
}
