import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { ToastProvider } from "./components/ui/Toast";
import { Combos } from "./screens/Combos";
import { ConsoleLog } from "./screens/ConsoleLog";
import { Overview } from "./screens/Overview";
import { ProxyPools } from "./screens/ProxyPools";
import { Settings } from "./screens/Settings";
import { Stub } from "./screens/Stub";
import { ThemeSampler } from "./screens/ThemeSampler";
import { TokenSaver } from "./screens/TokenSaver";
import { Upstreams } from "./screens/Upstreams";
import { Usage } from "./screens/Usage";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5000, retry: 1, refetchOnWindowFocus: false } },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <div className="flex h-screen w-full overflow-hidden bg-bg">
            {/* Sidebar - desktop */}
            <div className="hidden lg:flex">
              <Sidebar />
            </div>

            {/* Main content */}
            <main className="flex flex-col flex-1 h-full min-w-0 relative transition-colors duration-300 isolate">
              {/* Faint grid background */}
              <div className="landing-grid absolute inset-0 pointer-events-none -z-10" aria-hidden="true" />
              <Header />
              <div className="flex-1 overflow-y-auto custom-scrollbar p-6 lg:p-10">
                <div className="max-w-7xl mx-auto">
                  <Routes>
                    <Route path="/" element={<Overview />} />
                    <Route path="/upstreams" element={<Upstreams />} />
                    <Route path="/usage" element={<Usage />} />
                    <Route path="/console" element={<ConsoleLog />} />
                    <Route path="/combos" element={<Combos />} />
                    <Route path="/pools" element={<ProxyPools />} />
                    <Route path="/token-saver" element={<TokenSaver />} />
                    <Route path="/settings" element={<Settings />} />
                    <Route path="/theme" element={<ThemeSampler />} />
                    <Route path="*" element={<Stub />} />
                  </Routes>
                </div>
              </div>
            </main>
          </div>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
