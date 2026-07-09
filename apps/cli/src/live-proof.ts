#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FiberRpcClient,
  buildSupportBundle,
  explainPayment,
  inspectChannels,
  inspectNodeStatus,
  probeRouteOptions,
  reportToMarkdown,
  routeProbeToMarkdown,
  runInvoicePreflight,
  type ChannelInventoryReport,
  type CheckResult,
  type NodeStatusReport,
  type PreflightReport,
  type RouteProbeReport,
  type SupportBundleReport
} from "@fiber-preflight/core";

interface LiveProofConfig {
  rpcUrl: string;
  token?: string;
  timeoutMs?: number;
  invoice?: string;
  amount?: string;
  maxFeeRate?: string;
  maxParts?: string;
  paymentHash?: string;
  outDir: string;
  probe: boolean;
  expectPayable: boolean;
  skipDryRun: boolean;
}

interface ProofStep {
  id: string;
  title: string;
  verdict?: string;
  score?: number;
  summary: string;
  bundlePath: string;
  requiredFailures: string[];
}

const args = parseArgs(process.argv.slice(2));
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  if (args.help) {
    printHelp();
    return;
  }

  const config = readConfig();
  const generatedAt = new Date();
  const rpc = new FiberRpcClient({
    url: config.rpcUrl,
    token: config.token,
    timeoutMs: config.timeoutMs
  });

  await mkdir(config.outDir, { recursive: true });

  const steps: ProofStep[] = [];

  const status = await inspectNodeStatus(rpc, { sampleInvoice: config.invoice });
  steps.push(await persistStep("01-status", "Live RPC readiness", status, config, generatedAt, [
    ...unavailableChecks(status, [
      "status.node_info",
      "status.list_peers",
      "status.list_channels",
      "status.graph_nodes",
      "status.graph_channels",
      "status.list_payments"
    ]),
    ...(config.invoice ? failedChecks(status, ["status.parse_invoice"]) : [])
  ]));

  const { report: channels, failure: channelFailure } = await inspectChannelsForProof(rpc);
  steps.push(await persistStep("02-channels", "Live channel inventory", channels, config, generatedAt, []));
  if (channelFailure) {
    steps[steps.length - 1].requiredFailures.push(channelFailure);
  }

  let preflight: PreflightReport | undefined;
  if (config.invoice) {
    preflight = await runInvoicePreflight(rpc, {
      invoice: config.invoice,
      amount: config.amount,
      maxFeeRate: config.maxFeeRate,
      maxParts: config.maxParts,
      skipDryRun: config.skipDryRun
    });
    steps.push(await persistStep("03-preflight", "Live invoice preflight", preflight, config, generatedAt, [
      ...failedChecks(preflight, ["rpc.node_info", "invoice.parse"]),
      ...(config.skipDryRun ? [] : missingChecks(preflight, ["route.dry_run"])),
      ...(config.expectPayable && !preflight.route
        ? ["Expected a payable dry-run route, but no route was returned."]
        : [])
    ]));

    if (config.probe) {
      const probe = await probeRouteOptions(rpc, {
        invoice: config.invoice,
        amount: config.amount,
        maxFeeRate: config.maxFeeRate,
        maxParts: config.maxParts,
        stopOnFirstSuccess: true
      });
      steps.push(await persistStep("04-probe", "Live route probe", probe, config, generatedAt, [
        ...(config.expectPayable && !probe.best
          ? ["Expected at least one passing probe, but no dry-run setting passed."]
          : [])
      ]));
    }
  }

  if (config.paymentHash) {
    const postmortem = await explainPayment(rpc, { paymentHash: config.paymentHash });
    steps.push(await persistStep("05-postmortem", "Live payment postmortem", postmortem, config, generatedAt, [
      ...failedChecks(postmortem, ["postmortem.get_payment"])
    ]));
  }

  const summaryPath = join(config.outDir, "proof-summary.md");
  await writeFile(summaryPath, renderSummary(config, generatedAt, steps), "utf8");

  printConsoleSummary(config, steps, summaryPath);

  const failures = steps.flatMap((step) => step.requiredFailures.map((failure) => `${step.title}: ${failure}`));
  if (failures.length > 0) {
    console.error("");
    console.error("Live proof failed required capability checks:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  }
}

async function persistStep(
  id: string,
  title: string,
  report: SupportBundleReport,
  config: LiveProofConfig,
  generatedAt: Date,
  requiredFailures: string[]
): Promise<ProofStep> {
  const bundle = buildSupportBundle(report, { source: "cli", generatedAt });
  const bundlePath = join(config.outDir, `${id}.bundle.json`);
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

  const markdownPath = join(config.outDir, `${id}.md`);
  const markdown = reportToMarkdownIfSupported(report);
  if (markdown) await writeFile(markdownPath, markdown, "utf8");

  return {
    id,
    title,
    verdict: "verdict" in report ? String(report.verdict) : undefined,
    score: "score" in report ? report.score : undefined,
    summary: "summary" in report ? report.summary : title,
    bundlePath,
    requiredFailures
  };
}

function reportToMarkdownIfSupported(report: SupportBundleReport): string | undefined {
  if ("kind" in report && (report.kind === "invoice-preflight" || report.kind === "payment-postmortem")) {
    return `${reportToMarkdown(report)}\n`;
  }
  if ("kind" in report && report.kind === "route-probe") {
    return `${routeProbeToMarkdown(report)}\n`;
  }
  return undefined;
}

function failedChecks(report: { checks?: CheckResult[] }, ids: string[]): string[] {
  return ids.flatMap((id) => {
    const check = report.checks?.find((item) => item.id === id);
    if (!check) return [`Missing required check ${id}.`];
    return check.status === "fail" ? [`${check.title}: ${check.detail}`] : [];
  });
}

function unavailableChecks(report: { checks?: CheckResult[] }, ids: string[]): string[] {
  return ids.flatMap((id) => {
    const check = report.checks?.find((item) => item.id === id);
    if (!check) return [`Missing required check ${id}.`];
    if (check.status !== "fail") return [];
    if (id === "status.list_channels" && !/unavailable|failed|rpc/i.test(`${check.title} ${check.detail}`)) {
      return [];
    }
    return [`${check.title}: ${check.detail}`];
  });
}

async function inspectChannelsForProof(
  rpc: FiberRpcClient
): Promise<{ report: ChannelInventoryReport; failure?: string }> {
  try {
    return { report: await inspectChannels(rpc, { includePending: true }) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      failure: detail,
      report: {
        summary: `Channel inventory failed: ${detail}`,
        totals: {
          total: 0,
          ready: 0,
          enabledReady: 0,
          publicChannels: 0,
          privateChannels: 0,
          ckbLocalBalance: "0",
          udtLocalBalance: "0",
          pendingTlcCount: 0
        },
        channels: [],
        pendingChannels: [],
        raw: {
          error: detail
        }
      }
    };
  }
}

function missingChecks(report: { checks?: CheckResult[] }, ids: string[]): string[] {
  return ids.flatMap((id) => report.checks?.some((item) => item.id === id) ? [] : [`Missing required check ${id}.`]);
}

function renderSummary(config: LiveProofConfig, generatedAt: Date, steps: ProofStep[]): string {
  const lines = [
    "# Fiber Preflight Live Proof",
    "",
    `Generated: ${generatedAt.toISOString()}`,
    `Endpoint: ${endpointLabel(config.rpcUrl)}`,
    `Invoice dry-run: ${config.invoice && !config.skipDryRun ? "enabled" : "not run"}`,
    `Route probe sweep: ${config.probe ? "enabled" : "not run"}`,
    "",
    "| Step | Verdict | Score | Summary | Bundle |",
    "| --- | --- | ---: | --- | --- |"
  ];

  for (const step of steps) {
    lines.push(
      `| ${step.title} | ${step.verdict ?? "n/a"} | ${step.score ?? ""} | ${escapeTable(step.summary)} | ${step.id}.bundle.json |`
    );
  }

  const failures = steps.flatMap((step) => step.requiredFailures.map((failure) => `${step.title}: ${failure}`));
  lines.push("");
  if (failures.length === 0) {
    lines.push("Required live capability checks passed.");
  } else {
    lines.push("Required live capability failures:");
    for (const failure of failures) lines.push(`- ${failure}`);
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function printConsoleSummary(config: LiveProofConfig, steps: ProofStep[], summaryPath: string): void {
  console.log("Fiber Preflight live proof");
  console.log(`Endpoint: ${endpointLabel(config.rpcUrl)}`);
  console.log(`Artifacts: ${config.outDir}`);
  console.log("");

  for (const step of steps) {
    const score = step.score === undefined ? "" : ` (${step.score}/100)`;
    const verdict = step.verdict ? `${step.verdict.toUpperCase()}${score}` : "DONE";
    console.log(`[${verdict}] ${step.title}`);
    console.log(`  ${step.summary}`);
    console.log(`  Bundle: ${step.bundlePath}`);
  }

  console.log("");
  console.log(`Summary: ${summaryPath}`);
}

function readConfig(): LiveProofConfig {
  const rpcUrl = option("rpc") ?? env("FIBER_PREFLIGHT_RPC_URL", "FIBER_RPC_URL");
  if (!rpcUrl) {
    throw new Error("Missing live RPC URL. Set FIBER_PREFLIGHT_RPC_URL or pass --rpc.");
  }

  const timeoutRaw = option("timeout-ms") ?? env("FIBER_PREFLIGHT_TIMEOUT_MS", "FIBER_RPC_TIMEOUT_MS");
  const timeoutMs = timeoutRaw === undefined ? undefined : Number(timeoutRaw);
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
    throw new Error("Timeout must be a non-negative millisecond value.");
  }

  return {
    rpcUrl,
    token: option("token") ?? env("FIBER_PREFLIGHT_TOKEN", "FIBER_RPC_TOKEN"),
    timeoutMs,
    invoice: option("invoice") ?? env("FIBER_PREFLIGHT_INVOICE", "FIBER_INVOICE"),
    amount: option("amount") ?? env("FIBER_PREFLIGHT_AMOUNT", "FIBER_AMOUNT"),
    maxFeeRate: option("max-fee-rate") ?? env("FIBER_PREFLIGHT_MAX_FEE_RATE", "FIBER_MAX_FEE_RATE"),
    maxParts: option("max-parts") ?? env("FIBER_PREFLIGHT_MAX_PARTS", "FIBER_MAX_PARTS"),
    paymentHash: option("payment-hash") ?? env("FIBER_PREFLIGHT_PAYMENT_HASH", "FIBER_PAYMENT_HASH"),
    outDir: resolveOutDir(option("out-dir") ?? env("FIBER_PREFLIGHT_OUT_DIR") ?? "artifacts/live-proof"),
    probe: flag("probe") || boolEnv("FIBER_PREFLIGHT_PROBE"),
    expectPayable: flag("expect-payable") || boolEnv("FIBER_PREFLIGHT_EXPECT_PAYABLE"),
    skipDryRun: flag("skip-dry-run") || boolEnv("FIBER_PREFLIGHT_SKIP_DRY_RUN")
  };
}

function parseArgs(values: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
    const key = arg.slice(2);
    if (["probe", "expect-payable", "skip-dry-run"].includes(key)) {
      parsed[key] = true;
      continue;
    }
    const next = values[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value.`);
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function option(name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function flag(name: string): boolean {
  return args[name] === true;
}

function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value;
  }
  return undefined;
}

function boolEnv(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[name] ?? "");
}

function endpointLabel(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "[invalid endpoint]";
  }
}

function resolveOutDir(value: string): string {
  return isAbsolute(value) ? value : join(workspaceRoot, value);
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function printHelp(): void {
  console.log(`Fiber Preflight live proof

Runs live Fiber RPC checks and writes privacy-safe support bundles.

Usage:
  pnpm live:proof -- --rpc http://127.0.0.1:8227
  pnpm live:proof -- --rpc http://127.0.0.1:8227 --invoice fibt1... --probe

Environment:
  FIBER_PREFLIGHT_RPC_URL       Fiber JSON-RPC endpoint
  FIBER_PREFLIGHT_TOKEN         Optional Biscuit bearer token
  FIBER_PREFLIGHT_TIMEOUT_MS    Optional RPC timeout in ms
  FIBER_PREFLIGHT_INVOICE       Optional invoice for parse_invoice and dry-run proof
  FIBER_PREFLIGHT_AMOUNT        Optional amount for amountless invoices
  FIBER_PREFLIGHT_PAYMENT_HASH  Optional payment hash for postmortem proof
  FIBER_PREFLIGHT_PROBE=1       Run route probe sweep when an invoice is provided
  FIBER_PREFLIGHT_EXPECT_PAYABLE=1
                                 Fail if live dry-run/probe does not find a route
  FIBER_PREFLIGHT_SKIP_DRY_RUN=1
                                 Parse invoice but do not call send_payment dry_run
  FIBER_PREFLIGHT_OUT_DIR       Artifact directory, default artifacts/live-proof

Flags:
  --rpc <url>
  --token <token>
  --timeout-ms <ms>
  --invoice <invoice>
  --amount <amount>
  --payment-hash <hash>
  --max-fee-rate <rate>
  --max-parts <parts>
  --out-dir <path>
  --probe
  --expect-payable
  --skip-dry-run`);
}
