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
