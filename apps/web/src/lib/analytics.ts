// 客户端埋点：只上报界面行为（页面浏览、付费墙、小造计划、复制）；提交、下载、发布、支付等由服务端记录。
// 攒批发送（最多 20 条或 3 秒），页面隐藏时立即发送；上报失败直接丢弃，不影响使用。

import type { ClientEvent } from '@creature/shared';
import { api, BACKEND } from './api';

const MAX_BATCH = 20;
const queue: ClientEvent[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

export function track(event: ClientEvent) {
  if (BACKEND !== 'api') return;
  queue.push(event);
  clearTimeout(timer);
  if (queue.length >= MAX_BATCH) flush();
  else timer = setTimeout(flush, 3000);
}

export function flush() {
  clearTimeout(timer);
  while (queue.length) void api.trackEvents(queue.splice(0, MAX_BATCH)).catch(() => undefined);
}

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
