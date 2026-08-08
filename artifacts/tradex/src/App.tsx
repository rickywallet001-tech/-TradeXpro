import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { ThemeProvider } from "@/components/ThemeProvider";
import { AuthProvider } from "@/context/AuthContext";
import { BotProvider } from "@/context/BotContext";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import Navbar from "@/components/Navbar";
import AIScanner from "@/components/AIScanner";
import SmartTraderAIChat from "@/components/SmartTraderAIChat";
import RiskDisclaimer from "@/components/risk-disclaimer/risk-disclaimer";
import LoadingScreen from "@/components/LoadingScreen";
import BotBuilderFrame from "@/pages/BotBuilderFrame";
import ChartsEmbed from "@/pages/chart/charts-embed";
import { useState } from "react";

import Dashboard from "@/pages/Dashboard";

import ManualTraders from "@/pages/ManualTraders";
import BulkTrader from "@/pages/BulkTrader/BulkTrader";

import TradingBots from "@/pages/TradingBots";
import SmartTrader from "@/pages/SmartTrader";
import Strategies from "@/pages/Strategies";
import CopyTrading from "@/pages/CopyTrading";
import TradingView from "@/pages/TradingView";
import Callback from "@/pages/Callback";

const queryClient = new QueryClient();

function AppContent() {
  const [loading, setLoading] = useState(true);
  const location = useLocation();
  const [navHeight, setNavHeight] = useState(80); // sensible default before first measurement

  useEffect(() => {
    // Navbar renders its own position:fixed <nav> internally -- observing
    // that actual element directly, rather than wrapping it in another
    // fixed container (which would measure as zero height, since a
    // position:fixed child is taken out of its parent's normal-flow
    // layout and doesn't contribute to the parent's own height).
    const navEl = document.querySelector("nav");
    if (!navEl) return;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height;
      if (height) setNavHeight(height);
    });
    observer.observe(navEl);
    return () => observer.disconnect();
  }, [loading]);

  if (loading) {
    return <LoadingScreen onComplete={() => setLoading(false)} />;
  }

  return (
    <div
      className="h-dvh w-full bg-background text-foreground font-sans flex flex-col"
      style={{ paddingTop: navHeight }}
    >
      <Navbar />
      <main className="flex-1 flex flex-col w-full h-full overflow-y-auto">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/botbuilder" element={<BotBuilderFrame />} />
          <Route path="/manualtraders" element={<ManualTraders />} />
          <Route path="/smarttrader" element={<SmartTrader />} />
          <Route path="/bulktrader" element={<BulkTrader />} />
          <Route path="/charts" element={<ChartsEmbed />} />
          <Route path="/tradingbots" element={<TradingBots />} />
          <Route path="/analysistool" element={<Navigate to="/smarttrader" replace />} />
          <Route path="/strategies" element={<Strategies />} />
          <Route path="/copytrading" element={<CopyTrading />} />
          <Route path="/tradingview" element={<TradingView />} />
          <Route path="/callback" element={<Callback />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>
      <AIScanner />
      <RiskDisclaimer />
      {location.pathname === "/smarttrader" && <SmartTraderAIChat />}
    </div>
  );
}

function App() {
  return (
    <ThemeProvider defaultTheme="light" storageKey="tradex-theme-v3">
      <AuthProvider>
        <BotProvider>
          <QueryClientProvider client={queryClient}>
            <TooltipProvider>
              <BrowserRouter>
                <AppContent />
              </BrowserRouter>
              <Toaster />
            </TooltipProvider>
          </QueryClientProvider>
        </BotProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
