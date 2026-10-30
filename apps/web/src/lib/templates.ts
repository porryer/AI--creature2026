// 模板市场数据：目录来自 packages/shared；接入后端时附带真实的使用次数与评分，离线演示使用示例统计

import { TEMPLATE_CATALOG, templateCredits, type TemplateDTO } from '@creature/shared';
import { useEffect, useSyncExternalStore } from 'react';
import { api, BACKEND } from './api';
import { MOCK_TEMPLATE_STATS } from './mock';

const offline: TemplateDTO[] = TEMPLATE_CATALOG.map((t) => {
  const s = MOCK_TEMPLATE_STATS[t.id];
  return { ...t, uses: s?.uses ?? 0, rating: { avg: s?.rating ?? null, count: s ? 1 : 0 }, my_rating: null, used_by_me: false, estimated_credits: templateCredits(t) };
});

let list: TemplateDTO[] = BACKEND === 'api' ? [] : offline;
let loaded = BACKEND !== 'api';
const listeners = new Set<() => void>();

function set(next: TemplateDTO[]) {
  list = next;
  loaded = true;
  listeners.forEach((fn) => fn());
}

export async function reloadTemplates() {
  if (BACKEND === 'api') set((await api.templates()).data);
}

/** 用一个模板的最新数据替换列表中的旧数据（使用、评分后） */
export function patchTemplate(t: TemplateDTO) {
  set(list.map((x) => (x.id === t.id ? t : x)));
}

export function useTemplates(): { templates: TemplateDTO[]; loaded: boolean } {
  const templates = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => list,
  );
  useEffect(() => {
    void reloadTemplates().catch(() => undefined);
  }, []);
  return { templates, loaded };
}
