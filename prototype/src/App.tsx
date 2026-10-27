import { AssetViewer } from './components/AssetViewer';
import { NavRail, TabBar, TopBar } from './components/Shell';
import { Toasts } from './components/ui';
import { useRoute } from './lib/router';
import { Admin } from './pages/Admin';
import { Assets } from './pages/Assets';
import { Canvas } from './pages/Canvas';
import { Explore } from './pages/Explore';
import { Pricing } from './pages/Pricing';
import { Projects } from './pages/Projects';
import { Studio } from './pages/Studio';
import { Templates } from './pages/Templates';

export function App() {
  const route = useRoute();
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
      <Toasts />
    </div>
  );
}
