import { compactHash } from "./format.js";
import type {
  ChannelInventoryReport,
  NodeStatusReport,
  PreflightReport,
  RouteProbeReport
} from "./types.js";

export type SupportBundleReport =
  | PreflightReport
  | RouteProbeReport
  | NodeStatusReport
  | ChannelInventoryReport;

export interface SupportBundleOptions {
  generatedAt?: Date | string;
  source?: "cli" | "web" | "api" | "unknown";
}

export interface SupportBundle {
  kind: "fiber-preflight-support-bundle";
  version: 1;
  generatedAt: string;
  source: "cli" | "web" | "api" | "unknown";
  reportKind: string;
  verdict?: string;
  score?: number;
  summary?: string;
  privacy: {
    rawRpcPayloadsIncluded: false;
    redactions: string[];
  };
  report: unknown;
}

const RAW_OMITTED = "[redacted: raw RPC payload omitted]";
const REDACTED = "[redacted]";
const REDACTED_INVOICE = "[redacted: invoice]";
const LONG_HEX_PATTERN = /0x[a-fA-F0-9]{24,}/g;
const INVOICE_PATTERN = /\bfib[a-z0-9]{6,}\b/gi;
const LONG_HEX_TEST = /0x[a-fA-F0-9]{24,}/;
const INVOICE_TEST = /\bfib[a-z0-9]{6,}\b/i;

const SENSITIVE_KEY_PATTERNS = [
  /authorization/i,
  /biscuit/i,
  /invoice/i,
  /payment[_-]?hash/i,
  /preimage/i,
  /secret/i,
  /signature/i,
  /token/i
];

export function buildSupportBundle(
  report: SupportBundleReport,
  options: SupportBundleOptions = {}
): SupportBundle {
  return {
    kind: "fiber-preflight-support-bundle",
    version: 1,
    generatedAt: normalizeGeneratedAt(options.generatedAt),
    source: options.source ?? "unknown",
    reportKind: reportKind(report),
    verdict: "verdict" in report ? String(report.verdict) : undefined,
    score: "score" in report ? report.score : undefined,
    summary: "summary" in report ? report.summary : undefined,
    privacy: {
      rawRpcPayloadsIncluded: false,
      redactions: [
        "Raw RPC payloads are omitted.",
        "Fiber invoices, tokens, signatures, secrets, and preimages are removed.",
        "Long hashes are shortened for correlation only."
      ]
    },
    report: redactForSupportBundle(report)
  };
}

export function parseSupportBundleJson(text: string): SupportBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Invalid support bundle JSON.");
  }

  if (!isSupportBundle(parsed)) {
    throw new Error("Invalid Fiber Preflight support bundle.");
  }

  return parsed;
}

export function supportBundleReport(bundle: SupportBundle): SupportBundleReport | undefined {
  if (isPreflightReport(bundle.report)) return bundle.report;
  if (isRouteProbeReport(bundle.report)) return bundle.report;
  if (isNodeStatusReport(bundle.report)) return bundle.report;
  if (bundle.reportKind === "channel-inventory" && isChannelInventoryReport(bundle.report)) {
    return bundle.report;
  }
  return undefined;
}

export function redactForSupportBundle(value: unknown, key = ""): unknown {
  if (key === "raw") return RAW_OMITTED;

  if (matchesSensitiveKey(key)) {
    return redactSensitiveValue(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactForSupportBundle(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([innerKey, innerValue]) => [
        innerKey,
        redactForSupportBundle(innerValue, innerKey)
      ])
    );
  }

  if (typeof value === "string") return redactString(value);
  return value;
}

function redactSensitiveValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, redactSensitiveValue(inner)])
    );
  }
  if (typeof value === "string") {
    if (INVOICE_TEST.test(value)) {
      return REDACTED_INVOICE;
    }
    if (LONG_HEX_TEST.test(value)) {
      return compactHash(value);
    }
    return REDACTED;
  }
  return value === undefined || value === null ? value : REDACTED;
}

function redactString(value: string): string {
  return value
    .replace(INVOICE_PATTERN, REDACTED_INVOICE)
    .replace(LONG_HEX_PATTERN, (match) => compactHash(match));
}

function matchesSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function normalizeGeneratedAt(value: Date | string | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

function reportKind(report: SupportBundleReport): string {
  if ("kind" in report && typeof report.kind === "string") return report.kind;
  if ("channels" in report) return "channel-inventory";
  return "unknown";
}

function isSupportBundle(value: unknown): value is SupportBundle {
  if (!value || typeof value !== "object") return false;
  const bundle = value as Partial<SupportBundle>;
  return (
    bundle.kind === "fiber-preflight-support-bundle" &&
    bundle.version === 1 &&
    typeof bundle.generatedAt === "string" &&
    typeof bundle.source === "string" &&
    typeof bundle.reportKind === "string" &&
    typeof bundle.privacy === "object" &&
    bundle.privacy !== null &&
    "report" in bundle
  );
}

function isPreflightReport(value: unknown): value is PreflightReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Partial<PreflightReport>;
  return (
    (report.kind === "invoice-preflight" || report.kind === "payment-postmortem") &&
    isVerdict(report.verdict) &&
    typeof report.score === "number" &&
    typeof report.summary === "string" &&
    Array.isArray(report.checks) &&
    Array.isArray(report.actions) &&
    Array.isArray(report.evidence)
  );
}

function isRouteProbeReport(value: unknown): value is RouteProbeReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Partial<RouteProbeReport>;
  return (
    report.kind === "route-probe" &&
    isVerdict(report.verdict) &&
    typeof report.score === "number" &&
    typeof report.summary === "string" &&
    Array.isArray(report.attempts) &&
    Array.isArray(report.actions) &&
    Array.isArray(report.evidence)
  );
}

function isNodeStatusReport(value: unknown): value is NodeStatusReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Partial<NodeStatusReport>;
  return (
    report.kind === "node-status" &&
    (report.verdict === "ready" || report.verdict === "limited" || report.verdict === "blocked") &&
    typeof report.score === "number" &&
    typeof report.summary === "string" &&
    Array.isArray(report.checks) &&
    Array.isArray(report.evidence)
  );
}

function isChannelInventoryReport(value: unknown): value is ChannelInventoryReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Partial<ChannelInventoryReport>;
  return (
    typeof report.summary === "string" &&
    typeof report.totals === "object" &&
    report.totals !== null &&
    Array.isArray(report.channels)
  );
}

function isVerdict(value: unknown): boolean {
  return value === "payable" || value === "risky" || value === "blocked" || value === "unknown";
}
