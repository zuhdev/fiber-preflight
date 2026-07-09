import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  ClipboardList,
  Download,
  FileJson,
  Play,
  RefreshCw,
  Route,
  ShieldAlert,
  SlidersHorizontal,
  Wrench
} from "lucide-react";
import {
  FiberRpcClient,
  FixtureRpc,
  compactHash,
  explainPayment,
  inspectNodeStatus,
  probeRouteOptions,
  reportToMarkdown,
  routeProbeToMarkdown,
  runInvoicePreflight,
  type CheckResult,
  type FixtureScenario,
  type NodeStatusReport,
  type PreflightReport,
  type RouteProbeReport
} from "@fiber-preflight/core";
import { useMemo, useState } from "react";
import { demoScenarios } from "./demoScenarios.js";

type Mode = "check" | "explain" | "probe";
type Source = "demo" | "live";

const statusIcon = {
  pass: CheckCircle2,
  warn: AlertTriangle,
  fail: ShieldAlert,
  info: Activity,
  skip: CircleSlash
};

export function App() {
  const [mode, setMode] = useState<Mode>("check");
  const [source, setSource] = useState<Source>("demo");
  const [scenarioName, setScenarioName] = useState(demoScenarios[0]?.name ?? "");
  const [rpcUrl, setRpcUrl] = useState("http://127.0.0.1:8227");
  const [apiUrl, setApiUrl] = useState("http://127.0.0.1:8787");
  const [useApiProxy, setUseApiProxy] = useState(true);
  const [token, setToken] = useState("");
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
  const [busy, setBusy] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const scenario = useMemo(
    () => demoScenarios.find((item) => item.name === scenarioName) ?? demoScenarios[0],
    [scenarioName]
  );
  const activeVerdict = probeReport?.verdict ?? report?.verdict;
  const activeScore = probeReport?.score ?? report?.score;

  async function run() {
    setBusy(true);
    setError(undefined);
    try {
      if (source === "live" && useApiProxy) {
        if (mode === "probe") {
          const nextProbeReport = await postJson<RouteProbeReport>(`${apiUrl}/api/probes/route`, {
            rpcUrl,
            token: token || undefined,
            invoice: invoice.trim(),
            amount: amount.trim() || undefined,
            feeRates: splitCsv(feeRates),
            partOptions: splitCsv(partOptions)
          });
          setProbeReport(nextProbeReport);
          setReport(undefined);
          return;
        }

        const nextReport = mode === "check"
          ? await postJson<PreflightReport>(`${apiUrl}/api/preflight/check`, {
              rpcUrl,
              token: token || undefined,
              invoice: invoice.trim(),
              amount: amount.trim() || undefined,
              maxFeeRate: maxFeeRate.trim() || undefined,
              maxParts: maxParts.trim() || undefined
            })
          : await postJson<PreflightReport>(`${apiUrl}/api/preflight/explain`, {
              rpcUrl,
              token: token || undefined,
              paymentHash: paymentHash.trim()
            });
        setReport(nextReport);
        setProbeReport(undefined);
        return;
      }

      const rpc =
        source === "demo"
          ? new FixtureRpc(scenario)
          : new FiberRpcClient({ url: rpcUrl, token: token || undefined });

      if (mode === "check" || mode === "probe") {
        const inputInvoice = source === "demo" ? stringFromScenario(scenario.input?.invoice) : invoice.trim();
        if (mode === "probe") {
          const nextProbeReport = await probeRouteOptions(rpc, {
            invoice: inputInvoice,
            amount: amount.trim() || stringFromScenario(scenario.input?.amount),
            feeRates: splitCsv(feeRates),
            partOptions: splitCsv(partOptions)
          });
          setProbeReport(nextProbeReport);
          setReport(undefined);
          return;
        }

        const nextReport = await runInvoicePreflight(rpc, {
          invoice: inputInvoice,
          amount: amount.trim() || stringFromScenario(scenario.input?.amount),
          maxFeeRate: maxFeeRate.trim() || undefined,
          maxParts: maxParts.trim() || undefined
        });
        setReport(nextReport);
        setProbeReport(undefined);
      } else {
        const hash =
          source === "demo" ? stringFromScenario(scenario.input?.paymentHash) : paymentHash.trim();
        if (!hash) throw new Error("Payment hash is required.");
        setReport(await explainPayment(rpc, { paymentHash: hash }));
        setProbeReport(undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setStatusBusy(true);
    setError(undefined);
    try {
      const sampleInvoice = invoice.trim() || undefined;
      const nextStatus =
        useApiProxy
          ? await postJson<NodeStatusReport>(`${apiUrl}/api/status`, {
              rpcUrl,
              token: token || undefined,
              sampleInvoice
            })
          : await inspectNodeStatus(new FiberRpcClient({ url: rpcUrl, token: token || undefined }), {
              sampleInvoice
            });
      setStatusReport(nextStatus);
    } catch (err) {
      setStatusReport(undefined);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStatusBusy(false);
    }
  }

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Fiber Preflight</p>
          <h1>Payment readiness and route diagnostics</h1>
        </div>
        <div className={`verdict ${activeVerdict ?? "unknown"}`}>
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
              <select value={scenarioName} onChange={(event) => setScenarioName(event.target.value)}>
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
              {statusReport && <StatusPanel report={statusReport} />}
            </>
          )}

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

          <button className="primary" onClick={run} disabled={busy}>
            {busy ? <RefreshCw className="spin" size={17} /> : <Play size={17} />}
            {mode === "probe" ? "Run probes" : "Run preflight"}
          </button>
        </div>

        <div className="report">
          {error && <div className="error">{error}</div>}
          {!report && !probeReport && !error && <EmptyReport />}
          {probeReport && <ProbeReportView report={probeReport} />}
          {report && <ReportView report={report} />}
        </div>
      </section>
    </main>
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
      </section>

      <section className="summary-band">
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

      {report.route && (
        <section className="route-band">
          <div className="route-head">
            <Route size={18} />
            <strong>Route</strong>
            <span>{report.route.fee} fee</span>
          </div>
          <div className="hop-list">
            {report.route.hops.map((hop, index) => (
              <div className="hop" key={`${hop.pubkey}-${index}`}>
                <span>{index + 1}</span>
                <strong>{compactHash(hop.pubkey)}</strong>
                <em>{hop.amount ?? "amount unknown"}</em>
              </div>
            ))}
          </div>
        </section>
      )}

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
      </section>

      <section className="summary-band">
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
    </>
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
