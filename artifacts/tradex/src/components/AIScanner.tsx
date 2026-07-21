import { useState, useRef, useCallback, useEffect } from "react";
import { OAUTH_APP_ID, useAuth } from "../context/AuthContext";
import { X, Radio } from "lucide-react";

const WS_URL = `wss://api.derivws.com/trading/v1/options/ws/public`;

const MARKETS = [
  { symbol: "R_10",     name: "Volatility 10 Index" },
  { symbol: "R_25",     name: "Volatility 25 Index" },
  { symbol: "R_50",     name: "Volatility 50 Index" },
  { symbol: "R_75",     name: "Volatility 75 Index" },
  { symbol: "R_100",    name: "Volatility 100 Index" },
  { symbol: "1HZ10V",   name: "Volatility 10 (1s) Index" },
  { symbol: "1HZ25V",   name: "Volatility 25 (1s) Index" },
  { symbol: "1HZ50V",   name: "Volatility 50 (1s) Index" },
  { symbol: "1HZ75V",   name: "Volatility 75 (1s) Index" },
  { symbol: "1HZ100V",  name: "Volatility 100 (1s) Index" },
];

function getLastDigit(price: number): number {
  return parseInt(price.toFixed(2).slice(-1));
}

interface ScanResult {
  market: string;
  symbol: string;
  ovPct: number;
  unPct: number;
  score: number;
  tradeType: string;
  contractType: "DIGITOVER" | "DIGITUNDER";
  barrier: number;
}

