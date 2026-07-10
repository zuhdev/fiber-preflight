import {
  Activity,
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  CircleSlash,
  ClipboardList,
  Copy,
  Download,
  ExternalLink,
  FileJson,
  History,
  Play,
  RefreshCw,
  Route,
  ShieldAlert,
  SlidersHorizontal,
  Trash2,
  Upload,
  Wrench
} from "lucide-react";
import {
  DEFAULT_RPC_TIMEOUT_MS,
  FiberRpcClient,
  FixtureRpc,
  buildSupportBundle,
  compactHash,
  explainPayment,
  inspectChannels,
  inspectNodeStatus,
  parseSupportBundleJson,
  probeRouteOptions,
  reportToMarkdown,
  routeProbeToMarkdown,
  runInvoicePreflight,
  supportBundleReport,
  type ChannelInventoryReport,
  type CheckResult,
  type FixtureScenario,
  type LiquidityInsight,
  type NodeStatusReport,
  type PreflightReport,
  type RoutePathSummary,
  type RouteProbeReport,
  type RouteSummary,
  type RunbookPlan,
  type RunbookStep,
  type SupportBundle
} from "@fiber-preflight/core";
import { useMemo, useState } from "react";
import { demoScenarios, storyForScenario, type DemoStory } from "./demoScenarios.js";
import {
  clearReportHistory,
  createReportHistoryItem,
  loadReportHistory,
  saveReportHistory,
  upsertReportHistory,
  type ReportHistoryItem,
  type ReportHistoryReport
} from "./history.js";

type Mode = "check" | "explain" | "probe";
type Source = "demo" | "live";

interface LiveTestRun {
  generatedAt: string;
  rpcUrl: string;
  steps: LiveTestStep[];
  status?: NodeStatusReport;
  channels?: ChannelInventoryReport;
  preflight?: PreflightReport;
  probe?: RouteProbeReport;
}

interface LiveTestStep {
  label: string;
  status: CheckResult["status"];
  detail: string;
}

const statusIcon = {
  pass: CheckCircle2,
  warn: AlertTriangle,
  fail: ShieldAlert,
  info: Activity,
  skip: CircleSlash
};

const TESTNET_PROOF = {
  channelId: "0xb03c6afeef30227de285309c9c4fc968eb1467f3818bec81211b15f12437dbfb",
  channelOutpoint: "0x2c3240e3d8592c1ef959c7008a4b3f5b5253a4de9d3dd075b3ed79a24f246f3500000000",
  fundingTx: "0x2c3240e3d8592c1ef959c7008a4b3f5b5253a4de9d3dd075b3ed79a24f246f35",
  nodeAFaucetTx: "0x9b4e9543f18d940bc1e9e6f9a86f16bd5a1024d58f02c1400f204b0c2ed351c6",
  nodeCFaucetTx: "0xe552573531d457a65616ea7cde64c21dbf580a8c98caf17396f17632d36e432f",
  proofDocUrl: "https://github.com/zuhdev/fiber-preflight/blob/main/docs/testnet-proof.md"
};

