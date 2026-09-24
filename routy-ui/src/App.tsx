import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { Header } from "./components/Header";
import { LoginGate } from "./components/LoginGate";
import { MobileNav } from "./components/MobileNav";
import { Sidebar } from "./components/Sidebar";
import { ToastProvider } from "./components/ui/Toast";
import { CliTools } from "./screens/CliTools";
import { Combos } from "./screens/Combos";
import { ConsoleLog } from "./screens/ConsoleLog";
import { Overview } from "./screens/Overview";
import { ProxyPools } from "./screens/ProxyPools";
import { ProviderDetail } from "./screens/ProviderDetail";
import { Settings } from "./screens/Settings";
import { Stub } from "./screens/Stub";
import { TokenSaver } from "./screens/TokenSaver";
import { Upstreams } from "./screens/Upstreams";
import { Usage } from "./screens/Usage";
import { initTheme } from "./hooks/useTheme";

/* Before first paint: a mode applied from an effect renders one frame of the wrong
   palette, which is how "dark text on the light canvas" gets reported. */
initTheme();

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5000, retry: 1, refetchOnWindowFocus: false } },
});

/**
 * The gateway serves this bundle at both `/` and `/ui/*`, so the router has to know
 * which mount it is under. Without this, `/ui/settings` is seen as a path the router
 * does not know and falls through to the catch-all screen.
 */
const basename = window.location.pathname.startsWith("/ui") ? "/ui" : "/";

/**
 * The shell owns the mobile nav state: below `lg` the rail is display:none, so without
 * the drawer there is no way to change screen at all on a phone.
 *
 * h-dvh, not h-screen: iOS sizes 100vh against the *large* viewport, so with the URL bar
 * showing, the bottom of the dashboard sat underneath it and `overflow-hidden` meant
 * nothing could be scrolled to reveal it.
 */
function Shell() {
  const { pathname } = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  // Choosing a screen has to put the drawer away, or the new page opens behind an open
  // panel and the close button is the only way out.
  useEffect(() => setNavOpen(false), [pathname]);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-bg">
      {/* Sidebar - desktop rail */}
      <div className="hidden w-72 shrink-0 lg:flex">
        <Sidebar />
      </div>

      {/* Main content */}
      <main className="flex flex-col flex-1 h-full min-w-0 relative transition-colors duration-300 isolate">
        {/* Faint grid background */}
        <div className="landing-grid absolute inset-0 pointer-events-none -z-10" aria-hidden="true" />
        <Header onMenu={() => setNavOpen(true)} />
        {/* p-3 on phones: the panels assume a p-10 gutter, which on 390px spends a fifth
            of the width on padding. pb honours the iOS home indicator. */}
        <div className="flex-1 min-w-0 overflow-y-auto overscroll-contain custom-scrollbar p-3 sm:p-6 lg:p-10 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="max-w-7xl mx-auto">
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/upstreams" element={<Upstreams />} />
              <Route path="/upstreams/:id" element={<ProviderDetail />} />
              <Route path="/usage" element={<Usage />} />
              <Route path="/console" element={<ConsoleLog />} />
              <Route path="/combos" element={<Combos />} />
              <Route path="/pools" element={<ProxyPools />} />
              <Route path="/cli-tools" element={<CliTools />} />
              <Route path="/token-saver" element={<TokenSaver />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Stub />} />
            </Routes>
          </div>
        </div>
      </main>

      <MobileNav open={navOpen} onClose={() => setNavOpen(false)} />
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        {/* Outside the router: the gate must come up before any screen mounts, so a
            locked dashboard never flashes empty cards and failed requests. */}
        <LoginGate>
          <BrowserRouter basename={basename}>
            <Shell />
          </BrowserRouter>
        </LoginGate>
      </ToastProvider>
    </QueryClientProvider>
  );
}
