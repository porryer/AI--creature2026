import { AlertCircle, Bell, CheckCircle2, Compass, Crown, FolderKanban, Images, Info, LayoutTemplate, Monitor, Moon, Search, Shield, Sparkles, Sun, Workflow } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { fmt, timeAgo } from '../lib/mock';
import { navigate, type Route, type RouteName } from '../lib/router';
import { useStore, type Theme } from '../lib/store';
import { Coin } from './ui';

const NAV: { name: RouteName; label: string; icon: typeof Compass; mobile?: boolean }[] = [
  { name: 'explore', label: '发现', icon: Compass, mobile: true },
  { name: 'studio', label: '创作', icon: Sparkles, mobile: true },
  { name: 'canvas', label: '画布', icon: Workflow, mobile: true },
  { name: 'assets', label: '资产', icon: Images, mobile: true },
  { name: 'templates', label: '模板', icon: LayoutTemplate },
  { name: 'projects', label: '项目', icon: FolderKanban },
];

export const PAGE_META: Record<RouteName, { title: string; sub: string }> = {
  explore: { title: '发现', sub: '一句话开始创作，或从灵感广场做同款' },
  studio: { title: '创作工作台', sub: '图像 · 视频 · 写作 · 音频' },
  canvas: { title: '画布', sub: '节点工作流 + 创作 Agent 小造' },
  assets: { title: '资产', sub: '作品库 · 角色库 · 品牌套件' },
  templates: { title: '模板市场', sub: '单步模板与多步工作流' },
  projects: { title: '项目', sub: '按项目组织画布与资产' },
  pricing: { title: '会员与积分', sub: '套餐、积分余额与明细' },
  admin: { title: '管理后台', sub: '运营数据、模型路由与内容审核' },
};

export function NavRail({ route }: { route: Route }) {
  const { state, setTheme } = useStore();
  const nextTheme: Record<Theme, Theme> = { system: 'dark', dark: 'light', light: 'system' };
  const themeLabel: Record<Theme, string> = { system: '跟随系统', dark: '深色', light: '浅色' };
  const ThemeIcon = state.theme === 'dark' ? Moon : state.theme === 'light' ? Sun : Monitor;
  return (
    <nav className="rail" aria-label="主导航">
      <button className="rail-logo" aria-label="造物 Creature 首页" onClick={() => navigate('explore')}>
        造
      </button>
      {NAV.map((n) => (
        <button key={n.name} className="rail-item" aria-current={route.name === n.name ? 'page' : undefined} onClick={() => navigate(n.name)}>
          <n.icon size={20} strokeWidth={1.75} />
          {n.label}
        </button>
      ))}
      <div className="rail-spacer" />
      <button className="rail-item" aria-current={route.name === 'pricing' ? 'page' : undefined} onClick={() => navigate('pricing')}>
        <Crown size={20} strokeWidth={1.75} />
        会员
      </button>
      <button className="rail-item" aria-current={route.name === 'admin' ? 'page' : undefined} onClick={() => navigate('admin')}>
        <Shield size={20} strokeWidth={1.75} />
        后台
      </button>
      <button className="rail-item" title={`主题：${themeLabel[state.theme]}`} aria-label={`切换主题，当前${themeLabel[state.theme]}`} onClick={() => setTheme(nextTheme[state.theme])}>
        <ThemeIcon size={20} strokeWidth={1.75} />
        {themeLabel[state.theme]}
      </button>
    </nav>
  );
}

export function TabBar({ route }: { route: Route }) {
  const items = [...NAV.filter((n) => n.mobile), { name: 'pricing' as RouteName, label: '会员', icon: Crown }];
  return (
    <nav className="tabbar" aria-label="主导航">
      {items.map((n) => (
        <button key={n.name} className="rail-item" aria-current={route.name === n.name ? 'page' : undefined} onClick={() => navigate(n.name)}>
          <n.icon size={20} strokeWidth={1.75} />
          {n.label}
        </button>
      ))}
    </nav>
  );
}

export function TopBar({ route }: { route: Route }) {
  const { state, readNotices, setTheme } = useStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const unread = state.notices.filter((n) => !n.read).length;
  const meta = PAGE_META[route.name];

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <header className="topbar">
      <div className="topbar-title">
        <h1>{meta.title}</h1>
        <span>{meta.sub}</span>
      </div>
      <label className="topbar-search">
        <Search size={15} />
        <span className="visually-hidden">搜索</span>
        <input id="global-search" placeholder="搜索作品、模板、创作者" />
      </label>
      <div className="topbar-actions">
        <button className="credit" onClick={() => navigate('pricing')} aria-label={`可用积分 ${state.available}，查看会员与积分`}>
          <Coin />
          {fmt(state.available)}
          {state.frozen > 0 && (
            <span className="hide-sm" style={{ fontSize: 11.5, opacity: 0.75 }}>
              冻结 {state.frozen}
            </span>
          )}
        </button>
        <button className="icon-btn show-sm" aria-label="切换深浅色主题" onClick={() => setTheme(state.theme === 'light' ? 'dark' : 'light')}>
          {state.theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
        </button>
        <div style={{ position: 'relative' }} ref={ref}>
          <button
            className="icon-btn"
            aria-label={`通知${unread ? `，${unread} 条未读` : ''}`}
            aria-expanded={open}
            onClick={() => {
              setOpen((o) => !o);
              if (!open) window.setTimeout(readNotices, 1200);
            }}
          >
            <Bell size={18} />
            {unread > 0 && <span className="dot" />}
          </button>
          {open && (
            <div className="popover" role="dialog" aria-label="通知">
              <div className="popover-head">
                通知
                <span className="subtle" style={{ fontWeight: 400, fontSize: 12 }}>
                  任务完成、积分变动与系统消息
                </span>
              </div>
              <div className="popover-list">
                {state.notices.map((n) => (
                  <div className="notif" key={n.id}>
                    <span className="ico" style={{ background: n.kind === 'ok' ? 'var(--accent-soft)' : n.kind === 'err' ? 'var(--danger-soft)' : 'var(--accent-2-soft)', color: n.kind === 'ok' ? 'var(--ok)' : n.kind === 'err' ? 'var(--danger)' : 'var(--accent-2)' }}>
                      {n.kind === 'ok' ? <CheckCircle2 size={15} /> : n.kind === 'err' ? <AlertCircle size={15} /> : <Info size={15} />}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: n.read ? 400 : 600 }}>{n.title}</div>
                      <small>
                        {n.body} · {timeAgo(n.time)}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <span className="avatar" aria-label="当前用户：林夏">
          林
        </span>
      </div>
    </header>
  );
}