export function App() {
  const [mode, setMode] = useState<Mode>("check");
  const [source, setSource] = useState<Source>("demo");
  const [scenarioName, setScenarioName] = useState(demoScenarios[0]?.name ?? "");
  const [rpcUrl, setRpcUrl] = useState("http://127.0.0.1:8227");
  const [apiUrl, setApiUrl] = useState("http://127.0.0.1:8787");
  const [useApiProxy, setUseApiProxy] = useState(true);
  const [token, setToken] = useState("");
  const [timeoutMs, setTimeoutMs] = useState(String(DEFAULT_RPC_TIMEOUT_MS));
  const [invoice, setInvoice] = useState("");
  const [paymentHash, setPaymentHash] = useState("");
  const [amount, setAmount] = useState("");
  const [maxFeeRate, setMaxFeeRate] = useState("");
  const [maxParts, setMaxParts] = useState("");
  const [feeRates, setFeeRates] = useState("25,50,100,250");
  const [partOptions, setPartOptions] = useState("1,2,4,8,12");
  const [report, setReport] = useState<PreflightReport | undefined>();
  const [probeReport, setProbeReport] = useState<RouteProbeReport | undefined>();
  const [statusReport, setStatusReport] = useState<NodeStatusReport | undefined>();
  const [channelReport, setChannelReport] = useState<ChannelInventoryReport | undefined>();
  const [liveTest, setLiveTest] = useState<LiveTestRun | undefined>();
  const [history, setHistory] = useState<ReportHistoryItem[]>(() => loadReportHistory());
  const [bundleText, setBundleText] = useState("");
  const [importedBundle, setImportedBundle] = useState<SupportBundle | undefined>();
  const [busy, setBusy] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [liveTestBusy, setLiveTestBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const scenario = useMemo(
    () => demoScenarios.find((item) => item.name === scenarioName) ?? demoScenarios[0],
    [scenarioName]
  );
  const story = useMemo(() => storyForScenario(scenario), [scenario]);
  const activeVerdict = probeReport?.verdict ?? report?.verdict ?? importedBundle?.verdict;
  const activeScore = probeReport?.score ?? report?.score ?? importedBundle?.score;
  const activeVerdictClass = isPaymentVerdict(activeVerdict) ? activeVerdict : "unknown";

  async function run(selectedMode: Mode = mode) {
    setBusy(true);
    setError(undefined);
    setImportedBundle(undefined);
    setLiveTest(undefined);
    try {
      if (source === "live" && useApiProxy) {
        if (selectedMode === "probe") {
          const nextProbeReport = await postJson<RouteProbeReport>(`${apiUrl}/api/probes/route`, {
            rpcUrl,
            token: token || undefined,
            timeoutMs: timeoutMs.trim() || undefined,
            invoice: invoice.trim(),
            amount: amount.trim() || undefined,
            feeRates: splitCsv(feeRates),
            partOptions: splitCsv(partOptions)
          });
          showProbeReport(nextProbeReport, selectedMode);
          return;
        }

        const nextReport = selectedMode === "check"
          ? await postJson<PreflightReport>(`${apiUrl}/api/preflight/check`, {
              rpcUrl,
              token: token || undefined,
              timeoutMs: timeoutMs.trim() || undefined,
              invoice: invoice.trim(),
              amount: amount.trim() || undefined,
              maxFeeRate: maxFeeRate.trim() || undefined,
              maxParts: maxParts.trim() || undefined
            })
          : await postJson<PreflightReport>(`${apiUrl}/api/preflight/explain`, {
              rpcUrl,
              token: token || undefined,
              timeoutMs: timeoutMs.trim() || undefined,
              paymentHash: paymentHash.trim()
            });
        showPreflightReport(nextReport, selectedMode);
        return;
      }

      const rpc =
        source === "demo"
          ? new FixtureRpc(scenario)
          : new FiberRpcClient({
              url: rpcUrl,
              token: token || undefined,
              timeoutMs: timeoutMs.trim() || undefined
            });

      if (selectedMode === "check" || selectedMode === "probe") {
        const inputInvoice = source === "demo" ? stringFromScenario(scenario.input?.invoice) : invoice.trim();
        if (selectedMode === "probe") {
          const nextProbeReport = await probeRouteOptions(rpc, {
            invoice: inputInvoice,
            amount: amount.trim() || stringFromScenario(scenario.input?.amount),
            feeRates: splitCsv(feeRates),
            partOptions: splitCsv(partOptions)
          });
          showProbeReport(nextProbeReport, selectedMode);
          return;
        }

        const nextReport = await runInvoicePreflight(rpc, {
          invoice: inputInvoice,
          amount: amount.trim() || stringFromScenario(scenario.input?.amount),
          maxFeeRate: maxFeeRate.trim() || undefined,
          maxParts: maxParts.trim() || undefined
        });
        showPreflightReport(nextReport, selectedMode);
      } else {
        const hash =
          source === "demo" ? stringFromScenario(scenario.input?.paymentHash) : paymentHash.trim();
        if (!hash) throw new Error("Payment hash is required.");
        showPreflightReport(await explainPayment(rpc, { paymentHash: hash }), selectedMode);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runStory() {
    if (!story) return;
    setSource("demo");
    setMode(story.mode);
    await run(story.mode);
  }

  function showPreflightReport(nextReport: PreflightReport, selectedMode: Mode): void {
    setReport(nextReport);
    setProbeReport(undefined);
    rememberReport(nextReport, selectedMode);
  }

  function showProbeReport(nextReport: RouteProbeReport, selectedMode: Mode): void {
    setProbeReport(nextReport);
    setReport(undefined);
    rememberReport(nextReport, selectedMode);
  }

  function rememberReport(nextReport: ReportHistoryReport, selectedMode: Mode): void {
    const item = createReportHistoryItem(nextReport, {
      mode: selectedMode,
      source,
      scenarioName,
      rpcUrl
    });
    setHistory((current) => {
      const next = upsertReportHistory(current, item);
      saveReportHistory(next);
      return next;
    });
  }

  function loadHistoryItem(item: ReportHistoryItem): void {
    setError(undefined);
    setImportedBundle(undefined);
    setMode(item.mode);
    setSource(item.source);
    if (item.report.kind === "route-probe") {
      setProbeReport(item.report);
      setReport(undefined);
    } else {
      setReport(item.report);
      setProbeReport(undefined);
    }
  }

  function clearHistory(): void {
    clearReportHistory();
    setHistory([]);
  }

  function importSupportBundleText(text = bundleText): void {
    const trimmed = text.trim();
    if (!trimmed) {
      setError("Support bundle JSON is required.");
      return;
    }

    try {
      const bundle = parseSupportBundleJson(trimmed);
      const importedReport = supportBundleReport(bundle);
      if (!importedReport) throw new Error("Support bundle report is not viewable.");

      setImportedBundle(bundle);
      setError(undefined);

      if (importedReportKind(importedReport) === "route-probe") {
        setMode("probe");
        setProbeReport(importedReport as RouteProbeReport);
        setReport(undefined);
        return;
      }

      if (importedReportKind(importedReport) === "invoice-preflight") {
        setMode("check");
        setReport(importedReport as PreflightReport);
        setProbeReport(undefined);
        return;
      }

      if (importedReportKind(importedReport) === "payment-postmortem") {
        setMode("explain");
        setReport(importedReport as PreflightReport);
        setProbeReport(undefined);
        return;
      }

      if (importedReportKind(importedReport) === "node-status") {
        setStatusReport(importedReport as NodeStatusReport);
      }
      setReport(undefined);
      setProbeReport(undefined);
    } catch (err) {
      setImportedBundle(undefined);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function importSupportBundleFile(file: File | undefined): Promise<void> {
    if (!file) return;
    const text = await file.text();
    setBundleText(text);
    importSupportBundleText(text);
  }

  function clearImportedBundle(): void {
    setImportedBundle(undefined);
    setBundleText("");
    setReport(undefined);
    setProbeReport(undefined);
  }

  async function testConnection() {
    setStatusBusy(true);
    setError(undefined);
    try {
      const nextStatus = await fetchLiveStatus(invoice.trim() || undefined);
      setStatusReport(nextStatus);
    } catch (err) {
      setStatusReport(undefined);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStatusBusy(false);
    }
  }

  async function inspectLiveChannels(): Promise<ChannelInventoryReport> {
    const nextChannels =
      useApiProxy
        ? await postJson<ChannelInventoryReport>(`${apiUrl}/api/channels`, {
            ...liveConnectionBody(),
            includePending: true
          })
        : await inspectChannels(liveRpc(), { includePending: true });
    setChannelReport(nextChannels);
    return nextChannels;
  }

  async function runLiveTest() {
    setLiveTestBusy(true);
    setError(undefined);
    setImportedBundle(undefined);
    try {
      const sampleInvoice = invoice.trim() || undefined;
      const nextStatus = await fetchLiveStatus(sampleInvoice);
      const nextChannels = await inspectLiveChannels();
      const steps: LiveTestStep[] = [
        {
          label: "Fiber RPC",
          status: nextStatus.verdict === "blocked" ? "fail" : nextStatus.verdict === "limited" ? "warn" : "pass",
          detail: nextStatus.summary
        },
        {
          label: "Channels",
          status:
            nextChannels.totals.enabledReady > 0
              ? "pass"
              : (nextChannels.pendingChannels?.length ?? 0) > 0
                ? "warn"
                : "fail",
          detail: nextChannels.summary
        }
      ];

      let nextReport: PreflightReport | undefined;
      let nextProbeReport: RouteProbeReport | undefined;

      if (sampleInvoice) {
        nextReport = useApiProxy
          ? await postJson<PreflightReport>(`${apiUrl}/api/preflight/check`, {
              ...liveConnectionBody(),
              invoice: sampleInvoice,
              amount: amount.trim() || undefined,
              maxFeeRate: maxFeeRate.trim() || undefined,
              maxParts: maxParts.trim() || undefined
            })
          : await runInvoicePreflight(liveRpc(), {
              invoice: sampleInvoice,
              amount: amount.trim() || undefined,
              maxFeeRate: maxFeeRate.trim() || undefined,
              maxParts: maxParts.trim() || undefined
            });
        setReport(nextReport);
        rememberReport(nextReport, "check");
        steps.push({
          label: "Invoice",
          status: nextReport.verdict === "payable" ? "pass" : nextReport.verdict === "risky" ? "warn" : "fail",
          detail: nextReport.summary
        });

        nextProbeReport = useApiProxy
          ? await postJson<RouteProbeReport>(`${apiUrl}/api/probes/route`, {
              ...liveConnectionBody(),
              invoice: sampleInvoice,
              amount: amount.trim() || undefined,
              feeRates: splitCsv(feeRates),
              partOptions: splitCsv(partOptions)
            })
          : await probeRouteOptions(liveRpc(), {
              invoice: sampleInvoice,
              amount: amount.trim() || undefined,
              feeRates: splitCsv(feeRates),
              partOptions: splitCsv(partOptions)
            });
        setProbeReport(nextProbeReport);
        rememberReport(nextProbeReport, "probe");
        steps.push({
          label: "Route probe",
          status:
            nextProbeReport.verdict === "payable"
              ? "pass"
              : nextProbeReport.verdict === "risky"
                ? "warn"
                : "fail",
          detail: nextProbeReport.summary
        });
      } else {
        setReport(undefined);
        setProbeReport(undefined);
        steps.push({
          label: "Invoice",
          status: "skip",
          detail: "No invoice entered."
        });
      }

      setStatusReport(nextStatus);
      setLiveTest({
        generatedAt: new Date().toISOString(),
        rpcUrl,
        steps,
        status: nextStatus,
        channels: nextChannels,
        preflight: nextReport,
        probe: nextProbeReport
      });
    } catch (err) {
      setLiveTest(undefined);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLiveTestBusy(false);
    }
  }

  async function fetchLiveStatus(sampleInvoice?: string): Promise<NodeStatusReport> {
    return useApiProxy
      ? postJson<NodeStatusReport>(`${apiUrl}/api/status`, {
          ...liveConnectionBody(),
          sampleInvoice
        })
      : inspectNodeStatus(liveRpc(), { sampleInvoice });
  }

  function liveConnectionBody(): Record<string, unknown> {
    return {
      rpcUrl,
      token: token || undefined,
      timeoutMs: timeoutMs.trim() || undefined
    };
  }

  function liveRpc(): FiberRpcClient {
    return new FiberRpcClient({
      url: rpcUrl,
      token: token || undefined,
      timeoutMs: timeoutMs.trim() || undefined
    });
  }

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Fiber Preflight</p>
          <h1>Payment readiness and route diagnostics</h1>
        </div>
        <div className={`verdict ${activeVerdictClass}`}>
          <span>{activeVerdict ?? "idle"}</span>
          <strong>{activeScore !== undefined ? `${activeScore}/100` : "--"}</strong>
        </div>
      </section>

      <section className="workbench">
        <div className="controls">
          <div className="segmented mode-tabs" aria-label="Mode">
            <button className={mode === "check" ? "selected" : ""} onClick={() => setMode("check")}>
              <ClipboardList size={16} />
              Check
            </button>
            <button
              className={mode === "explain" ? "selected" : ""}
              onClick={() => setMode("explain")}
            >
              <Wrench size={16} />
              Explain
            </button>
            <button className={mode === "probe" ? "selected" : ""} onClick={() => setMode("probe")}>
              <SlidersHorizontal size={16} />
              Probe
            </button>
          </div>

          <div className="segmented" aria-label="Source">
            <button className={source === "demo" ? "selected" : ""} onClick={() => setSource("demo")}>
              <FileJson size={16} />
              Demo
            </button>
            <button className={source === "live" ? "selected" : ""} onClick={() => setSource("live")}>
              <Activity size={16} />
              Live RPC
            </button>
          </div>

          {source === "demo" ? (
            <label>
              Scenario
              <select
                value={scenarioName}
                onChange={(event) => {
                  setScenarioName(event.target.value);
                  setReport(undefined);
                  setProbeReport(undefined);
                  setError(undefined);
                }}
              >
                {demoScenarios.map((item) => (
                  <option key={item.name}>{item.name}</option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <label>
                RPC URL
                <input value={rpcUrl} onChange={(event) => setRpcUrl(event.target.value)} />
              </label>
              <label>
                RPC timeout (ms)
                <input
                  type="number"
                  min="0"
                  step="1000"
                  value={timeoutMs}
                  onChange={(event) => setTimeoutMs(event.target.value)}
                />
              </label>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={useApiProxy}
                  onChange={(event) => setUseApiProxy(event.target.checked)}
                />
                Use local API proxy
              </label>
              {useApiProxy && (
                <label>
                  API URL
                  <input value={apiUrl} onChange={(event) => setApiUrl(event.target.value)} />
                </label>
              )}
              <label>
                Biscuit token
                <input value={token} onChange={(event) => setToken(event.target.value)} />
              </label>
              <button className="secondary" onClick={testConnection} disabled={statusBusy}>
                {statusBusy ? <RefreshCw className="spin" size={16} /> : <Activity size={16} />}
                Test connection
              </button>
              <div className="live-actions">
                <button className="primary" onClick={runLiveTest} disabled={liveTestBusy}>
                  {liveTestBusy ? <RefreshCw className="spin" size={17} /> : <Play size={17} />}
                  Run live test
                </button>
                <button
                  className="secondary"
                  onClick={() => void inspectLiveChannels().catch((err) => {
                    setChannelReport(undefined);
                    setError(err instanceof Error ? err.message : String(err));
                  })}
                  disabled={liveTestBusy}
                >
                  <Route size={16} />
                  Channels
                </button>
              </div>
              {statusReport && <StatusPanel report={statusReport} />}
              {channelReport && <ChannelInventoryPanel report={channelReport} />}
            </>
          )}

          {source === "demo" && story && <StoryCard story={story} onRun={runStory} busy={busy} />}

          {source === "live" && (mode === "check" || mode === "probe") && (
            <>
              <label>
                Invoice
                <textarea value={invoice} onChange={(event) => setInvoice(event.target.value)} />
              </label>
              {mode === "check" ? (
                <div className="two-col">
                  <label>
                    Amount
                    <input value={amount} onChange={(event) => setAmount(event.target.value)} />
                  </label>
                  <label>
                    Max fee rate
                    <input value={maxFeeRate} onChange={(event) => setMaxFeeRate(event.target.value)} />
                  </label>
                </div>
              ) : (
                <label>
                  Amount
                  <input value={amount} onChange={(event) => setAmount(event.target.value)} />
                </label>
              )}
              {mode === "check" && (
                <label>
                  Max parts
                  <input value={maxParts} onChange={(event) => setMaxParts(event.target.value)} />
                </label>
              )}
            </>
          )}

          {mode === "probe" && (
            <div className="two-col">
              <label>
                Fee rates
                <input value={feeRates} onChange={(event) => setFeeRates(event.target.value)} />
              </label>
              <label>
                Part limits
                <input value={partOptions} onChange={(event) => setPartOptions(event.target.value)} />
              </label>
            </div>
          )}

          {source === "live" && mode === "explain" && (
            <label>
              Payment hash
              <input value={paymentHash} onChange={(event) => setPaymentHash(event.target.value)} />
            </label>
          )}

          <button className="primary" onClick={() => run()} disabled={busy}>
            {busy ? <RefreshCw className="spin" size={17} /> : <Play size={17} />}
            {mode === "probe" ? "Run probes" : "Run preflight"}
          </button>

          <SupportBundleImportPanel
            value={bundleText}
            hasBundle={Boolean(importedBundle)}
            onChange={setBundleText}
            onImport={() => importSupportBundleText()}
            onFile={(file) => void importSupportBundleFile(file)}
            onClear={clearImportedBundle}
          />

          {history.length > 0 && (
            <ReportHistoryPanel items={history} onLoad={loadHistoryItem} onClear={clearHistory} />
          )}
        </div>

        <div className="report">
          {error && <div className="error">{error}</div>}
          {importedBundle && <ImportedBundlePanel bundle={importedBundle} />}
          {liveTest && <LiveTestPanel run={liveTest} />}
          {source === "demo" && story && !importedBundle && !liveTest && <StoryPanel story={story} />}
          {!report && !probeReport && !error && !importedBundle && !liveTest && <EmptyReport />}
          {!report && !probeReport && importedBundle && <ImportedBundleReport bundle={importedBundle} />}
          {probeReport && <ProbeReportView report={probeReport} />}
          {report && <ReportView report={report} />}
        </div>
      </section>
    </main>
  );
}

function SupportBundleImportPanel({
  value,
  hasBundle,
  onChange,
  onImport,
  onFile,
  onClear
}: {
  value: string;
  hasBundle: boolean;
  onChange: (value: string) => void;
  onImport: () => void;
  onFile: (file: File | undefined) => void;
  onClear: () => void;
}) {
  return (
    <section className="bundle-import">
      <div className="section-title">
        <Upload size={18} />
        <h3>Import Bundle</h3>
      </div>
      <label>
        Bundle JSON
        <textarea
          className="bundle-textarea"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <label>
        Bundle file
        <input
          type="file"
          accept="application/json,.json"
          onChange={(event) => {
            onFile(event.currentTarget.files?.[0]);
            event.currentTarget.value = "";
          }}
        />
      </label>
      <div className="bundle-actions">
        <button className="secondary" onClick={onImport}>
          <FileJson size={16} />
          Load bundle
        </button>
        {hasBundle && (
          <button className="secondary" onClick={onClear}>
            <Trash2 size={16} />
            Clear bundle
          </button>
        )}
      </div>
    </section>
  );
}

function ImportedBundlePanel({ bundle }: { bundle: SupportBundle }) {
  return (
    <section className="bundle-panel">
      <div className="bundle-head">
        <FileJson size={18} />
        <div>
          <strong>Support Bundle</strong>
          <p>{bundle.summary ?? bundle.reportKind}</p>
        </div>
        <span>{bundle.source}</span>
      </div>
      <div className="bundle-stats">
        <div>
          <span>Report</span>
          <strong>{bundle.reportKind}</strong>
        </div>
        <div>
          <span>Generated</span>
          <strong>{formatBundleDate(bundle.generatedAt)}</strong>
        </div>
        <div>
          <span>Raw RPC</span>
          <strong>{bundle.privacy.rawRpcPayloadsIncluded ? "Included" : "Omitted"}</strong>
        </div>
      </div>
    </section>
  );
}

function ImportedBundleReport({ bundle }: { bundle: SupportBundle }) {
  const importedReport = supportBundleReport(bundle);
  if (isNodeStatusReport(importedReport)) {
    return (
      <section>
        <div className="section-title">
          <Activity size={18} />
          <h3>Node Status</h3>
        </div>
        <StatusPanel report={importedReport} />
      </section>
    );
  }

  if (isChannelInventoryReport(importedReport)) {
    return <ChannelInventoryPanel report={importedReport} />;
  }

  return (
    <section className="bundle-json-panel">
      <div className="section-title">
        <FileJson size={18} />
        <h3>Bundle Report</h3>
      </div>
      <pre>{JSON.stringify(bundle.report, null, 2)}</pre>
    </section>
  );
}

function ChannelInventoryPanel({ report }: { report: ChannelInventoryReport }) {
  const pendingChannels = report.pendingChannels ?? [];
  const diagnosticCount = pendingChannels.filter(
    (channel) => channel.failureDetail || channel.state === "Closed"
  ).length;
  return (
    <section className="route-band">
      <div className="route-head">
        <Activity size={18} />
        <strong>Channel Inventory</strong>
        <span>{report.totals.ready}/{report.totals.total} ready</span>
      </div>
      <div className="route-stats">
        <div>
          <span>Enabled ready</span>
          <strong>{report.totals.enabledReady}</strong>
        </div>
        <div>
          <span>CKB local</span>
          <strong>{report.totals.ckbLocalBalance}</strong>
        </div>
        <div>
          <span>Pending TLCs</span>
          <strong>{report.totals.pendingTlcCount}</strong>
        </div>
        {report.pendingChannels && (
          <div>
            <span>Funding history</span>
            <strong>{pendingChannels.length}</strong>
          </div>
        )}
      </div>
      <p className="bundle-summary">{report.summary}</p>
      {diagnosticCount > 0 && (
        <p className="history-note">
          {diagnosticCount} historical funding record{diagnosticCount === 1 ? "" : "s"} kept for diagnosis.
        </p>
      )}
      {pendingChannels.length > 0 && (
        <div className="pending-channel-list">
          {pendingChannels.map((channel) => (
            <div
              className={`pending-channel ${channel.failureDetail || channel.state === "Closed" ? "diagnostic" : ""}`}
              key={`${channel.channelId}-${channel.peer}`}
            >
              <div>
                <strong>{channel.channelId}</strong>
                <span>{channel.peer}</span>
              </div>
              <em>{channel.state}</em>
              <small>{channel.localBalance} local</small>
              {channel.failureDetail && <p>{channel.failureDetail}</p>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function LiveTestPanel({ run }: { run: LiveTestRun }) {
  return (
    <section className="live-test-panel">
      <div className="section-title">
        <Activity size={18} />
        <h3>Live Test Run</h3>
      </div>
      <div className="live-test-head">
        <div>
          <span>Endpoint</span>
          <strong>{run.rpcUrl}</strong>
        </div>
        <div>
          <span>Generated</span>
          <strong>{formatBundleDate(run.generatedAt)}</strong>
        </div>
      </div>
      <div className="proof-steps">
        {run.steps.map((step) => {
          const Icon = statusIcon[step.status];
          return (
            <article className={`proof-step ${step.status}`} key={step.label}>
              <Icon size={18} />
              <div>
                <strong>{step.label}</strong>
                <p>{step.detail}</p>
              </div>
            </article>
          );
        })}
      </div>
      <LiveTestnetProof run={run} />
      {run.status && (
        <div className="evidence-strip">
          {run.status.evidence.slice(0, 5).map((item) => (
            <div key={item.label}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>
      )}
      {run.channels && <ChannelInventoryPanel report={run.channels} />}
    </section>
  );
}

function LiveTestnetProof({ run }: { run: LiveTestRun }) {
  const readyChannel = run.channels?.channels.find(
    (channel) => channel.enabled && channel.state === "ChannelReady"
  );
  const fundingOutpoint = readyChannel?.channelOutpoint ?? TESTNET_PROOF.channelOutpoint;
  const fundingTx = transactionHashFromOutpoint(fundingOutpoint) ?? TESTNET_PROOF.fundingTx;
  const routePayable = run.probe?.verdict === "payable";
  const matchesDocumentedProof =
    fundingOutpoint === TESTNET_PROOF.channelOutpoint && fundingTx === TESTNET_PROOF.fundingTx;
  const proofStatus = readyChannel && routePayable ? "Verified" : readyChannel ? "Channel ready" : "Pending";
  const probeSummary = run.probe?.best
    ? `fee rate ${run.probe.best.feeRate ?? "default"}, parts ${run.probe.best.maxParts ?? "default"}, fee ${run.probe.best.fee ?? "unknown"}`
    : run.probe
      ? run.probe.summary
      : "Invoice proof not run";

  const details = [
    { label: "Funding tx", value: fundingTx },
    { label: "Channel ID", value: readyChannel?.channelId ?? compactHash(TESTNET_PROOF.channelId) },
    { label: "Channel outpoint", value: fundingOutpoint },
    { label: "Node A faucet", value: TESTNET_PROOF.nodeAFaucetTx },
    { label: "Node C faucet", value: TESTNET_PROOF.nodeCFaucetTx }
  ];

  return (
    <section className={`testnet-proof ${routePayable ? "payable" : readyChannel ? "risky" : "unknown"}`}>
      <div className="proof-hero">
        <div className="proof-hero-title">
          <CheckCircle2 size={20} />
          <div>
            <span>Fiber testnet</span>
            <strong>Live Testnet Proof</strong>
          </div>
        </div>
        <div className="proof-badge">
          <span>{matchesDocumentedProof ? "documented" : "live"}</span>
          <strong>{proofStatus}</strong>
        </div>
      </div>

      <div className="proof-metrics">
        <div>
          <span>RPC</span>
          <strong>{run.status?.verdict ?? "unknown"}</strong>
        </div>
        <div>
          <span>Channel</span>
          <strong>{readyChannel?.state ?? "not ready"}</strong>
        </div>
        <div>
          <span>Dry-run</span>
          <strong>{run.probe?.verdict ?? "not run"}</strong>
        </div>
        <div>
          <span>Best route</span>
          <strong>{probeSummary}</strong>
        </div>
      </div>

      <div className="proof-detail-list">
        {details.map((item) => (
          <div className="proof-detail" key={item.label}>
            <span>{item.label}</span>
            <code>{item.value}</code>
            <button
              className="icon-button proof-copy"
              onClick={() => copyTextToClipboard(item.value)}
              title={`Copy ${item.label}`}
            >
              <Copy size={15} />
            </button>
          </div>
        ))}
      </div>

      <div className="proof-actions">
        <a className="proof-link" href={TESTNET_PROOF.proofDocUrl} target="_blank" rel="noreferrer">
          <FileJson size={16} />
          Proof doc
          <ExternalLink size={14} />
        </a>
        <button
          className="secondary"
          onClick={() => copyTextToClipboard(TESTNET_PROOF.proofDocUrl)}
        >
          <Copy size={15} />
          Copy proof link
        </button>
      </div>
    </section>
  );
}

function ReportHistoryPanel({
  items,
  onLoad,
  onClear
}: {
  items: ReportHistoryItem[];
  onLoad: (item: ReportHistoryItem) => void;
  onClear: () => void;
}) {
  return (
    <section className="history-panel">
      <div className="history-head">
        <History size={18} />
        <h3>History</h3>
        <button className="icon-button" onClick={onClear} title="Clear history">
          <Trash2 size={16} />
        </button>
      </div>
      <div className="history-list">
        {items.map((item) => (
          <button className={`history-item ${item.verdict}`} key={item.id} onClick={() => onLoad(item)}>
            <div>
              <strong>{item.label}</strong>
              <span>{formatHistoryTime(item.createdAt)}</span>
            </div>
            <em>{item.verdict}</em>
            <p>{item.summary}</p>
            <small>{item.score}/100</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function StoryCard({ story, onRun, busy }: { story: DemoStory; onRun: () => void; busy: boolean }) {
  return (
    <section className="story-card">
      <div className="story-card-head">
        <BookOpen size={18} />
        <div>
          <span>{story.expectedVerdict}</span>
          <strong>{story.title}</strong>
        </div>
      </div>
      <p>{story.problem}</p>
      <button className="secondary" onClick={onRun} disabled={busy}>
        {busy ? <RefreshCw className="spin" size={16} /> : <Play size={16} />}
        Run story
      </button>
    </section>
  );
}

function StoryPanel({ story }: { story: DemoStory }) {
  const chapters = [
    { label: "Problem", detail: story.problem },
    { label: "Diagnosis", detail: story.diagnosis },
    { label: "Fix", detail: story.fix },
    { label: "Payoff", detail: story.payoff }
  ];

  return (
    <section className="story-panel">
      <div className="section-title">
        <BookOpen size={18} />
        <h3>Demo Story</h3>
      </div>
      <div className="story-panel-head">
        <div>
          <span>{story.mode}</span>
          <strong>{story.title}</strong>
        </div>
        <em>{story.expectedVerdict}</em>
      </div>
      <div className="story-steps">
        {chapters.map((chapter, index) => (
          <article key={chapter.label}>
            <span>{index + 1}</span>
            <div>
              <strong>{chapter.label}</strong>
              <p>{chapter.detail}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ReportView({ report }: { report: PreflightReport }) {
  return (
    <>
      <section className="export-row">
        <button onClick={() => downloadReport(report, "json")}>
          <Download size={16} />
          JSON
        </button>
        <button onClick={() => downloadReport(report, "markdown")}>
          <Download size={16} />
          Markdown
        </button>
        <button onClick={() => downloadSupportBundle(report)}>
          <FileJson size={16} />
          Bundle
        </button>
      </section>

      <section className={`summary-band ${report.verdict}`}>
        <div>
          <p className="eyebrow">Verdict</p>
          <h2>{report.summary}</h2>
        </div>
        <div className={`score ${report.verdict}`}>{report.score}</div>
      </section>

      {report.evidence.length > 0 && (
        <section className="evidence-grid">
          {report.evidence.map((item) => (
            <div className="evidence-item" key={`${item.label}-${item.value}`}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </section>
      )}

      {report.liquidity && <LiquidityLens insight={report.liquidity} />}

      {report.route && <RouteMap route={report.route} title="Route graph" />}

      {report.probes && report.probes.length > 0 && (
        <section>
          <div className="section-title">
            <Activity size={18} />
            <h3>Probes</h3>
          </div>
          <div className="probe-list">
            {report.probes.map((probe) => (
              <article className={`probe-card ${probe.status}`} key={probe.id}>
                <span>{probe.status}</span>
                <strong>{probe.label}</strong>
                <p>{probe.summary}</p>
                {probe.route && <em>{probe.route.hopCount} hops, {probe.route.fee} fee</em>}
              </article>
            ))}
          </div>
        </section>
      )}

      {report.actions.length > 0 && (
        <section>
          <div className="section-title">
            <Wrench size={18} />
            <h3>Actions</h3>
          </div>
          <div className="action-list">
            {report.actions.map((action) => (
              <article className={`action-card ${action.priority}`} key={`${action.title}-${action.detail}`}>
                <span>{action.priority}</span>
                <strong>{action.title}</strong>
                <p>{action.detail}</p>
              </article>
            ))}
          </div>
        </section>
      )}

      {report.runbook && <RunbookPanel plan={report.runbook} />}

      <section>
        <div className="section-title">
          <ClipboardList size={18} />
          <h3>Checks</h3>
        </div>
        <div className="checks">
          {report.checks.map((check) => (
            <CheckCard check={check} key={check.id} />
          ))}
        </div>
      </section>
    </>
  );
}

function ProbeReportView({ report }: { report: RouteProbeReport }) {
  return (
    <>
      <section className="export-row">
        <button onClick={() => downloadProbeReport(report, "json")}>
          <Download size={16} />
          JSON
        </button>
        <button onClick={() => downloadProbeReport(report, "markdown")}>
          <Download size={16} />
          Markdown
        </button>
        <button onClick={() => downloadSupportBundle(report)}>
          <FileJson size={16} />
          Bundle
        </button>
      </section>

      <section className={`summary-band ${report.verdict}`}>
        <div>
          <p className="eyebrow">Probe Lab</p>
          <h2>{report.summary}</h2>
        </div>
        <div className={`score ${report.verdict}`}>{report.score}</div>
      </section>

      {report.evidence.length > 0 && (
        <section className="evidence-grid">
          {report.evidence.map((item) => (
            <div className="evidence-item" key={`${item.label}-${item.value}`}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </section>
      )}

      {report.best && (
        <section className="route-band">
          <div className="route-head">
            <SlidersHorizontal size={18} />
            <strong>Best setting</strong>
            <span>{report.best.fee ?? "unknown"} fee</span>
          </div>
          <div className="best-grid">
            <div>
              <span>Max fee rate</span>
              <strong>{report.best.feeRate ?? "default"}</strong>
            </div>
            <div>
              <span>Max parts</span>
              <strong>{report.best.maxParts ?? "default"}</strong>
            </div>
            <div>
              <span>Hops</span>
              <strong>{report.best.hopCount ?? "unknown"}</strong>
            </div>
          </div>
        </section>
      )}

      {report.liquidity && <LiquidityLens insight={report.liquidity} />}

      {report.best?.route && <RouteMap route={report.best.route} title="Best route graph" />}

      <section>
        <div className="section-title">
          <Activity size={18} />
          <h3>Attempts</h3>
        </div>
        <div className="probe-list">
          {report.attempts.map((attempt) => (
            <article className={`probe-card ${attempt.status}`} key={attempt.id}>
              <span>{attempt.status}</span>
              <strong>{attempt.label}</strong>
              <p>
                {attempt.status === "pass"
                  ? `${attempt.hopCount ?? "unknown"} hops, ${attempt.fee ?? "unknown"} fee`
                  : attempt.error ?? "Route failed"}
              </p>
            </article>
          ))}
        </div>
      </section>

      {report.actions.length > 0 && (
        <section>
          <div className="section-title">
            <Wrench size={18} />
            <h3>Actions</h3>
          </div>
          <div className="action-list">
            {report.actions.map((action) => (
              <article className={`action-card ${action.priority}`} key={`${action.title}-${action.detail}`}>
                <span>{action.priority}</span>
                <strong>{action.title}</strong>
                <p>{action.detail}</p>
              </article>
            ))}
          </div>
        </section>
      )}

      {report.runbook && <RunbookPanel plan={report.runbook} />}
    </>
  );
}

function LiquidityLens({ insight }: { insight: LiquidityInsight }) {
  return (
    <section className={`liquidity-lens ${insight.status}`}>
      <div className="liquidity-head">
        <Activity size={18} />
        <div>
          <strong>{insight.title}</strong>
          <p>{insight.summary}</p>
        </div>
        <span>{insight.status}</span>
      </div>
      <div className="liquidity-stats">
        <div>
          <span>Asset</span>
          <strong>{insight.asset}</strong>
        </div>
        <div>
          <span>Amount</span>
          <strong>{insight.amount ?? "unknown"}</strong>
        </div>
        <div>
          <span>Channels</span>
          <strong>{insight.matchingChannelCount}</strong>
        </div>
        <div>
          <span>Total local</span>
          <strong>{insight.totalLocalBalance}</strong>
        </div>
        <div>
          <span>Largest local</span>
          <strong>{insight.largestLocalBalance}</strong>
        </div>
        <div>
          <span>MPP</span>
          <strong>{insight.likelyNeedsMpp ? "Likely" : "Not required"}</strong>
        </div>
      </div>
      {insight.channels.length > 0 && (
        <div className="liquidity-channels">
          {insight.channels.slice(0, 3).map((channel) => (
            <div className="liquidity-channel" key={`${channel.channelId}-${channel.peer}`}>
              <div>
                <strong>{channel.channelId}</strong>
                <span>{channel.peer}</span>
              </div>
              <em>{channel.localBalance}</em>
              {channel.channelOutpoint && <code>{channel.channelOutpoint}</code>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RouteMap({ route, title }: { route: RouteSummary; title: string }) {
  const paths = routePaths(route);
  return (
    <section className="route-band">
      <div className="route-head">
        <Route size={18} />
        <strong>{title}</strong>
        <span>{route.fee} fee</span>
      </div>
      <div className="route-stats">
        <div>
          <span>Paths</span>
          <strong>{route.routeCount || paths.length}</strong>
        </div>
        <div>
          <span>Hops</span>
          <strong>{route.hopCount}</strong>
        </div>
        <div>
          <span>Estimated fee</span>
          <strong>{route.fee}</strong>
        </div>
      </div>
      <div className="route-paths">
        {paths.map((path) => (
          <RoutePathView path={path} key={path.id} />
        ))}
      </div>
    </section>
  );
}

function RoutePathView({ path }: { path: RoutePathSummary }) {
  return (
    <div className="route-path">
      <div className="route-path-head">
        <strong>{path.label}</strong>
        <span>{path.amount ?? `${path.hopCount} hop${path.hopCount === 1 ? "" : "s"}`}</span>
      </div>
      <div className="route-graph">
        {path.hops.map((hop, index) => (
          <div className="route-node" key={`${path.id}-${hop.pubkey}-${index}`}>
            <span>{index + 1}</span>
            <strong>{compactHash(hop.pubkey)}</strong>
            <em>{hop.amount ?? "amount unknown"}</em>
            {hop.channelOutpoint && <code>{hop.channelOutpoint}</code>}
          </div>
        ))}
      </div>
    </div>
  );
}

function routePaths(route: RouteSummary): RoutePathSummary[] {
  if (route.paths && route.paths.length > 0) return route.paths;
  return [
    {
      id: "route",
      label: "Route",
      hopCount: route.hopCount,
      hops: route.hops
    }
  ];
}

function RunbookPanel({ plan }: { plan: RunbookPlan }) {
  return (
    <section>
      <div className="section-title">
        <ClipboardList size={18} />
        <h3>Runbook</h3>
      </div>
      <div className="runbook-summary">
        <strong>{plan.nextBestAction ?? "No action required"}</strong>
        <span>{plan.summary}</span>
      </div>
      <div className="runbook-list">
        {plan.steps.map((step, index) => (
          <RunbookStepCard step={step} index={index + 1} key={step.id} />
        ))}
      </div>
    </section>
  );
}

function RunbookStepCard({ step, index }: { step: RunbookStep; index: number }) {
  const copyText = step.command ?? (step.params ? formatStepParams(step.params) : "");
  return (
    <article className={`runbook-card ${step.priority} ${step.status}`}>
      <div className="runbook-index">{index}</div>
      <div>
        <div className="runbook-title">
          <strong>{step.title}</strong>
          <span>{step.owner} - {step.status}</span>
        </div>
        <p>{step.detail}</p>
        {step.params && <code>{formatStepParams(step.params)}</code>}
      </div>
      {copyText && (
        <button className="icon-button" onClick={() => copyTextToClipboard(copyText)} title="Copy runbook step">
          <Copy size={16} />
        </button>
      )}
    </article>
  );
}

function CheckCard({ check }: { check: CheckResult }) {
  const Icon = statusIcon[check.status];
  return (
    <article className={`check-card ${check.status}`}>
      <Icon size={18} />
      <div>
        <div className="check-title">
          <strong>{check.title}</strong>
          <span>{check.category}</span>
        </div>
        <p>{check.detail}</p>
        {check.action && <em>{check.action}</em>}
      </div>
    </article>
  );
}

function EmptyReport() {
  return (
    <section className="empty">
      <Activity size={32} />
      <h2>No report yet</h2>
    </section>
  );
}

function StatusPanel({ report }: { report: NodeStatusReport }) {
  return (
    <section className={`status-panel ${report.verdict}`}>
      <div>
        <span>{report.verdict}</span>
        <strong>{report.score}/100</strong>
      </div>
      <p>{report.summary}</p>
      <ul>
        {report.checks.slice(0, 5).map((check) => (
          <li key={check.id} className={check.status}>
            {check.title}
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatHistoryTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatBundleDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function transactionHashFromOutpoint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^0x[0-9a-fA-F]{64}/.exec(value);
  return match?.[0];
}

function isPaymentVerdict(value: unknown): value is PreflightReport["verdict"] {
  return value === "payable" || value === "risky" || value === "blocked" || value === "unknown";
}

function importedReportKind(report: unknown): string | undefined {
  if (!report || typeof report !== "object") return undefined;
  if ("kind" in report && typeof report.kind === "string") return report.kind;
  if ("channels" in report) return "channel-inventory";
  return undefined;
}

function isNodeStatusReport(value: unknown): value is NodeStatusReport {
  return Boolean(
    value &&
      typeof value === "object" &&
      "kind" in value &&
      value.kind === "node-status" &&
      "checks" in value &&
      Array.isArray(value.checks)
  );
}

function isChannelInventoryReport(value: unknown): value is ChannelInventoryReport {
  return Boolean(
    value &&
      typeof value === "object" &&
      "totals" in value &&
      "channels" in value &&
      Array.isArray(value.channels)
  );
}

function stringFromScenario(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return undefined;
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatStepParams(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

function copyTextToClipboard(value: string): void {
  void navigator.clipboard?.writeText(value);
}

function downloadReport(report: PreflightReport, format: "json" | "markdown"): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const extension = format === "json" ? "json" : "md";
  const mime = format === "json" ? "application/json" : "text/markdown";
  const content = format === "json" ? JSON.stringify(report, null, 2) : reportToMarkdown(report);
  const blob = new Blob([content], { type: `${mime}; charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `fiber-preflight-${report.verdict}-${timestamp}.${extension}`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function downloadProbeReport(report: RouteProbeReport, format: "json" | "markdown"): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const extension = format === "json" ? "json" : "md";
  const mime = format === "json" ? "application/json" : "text/markdown";
  const content = format === "json" ? JSON.stringify(report, null, 2) : routeProbeToMarkdown(report);
  const blob = new Blob([content], { type: `${mime}; charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `fiber-preflight-probes-${report.verdict}-${timestamp}.${extension}`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function downloadSupportBundle(report: ReportHistoryReport): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const bundle = buildSupportBundle(report, { source: "web" });
  const blob = new Blob([JSON.stringify(bundle, null, 2)], {
    type: "application/json; charset=utf-8"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `fiber-preflight-support-bundle-${timestamp}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const payload = (await response.json()) as T | { error?: string };
  if (!response.ok) {
    const errorPayload = payload as { error?: string };
    throw new Error(errorPayload.error ? errorPayload.error : `HTTP ${response.status}`);
  }
  return payload as T;
}