export default function AIScanner() {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"ov1un8" | "ov2un7">("ov1un8");
  const [scanDepth, setScanDepth] = useState("3000");
  const [mode, setMode] = useState("01-08");
  const [ticks, setTicks] = useState("3000");
  const [selectedMarket, setSelectedMarket] = useState("Scan to find the best market");
  const [tradeType, setTradeType] = useState("Waiting for scan");
  const [scanning, setScanning] = useState(false);
  const [statusText, setStatusText] = useState("Ready to scan markets");
  const [progress, setProgress] = useState(0);
  const [lastResult, setLastResult] = useState<ScanResult | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const resultsRef = useRef<Record<string, number[]>>({});
  const pendingRef = useRef<Set<string>>(new Set());

  // --- Trade execution (separate authenticated socket, per AuthContext's OTP pattern) ---
  const { activeAccount } = useAuth();
  const [stake, setStake] = useState("1");
  const [duration, setDuration] = useState("1");
  const [firingTrade, setFiringTrade] = useState(false);
  const [tradeStatus, setTradeStatus] = useState<string | null>(null);
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);
  const authWsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    return () => {
      authWsRef.current?.close();
    };
  }, []);

  const openAuthenticatedSocket = useCallback((): Promise<WebSocket> => {
    return new Promise((resolve, reject) => {
      if (authWsRef.current && authWsRef.current.readyState === WebSocket.OPEN) {
        resolve(authWsRef.current);
        return;
      }
      if (!activeAccount) {
        reject(new Error("No active Deriv account — please log in"));
        return;
      }
      fetch(
        `https://api.derivws.com/trading/v1/options/accounts/${activeAccount.account}/otp`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${activeAccount.token}`,
            "Deriv-App-ID": OAUTH_APP_ID,
          },
        }
      )
        .then((res) => {
          if (!res.ok) throw new Error(`OTP request failed (${res.status})`);
          return res.json();
        })
        .then((json) => {
          const ws = new WebSocket(json.data.url);
          authWsRef.current = ws;
          ws.onopen = () => resolve(ws);
          ws.onerror = () => reject(new Error("Authenticated socket connection failed"));
        })
        .catch(reject);
    });
  }, [activeAccount]);

  const fireTrade = useCallback(async () => {
    if (!lastResult || firingTrade) return;
    setFiringTrade(true);
    setTradeStatus("Connecting to your account...");
    try {
      const ws = await openAuthenticatedSocket();
      setTradeStatus(`Placing ${lastResult.contractType === "DIGITOVER" ? "Over" : "Under"} ${lastResult.barrier} on ${lastResult.market}...`);

      const reqId = Math.floor(Math.random() * 1_000_000);
      const buyResult = await new Promise<any>((resolve, reject) => {
        const onMsg = (event: MessageEvent) => {
          try {
            const data = JSON.parse(event.data);
            if (data.req_id !== reqId) return;
            ws.removeEventListener("message", onMsg);
            if (data.error) reject(new Error(data.error.message || "Trade rejected"));
            else resolve(data);
          } catch {
            /* ignore unrelated frames */
          }
        };
        ws.addEventListener("message", onMsg);

        ws.send(
          JSON.stringify({
            buy: 1,
            price: Number(stake) || 1,
            req_id: reqId,
            parameters: {
              amount: Number(stake) || 1,
              basis: "stake",
              contract_type: lastResult.contractType,
              currency: activeAccount?.currency || "USD",
              duration: Number(duration) || 1,
              duration_unit: "t",
              symbol: lastResult.symbol,
              barrier: String(lastResult.barrier),
            },
          })
        );
      });

      setTradeStatus(`✓ Trade placed — contract ${buyResult.buy?.contract_id}`);
    } catch (err: any) {
      setTradeStatus(`⚠ ${err.message || "Trade failed"}`);
    } finally {
      setFiringTrade(false);
    }
  }, [lastResult, firingTrade, openAuthenticatedSocket, stake, duration, activeAccount]);

  useEffect(() => {
    if (activeTab === "ov1un8") {
      setMode("01-08");
    } else {
      setMode("02-07");
    }
  }, [activeTab]);

  const closeWs = () => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  };

  const analyzeResults = useCallback(() => {
    const isOv1 = activeTab === "ov1un8";
    const ovThreshold = isOv1 ? 1 : 2;
    const unThreshold = isOv1 ? 8 : 7;

    let best: ScanResult | null = null;

    for (const mkt of MARKETS) {
      const digits = resultsRef.current[mkt.symbol];
      if (!digits || digits.length < 50) continue;

      const total = digits.length;
      const ovCount = digits.filter(d => d > ovThreshold).length;
      const unCount = digits.filter(d => d < unThreshold).length;
      const ovPct = (ovCount / total) * 100;
      const unPct = (unCount / total) * 100;
      const score = (ovPct + unPct) / 2;

      // Determine which trade type is better for this market
      let tradeT = "";
      let contractType: "DIGITOVER" | "DIGITUNDER";
      let barrier: number;
      if (ovPct >= unPct) {
        contractType = "DIGITOVER";
        barrier = ovThreshold;
        tradeT = isOv1 ? `Over 1 (${ovPct.toFixed(1)}%)` : `Over 2 (${ovPct.toFixed(1)}%)`;
      } else {
        contractType = "DIGITUNDER";
        barrier = unThreshold;
        tradeT = isOv1 ? `Under 8 (${unPct.toFixed(1)}%)` : `Under 7 (${unPct.toFixed(1)}%)`;
      }

      if (!best || score > best.score) {
        best = { market: mkt.name, symbol: mkt.symbol, ovPct, unPct, score, tradeType: tradeT, contractType, barrier };
      }
    }

    if (best) {
      setLastResult(best);
      setSelectedMarket(best.market);
      setTradeType(best.tradeType);
      setStatusText(`✓ Best market found — ${best.market} with score ${best.score.toFixed(1)}%`);
    } else {
      setStatusText("⚠ Insufficient data — retry scan");
    }
  }, [activeTab]);

  const runDeepScan = useCallback(() => {
    if (scanning) return;
    setScanning(true);
    setProgress(0);
    setStatusText("Connecting to Deriv WebSocket...");
    setSelectedMarket("Scanning markets...");
    setTradeType("Scanning...");
    setAwaitingConfirm(false);
    setTradeStatus(null);
    resultsRef.current = {};
    pendingRef.current = new Set(MARKETS.map(m => m.symbol));

    closeWs();

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    const count = Math.min(parseInt(ticks) || 500, 2000);
    let sent = 0;
    let received = 0;

    ws.onopen = () => {
      setStatusText("Scanning markets for digit patterns...");
      for (const mkt of MARKETS) {
        ws.send(JSON.stringify({
          ticks_history: mkt.symbol,
          count,
          end: "latest",
          style: "ticks",
          req_id: sent++,
        }));
      }
    };

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.history && data.history.prices) {
          const symbol = data.echo_req?.ticks_history as string;
          if (symbol) {
            const digits = (data.history.prices as number[]).map(getLastDigit);
            resultsRef.current[symbol] = digits;
            pendingRef.current.delete(symbol);
            received++;
            const pct = Math.round((received / MARKETS.length) * 100);
            setProgress(pct);
            setStatusText(`Scanning... ${received}/${MARKETS.length} markets processed`);

            if (pendingRef.current.size === 0) {
              analyzeResults();
              setScanning(false);
              closeWs();
            }
          }
        }
        if (data.error) {
          const sym = data.echo_req?.ticks_history as string;
          if (sym) {
            pendingRef.current.delete(sym);
            received++;
            if (pendingRef.current.size === 0) {
              analyzeResults();
              setScanning(false);
              closeWs();
            }
          }
        }
      } catch (_) {}
    };

    ws.onerror = () => {
      setStatusText("⚠ WebSocket error — check connection");
      setScanning(false);
    };

    ws.onclose = () => {
      if (scanning && pendingRef.current.size > 0) {
        analyzeResults();
        setScanning(false);
      }
    };

    // Safety timeout
    setTimeout(() => {
      if (wsRef.current === ws) {
        analyzeResults();
        setScanning(false);
        closeWs();
      }
    }, 20000);
  }, [scanning, ticks, analyzeResults]);

  return (
    <>
      {/* Floating AI Button */}
      <button
        data-testid="ai-scanner-button"
        onClick={() => setOpen(true)}
        className="fixed bottom-[68px] right-4 z-50 w-14 h-14 rounded-full bg-[#8B5CF6] hover:bg-[#7c3aed] shadow-lg hover:shadow-[#8B5CF6]/40 hover:shadow-xl flex items-center justify-center transition-all active:scale-95"
        aria-label="Open AI Scanner"
      >
        <span className="text-white font-bold text-sm tracking-wide">AI</span>
        {/* Online indicator */}
        <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-[#22C55E] border-2 border-white shadow-sm" />
      </button>

      {/* Modal */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/60 backdrop-blur-sm p-0 md:p-4"
          onClick={(e) => { if (e.target === e.currentTarget) { setOpen(false); setAwaitingConfirm(false); } }}
        >
          <div className="bg-card w-full md:max-w-md rounded-t-2xl md:rounded-2xl shadow-2xl overflow-hidden max-h-[92vh] flex flex-col border border-border">

            {/* Modal Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-card shrink-0">
              <h2 className="text-base font-bold text-foreground">Entry Scanner</h2>
              <button
                onClick={() => { setOpen(false); setAwaitingConfirm(false); }}
                className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-y-auto flex-1">
              {/* Hero Card */}
              <div className="m-4 rounded-xl overflow-hidden relative bg-gradient-to-br from-[#0f2744] via-[#0d2257] to-[#0a1a3e] p-5 shadow-inner">
                {/* Subtle animated rings */}
                <div className="absolute inset-0 overflow-hidden">
                  <div className="absolute -right-6 -top-6 w-36 h-36 rounded-full border border-white/5 animate-ping" style={{ animationDuration: "3s" }} />
                  <div className="absolute -right-3 -top-3 w-24 h-24 rounded-full border border-white/10 animate-ping" style={{ animationDuration: "2s" }} />
                </div>

                <div className="relative z-10 flex items-start justify-between gap-4">
                  <div className="flex-1">
                    {/* Badge */}
                    <div className="inline-flex items-center gap-1.5 bg-white/10 rounded-full px-3 py-1 mb-3">
                      <span className="text-[10px] text-white/80 font-semibold tracking-widest uppercase">Recovery Engine</span>
                    </div>

                    <h3 className="text-white text-lg font-bold leading-tight mb-1">TradeX AI Scanner</h3>
                    <p className="text-white/60 text-xs leading-relaxed">
                      Scans Over 1 and Under 8 with recovery confirmation
                    </p>
                  </div>

                  {/* Radar animation */}
                  <div className="shrink-0 w-16 h-16 relative flex items-center justify-center">
                    <div className="absolute inset-0 rounded-full border-2 border-[#8B5CF6]/40 animate-ping" style={{ animationDuration: "1.5s" }} />
                    <div className="absolute inset-2 rounded-full border border-[#22C55E]/30 animate-ping" style={{ animationDuration: "2s", animationDelay: "0.5s" }} />
                    <div className="w-10 h-10 rounded-full bg-[#8B5CF6]/20 border-2 border-[#8B5CF6] flex items-center justify-center">
                      <svg viewBox="0 0 24 24" className="w-5 h-5 text-[#8B5CF6]" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="2"/>
                        <path d="M16.24 7.76a6 6 0 0 1 0 8.49"/>
                        <path d="M7.76 16.24a6 6 0 0 1 0-8.49"/>
                        <path d="M20.07 3.93a10 10 0 0 1 0 16.14"/>
                        <path d="M3.93 20.07a10 10 0 0 1 0-16.14"/>
                      </svg>
                    </div>
                    {/* Sweep line */}
                    {scanning && (
                      <div
                        className="absolute inset-0 rounded-full overflow-hidden"
                        style={{ animation: "spin 2s linear infinite", transformOrigin: "center" }}
                      >
                        <div className="absolute top-0 left-1/2 w-0.5 h-1/2 bg-gradient-to-b from-[#22C55E] to-transparent origin-bottom" />
                      </div>
                    )}
                  </div>
                </div>

                {/* Progress bar */}
                {scanning && (
                  <div className="mt-4 h-1 bg-white/10 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-[#8B5CF6] to-[#22C55E] transition-all duration-500"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                )}
              </div>

              {/* Tabs */}
              <div className="flex gap-2 mx-4 mb-4">
                {(["ov1un8", "ov2un7"] as const).map(tab => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    data-testid={`scanner-tab-${tab}`}
                    className={`flex-1 py-2 text-sm font-bold rounded-lg border transition-all ${
                      activeTab === tab
                        ? "bg-primary border-primary text-white shadow-sm"
                        : "bg-secondary border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {tab === "ov1un8" ? "OV 1 / UN 8" : "OV 2 / UN 7"}
                  </button>
                ))}
              </div>

              <div className="px-4 space-y-4 pb-4">
                {/* Trade parameters */}
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: "Stake (USD)", val: stake, set: setStake, id: "stake" },
                    { label: "Duration (ticks)", val: duration, set: setDuration, id: "duration" },
                  ].map(({ label, val, set, id }) => (
                    <div key={id} className="space-y-1">
                      <label className="text-xs text-muted-foreground font-medium">{label}</label>
                      <input
                        data-testid={`scanner-${id}`}
                        value={val}
                        onChange={e => set(e.target.value)}
                        className="w-full h-9 bg-background border border-border rounded-lg px-2 text-sm text-foreground text-center font-mono focus:outline-none focus:border-primary"
                      />
                    </div>
                  ))}
                </div>

                {/* Three inputs */}
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: "Scan Depth", val: scanDepth, set: setScanDepth, id: "scan-depth" },
                    { label: "Mode", val: mode, set: setMode, id: "mode" },
                    { label: "Ticks", val: ticks, set: setTicks, id: "ticks" },
                  ].map(({ label, val, set, id }) => (
                    <div key={id} className="space-y-1">
                      <label className="text-xs text-muted-foreground font-medium">{label}</label>
                      <input
                        data-testid={`scanner-${id}`}
                        value={val}
                        onChange={e => set(e.target.value)}
                        className="w-full h-9 bg-background border border-border rounded-lg px-2 text-sm text-foreground text-center font-mono focus:outline-none focus:border-primary"
                      />
                    </div>
                  ))}
                </div>

                {/* Two wider fields */}
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground font-medium">Selected Market</label>
                  <div
                    data-testid="scanner-selected-market"
                    className={`w-full h-10 bg-background border border-border rounded-lg px-3 text-sm flex items-center font-medium transition-colors ${
                      scanning ? "text-[#FACC15] animate-pulse" :
                      lastResult ? "text-[#22C55E]" : "text-muted-foreground"
                    }`}
                  >
                    {selectedMarket}
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground font-medium">Trade Type</label>
                  <div
                    data-testid="scanner-trade-type"
                    className={`w-full h-10 bg-background border border-border rounded-lg px-3 text-sm flex items-center font-semibold transition-colors ${
                      scanning ? "text-[#FACC15] animate-pulse" :
                      lastResult ? "text-primary" : "text-muted-foreground"
                    }`}
                  >
                    {tradeType}
                  </div>
                </div>

                {/* Status row */}
                <div className="flex items-center gap-2 py-2">
                  <Radio className={`w-4 h-4 shrink-0 ${scanning ? "text-[#22C55E] animate-pulse" : lastResult ? "text-[#22C55E]" : "text-muted-foreground"}`} />
                  <span className={`text-xs ${scanning ? "text-[#22C55E]" : "text-muted-foreground"}`}>
                    {statusText}
                  </span>
                </div>

                {/* Action Buttons */}
                <div className="grid grid-cols-2 gap-3 pt-1 pb-2">
                  <button
                    data-testid="scanner-deep-scan"
                    onClick={runDeepScan}
                    disabled={scanning}
                    className={`h-11 rounded-xl font-bold text-sm text-white transition-all flex items-center justify-center gap-2 ${
                      scanning
                        ? "bg-primary/60 cursor-not-allowed"
                        : "bg-primary hover:bg-primary/90 shadow-sm hover:shadow-md active:scale-95"
                    }`}
                  >
                    {scanning ? (
                      <>
                        <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                        Scanning...
                      </>
                    ) : (
                      <>
                        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <circle cx="11" cy="11" r="8"/>
                          <path d="m21 21-4.35-4.35"/>
                        </svg>
                        Deep Scan Markets
                      </>
                    )}
                  </button>

                  <button
                    data-testid="scanner-load-scan"
                    onClick={() => setAwaitingConfirm(true)}
                    disabled={!lastResult || firingTrade || awaitingConfirm}
                    className={`h-11 rounded-xl font-bold text-sm border-2 transition-all flex items-center justify-center gap-2 ${
                      lastResult && !firingTrade && !awaitingConfirm
                        ? "border-primary text-primary hover:bg-primary/10 active:scale-95"
                        : "border-border text-muted-foreground cursor-not-allowed"
                    }`}
                  >
                    {firingTrade ? (
                      <>
                        <span className="w-4 h-4 border-2 border-primary/40 border-t-primary rounded-full animate-spin" />
                        Placing...
                      </>
                    ) : (
                      "Load Scan"
                    )}
                  </button>
                </div>

                {awaitingConfirm && lastResult && (
                  <div
                    data-testid="scanner-confirm-bar"
                    className="rounded-xl border border-primary/40 bg-primary/5 p-3 space-y-2"
                  >
                    <p className="text-xs text-foreground font-medium">
                      Confirm: {lastResult.contractType === "DIGITOVER" ? "Over" : "Under"} {lastResult.barrier} on {lastResult.market}, stake ${stake || "0"}, {duration || "0"} tick(s)?
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        data-testid="scanner-confirm-trade"
                        onClick={() => {
                          setAwaitingConfirm(false);
                          fireTrade();
                        }}
                        className="h-9 rounded-lg bg-primary text-white text-sm font-bold hover:bg-primary/90 active:scale-95 transition-all"
                      >
                        Confirm Trade
                      </button>
                      <button
                        data-testid="scanner-cancel-trade"
                        onClick={() => setAwaitingConfirm(false)}
                        className="h-9 rounded-lg border border-border text-muted-foreground text-sm font-bold hover:text-foreground transition-all"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {tradeStatus && (
                  <div
                    data-testid="scanner-trade-status"
                    className={`text-xs px-1 pb-2 ${tradeStatus.startsWith("✓") ? "text-[#22C55E]" : tradeStatus.startsWith("⚠") ? "text-red-500" : "text-muted-foreground"}`}
                  >
                    {tradeStatus}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
