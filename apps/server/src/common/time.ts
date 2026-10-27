// 时间工具：业务日按北京时间（UTC+8）划分

const CN_OFFSET_MS = 8 * 3600_000;

export const addSeconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000);
export const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86400_000);

export function addMonths(d: Date, months: number): Date {
  const r = new Date(d.getTime());
  const day = r.getUTCDate();
  r.setUTCMonth(r.getUTCMonth() + months);
  // 月末对齐：1 月 31 日加一个月得到 2 月最后一天
  if (r.getUTCDate() < day) r.setUTCDate(0);
  return r;
}

/** 北京时间当天 23:59:59.999 对应的时刻 */
export function endOfCnDay(d: Date): Date {
  const local = new Date(d.getTime() + CN_OFFSET_MS);
  local.setUTCHours(23, 59, 59, 999);
  return new Date(local.getTime() - CN_OFFSET_MS);
}

/** 北京时间日期，如 20261027 */
export function cnDateKey(d: Date): string {
  return new Date(d.getTime() + CN_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, '');
}
