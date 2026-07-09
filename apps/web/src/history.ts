import type { PreflightReport, RouteProbeReport, Verdict } from "@fiber-preflight/core";

export const HISTORY_STORAGE_KEY = "fiber-preflight.report-history";
export const HISTORY_LIMIT = 8;

export type ReportHistoryReport = PreflightReport | RouteProbeReport;
export type ReportHistoryMode = "check" | "explain" | "probe";
export type ReportHistorySource = "demo" | "live";

export interface ReportHistoryContext {
  mode: ReportHistoryMode;
  source: ReportHistorySource;
  scenarioName?: string;
  rpcUrl?: string;
}

export interface ReportHistoryItem {
  id: string;
  kind: ReportHistoryReport["kind"];
  createdAt: string;
  label: string;
  source: ReportHistorySource;
  mode: ReportHistoryMode;
  verdict: Verdict;
  score: number;
  summary: string;
  report: ReportHistoryReport;
}

interface HistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function createReportHistoryItem(
  report: ReportHistoryReport,
  context: ReportHistoryContext,
  now = new Date()
): ReportHistoryItem {
  const createdAt = now.toISOString();
  const modeLabel = report.kind === "route-probe"
    ? "Probe"
    : report.kind === "payment-postmortem"
      ? "Explain"
      : "Check";
  const sourceLabel = context.source === "demo"
    ? context.scenarioName ?? "Demo"
    : compactEndpoint(context.rpcUrl);

  return {
    id: `${report.kind}-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: report.kind,
    createdAt,
    label: `${modeLabel} - ${sourceLabel}`,
    source: context.source,
    mode: report.kind === "route-probe" ? "probe" : context.mode,
    verdict: report.verdict,
    score: report.score,
    summary: report.summary,
    report
  };
}

export function loadReportHistory(storage = browserStorage()): ReportHistoryItem[] {
  if (!storage) return [];

  try {
    const value = storage.getItem(HISTORY_STORAGE_KEY);
    if (!value) return [];
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isHistoryItem).slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

export function saveReportHistory(history: ReportHistoryItem[], storage = browserStorage()): void {
  storage?.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.slice(0, HISTORY_LIMIT)));
}

export function clearReportHistory(storage = browserStorage()): void {
  storage?.removeItem(HISTORY_STORAGE_KEY);
}

export function upsertReportHistory(
  history: ReportHistoryItem[],
  item: ReportHistoryItem,
  limit = HISTORY_LIMIT
): ReportHistoryItem[] {
  return [item, ...history.filter((current) => current.id !== item.id)].slice(0, limit);
}

function browserStorage(): HistoryStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function compactEndpoint(value: string | undefined): string {
  if (!value?.trim()) return "Live RPC";

  try {
    const url = new URL(value);
    return url.host || value;
  } catch {
    return value;
  }
}

function isHistoryItem(value: unknown): value is ReportHistoryItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ReportHistoryItem>;
  return (
    typeof item.id === "string" &&
    typeof item.createdAt === "string" &&
    typeof item.label === "string" &&
    typeof item.summary === "string" &&
    typeof item.score === "number" &&
    typeof item.report === "object" &&
    (item.kind === "invoice-preflight" || item.kind === "payment-postmortem" || item.kind === "route-probe") &&
    (item.source === "demo" || item.source === "live") &&
    (item.mode === "check" || item.mode === "explain" || item.mode === "probe") &&
    (item.verdict === "payable" || item.verdict === "risky" || item.verdict === "blocked" || item.verdict === "unknown")
  );
}
