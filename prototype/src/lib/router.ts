import { useEffect, useState } from 'react';
import type { Modality } from './types';

// 极简路由：用不带斜杠的 hash 标记页面（如 #studio-video），便于直接分享到某个页面
export type RouteName = 'explore' | 'studio' | 'canvas' | 'assets' | 'templates' | 'projects' | 'pricing' | 'admin';
export interface Route {
  name: RouteName;
  mode: Modality;
}

const NAMES: RouteName[] = ['explore', 'studio', 'canvas', 'assets', 'templates', 'projects', 'pricing', 'admin'];
const MODES: Modality[] = ['image', 'video', 'text', 'audio'];

function parse(hash: string): Route {
  const token = hash.replace(/^#/, '');
  const [name, mode] = token.split('-') as [RouteName, Modality | undefined];
  return {
    name: NAMES.includes(name) ? name : 'explore',
    mode: mode && MODES.includes(mode) ? mode : 'image',
  };
}

function readHash(): string {
  try {
    return window.location.hash;
  } catch {
    return '';
  }
}

let current: Route = parse(readHash());
const listeners = new Set<(r: Route) => void>();

export function navigate(name: RouteName, mode?: Modality) {
  current = { name, mode: mode ?? (name === 'studio' ? current.mode : 'image') };
  const token = name === 'studio' ? `studio-${current.mode}` : name;
  try {
    if (window.location.hash !== `#${token}`) window.history.replaceState(null, '', `#${token}`);
  } catch {
    /* 沙箱环境下忽略 */
  }
  listeners.forEach((l) => l(current));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(current);
  useEffect(() => {
    listeners.add(setRoute);
    const onHash = () => {
      current = parse(readHash());
      listeners.forEach((l) => l(current));
    };
    window.addEventListener('hashchange', onHash);
    return () => {
      listeners.delete(setRoute);
      window.removeEventListener('hashchange', onHash);
    };
  }, []);
  return route;
}
