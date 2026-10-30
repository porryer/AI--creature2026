// 写作任务的流式输出：按 offset 拼接服务端推送的增量。推送可能乱序到达，暂存不连续的片段，等前面的到了再拼上；
// offset 为 0 表示重新开始（服务端切换了备选模型）。任务结束后以最终结果为准，这里的文本随之清除。

import type { ServerEvent } from '@creature/shared';
import { useSyncExternalStore } from 'react';

type Delta = Extract<ServerEvent, { type: 'task.delta' }>;

const texts = new Map<string, string>();
const parked = new Map<string, Map<number, string>>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

export function applyDelta(d: Delta) {
  let cur = texts.get(d.task_id) ?? '';
  const waiting = parked.get(d.task_id) ?? new Map<number, string>();
  if (d.offset === 0) waiting.clear();
  if (d.offset > cur.length) {
    waiting.set(d.offset, d.text);
    parked.set(d.task_id, waiting);
    return;
  }
  cur = cur.slice(0, d.offset) + d.text;
  for (let next = waiting.get(cur.length); next !== undefined; next = waiting.get(cur.length)) {
    waiting.delete(cur.length);
    cur += next;
  }
  texts.set(d.task_id, cur);
  parked.set(d.task_id, waiting);
  notify();
}

export function clearStream(taskId: string) {
  parked.delete(taskId);
  if (texts.delete(taskId)) notify();
}

/** 某个任务目前已推送的文本 */
export function useStreamText(taskId: string | undefined): string {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => (taskId ? (texts.get(taskId) ?? '') : ''),
  );
}
