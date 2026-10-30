import { AssetViewer } from './components/AssetViewer';
import { ImageEditor } from './components/ImageEditor';
import { NavRail, TabBar, TopBar } from './components/Shell';
import { Toasts } from './components/ui';
import { useEffect, useState } from 'react';
import { track } from './lib/analytics';
import { useRoute } from './lib/router';
import { useStore } from './lib/store';
import { Login } from './pages/Login';
import { Admin } from './pages/Admin';
import { Assets } from './pages/Assets';
import { Canvas } from './pages/Canvas';
import { Explore } from './pages/Explore';
import { Pricing } from './pages/Pricing';
import { Projects } from './pages/Projects';
import { SharedCanvas } from './pages/SharedCanvas';
import { Studio } from './pages/Studio';
import { Templates } from './pages/Templates';

/** 分享页地址：#s/<令牌>，无需登录 */
function useShareToken(): string | null {
  const read = () => /^#s\/([A-Za-z0-9_-]{16,64})$/.exec(window.location.hash)?.[1] ?? null;
  const [token, setToken] = useState(read);
  useEffect(() => {
    const on = () => setToken(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return token;
}

export function App() {
  const { state } = useStore();
  const share = useShareToken();
  if (share)
    return (
      <>
        <SharedCanvas token={share} />
        <Toasts />
      </>
    );
  if (state.auth === 'pending') return <div className="splash">正在连接造物…</div>;
  if (state.auth === 'anon')
    return (
      <>
        <Login />
        <Toasts />
      </>
    );
  return <Workspace />;
}

function Workspace() {
  const route = useRoute();
  const page = route.name === 'studio' ? `studio-${route.mode}` : route.name;
  useEffect(() => track({ name: 'page_view', props: { page } }), [page]);
  // 工作台与画布是满屏布局，内部自行滚动
  const fullBleed = route.name === 'studio' || route.name === 'canvas';

  return (
    <div className="app">
      <NavRail route={route} />
      <div className="main">
        <TopBar route={route} />
        <main className="content" style={fullBleed ? { overflow: route.name === 'canvas' ? 'hidden' : undefined } : undefined}>
          {route.name === 'explore' && <Explore />}
          {route.name === 'studio' && <Studio key={route.mode} mode={route.mode} />}
          {route.name === 'canvas' && <Canvas />}
          {route.name === 'assets' && <Assets />}
          {route.name === 'templates' && <Templates />}
          {route.name === 'projects' && <Projects />}
          {route.name === 'pricing' && <Pricing />}
          {route.name === 'admin' && <Admin />}
        </main>
      </div>
      <TabBar route={route} />
      <AssetViewer />
      <ImageEditor />
      <Toasts />
    </div>
  );
}
