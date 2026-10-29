// 角色库与品牌套件（接入后端时）：各页面共享同一份数据，新建、修改、删除后调用 reloadLibrary()

import type { BrandKitDTO, CharacterDTO, GenerationContextInput } from '@creature/shared';
import { useEffect, useSyncExternalStore } from 'react';
import { api, BACKEND, onTokenChange } from './api';

type Quota = { used: number; limit: number };

export interface LibraryState {
  loaded: boolean;
  characters: CharacterDTO[];
  brandKits: BrandKitDTO[];
  quota: { characters: Quota; brandKits: Quota };
}

const EMPTY: LibraryState = { loaded: false, characters: [], brandKits: [], quota: { characters: { used: 0, limit: 0 }, brandKits: { used: 0, limit: 0 } } };
let state = EMPTY;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: LibraryState) {
  state = next;
  listeners.forEach((fn) => fn());
}

// 退出登录或账号被限制时清空，避免下一个登录的用户看到
onTokenChange((token) => {
  if (!token) set(EMPTY);
});

/** 重新读取角色与品牌套件（并发调用只请求一次） */
export function reloadLibrary(): Promise<void> {
  if (BACKEND !== 'api') return Promise.resolve();
  loading ??= Promise.all([api.characters(), api.brandKits()])
    .then(([c, b]) => set({ loaded: true, characters: c.data, brandKits: b.data, quota: { characters: c.quota, brandKits: b.quota } }))
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** 角色库与品牌套件；首次使用时读取 */
export function useLibrary(): LibraryState {
  const s = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
  useEffect(() => {
    if (!state.loaded) void reloadLibrary().catch(() => undefined);
  }, []);
  return s;
}

/** 工作台中选择的引用 */
export interface ContextChoice {
  characterIds: string[];
  brandKitId: string | null;
  placeLogo: boolean;
}

export const NO_CONTEXT: ContextChoice = { characterIds: [], brandKitId: null, placeLogo: false };

/** 转成生成请求的 context；没有任何引用时为 undefined */
export function contextInput(c: ContextChoice): GenerationContextInput | undefined {
  if (!c.characterIds.length && !c.brandKitId) return undefined;
  return { character_ids: c.characterIds.length ? c.characterIds : undefined, brand_kit_id: c.brandKitId, place_logo: c.placeLogo || undefined };
}
