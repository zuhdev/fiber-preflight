#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  FiberRpcClient,
  FixtureRpc,
  channelInventoryToMarkdown,
  compactHash,
  explainPayment,
  inspectChannels,
  inspectNodeStatus,
  nodeStatusToMarkdown,
  reportToMarkdown,
  runInvoicePreflight,
  type ChannelInventoryReport,
  type CheckResult,
  type FixtureScenario,
  type NodeStatusReport,
  type PreflightInput,
  type PreflightReport,
  type RpcLike
} from "@fiber-preflight/core";

type Command = "check" | "explain" | "channels" | "status" | "help";

interface CliOptions {
  command: Command;
  rpc?: string;
  token?: string;
  fixture?: string;
  invoice?: string;
  paymentHash?: string;
  amount?: string;
  maxFeeAmount?: string;
  maxFeeRate?: string;
  maxParts?: string;
  json?: boolean;
  markdown?: boolean;
  skipDryRun?: boolean;
  includeClosed?: boolean;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "help") {
    printHelp();
    return;
  }

  const { rpc, scenario } = await createRpc(options);

  if (options.command === "check") {
    const input = preflightInput(options, scenario);
    const report = await runInvoicePreflight(rpc, input);
    printReport(report, options);
    return;
  }

  if (options.command === "explain") {
    const paymentHash =
      options.paymentHash ??
      (typeof scenario?.input?.paymentHash === "string" ? scenario.input.paymentHash : undefined);
    if (!paymentHash) throw new Error("Missing --payment-hash for explain.");
    const report = await explainPayment(rpc, { paymentHash });
    printReport(report, options);
    return;
  }

  if (options.command === "channels") {
    const report = await inspectChannels(rpc, { includeClosed: options.includeClosed });
    printChannelInventory(report, options);
    return;
  }

  if (options.command === "status") {
    const report = await inspectNodeStatus(rpc, { sampleInvoice: options.invoice });
    printNodeStatus(report, options);
  }
}

function parseArgs(args: string[]): CliOptions {
  if (args[0] === "--") args.shift();
  const command = (args.shift() ?? "help") as Command;
  const options: CliOptions = {
    command: ["check", "explain", "channels", "status"].includes(command) ? command : "help"
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case "--rpc":
        options.rpc = requiredValue(arg, next);
        index += 1;
        break;
      case "--token":
        options.token = requiredValue(arg, next);
        index += 1;
        break;
      case "--fixture":
        options.fixture = requiredValue(arg, next);
        index += 1;
        break;
      case "--invoice":
        options.invoice = requiredValue(arg, next);
        index += 1;
        break;
      case "--payment-hash":
        options.paymentHash = requiredValue(arg, next);
        index += 1;
        break;
      case "--amount":
        options.amount = requiredValue(arg, next);
        index += 1;
        break;
      case "--max-fee-amount":
        options.maxFeeAmount = requiredValue(arg, next);
        index += 1;
        break;
      case "--max-fee-rate":
        options.maxFeeRate = requiredValue(arg, next);
        index += 1;
        break;
      case "--max-parts":
        options.maxParts = requiredValue(arg, next);
        index += 1;
        break;
      case "--json":
        options.json = true;
        break;
      case "--markdown":
        options.markdown = true;
        break;
      case "--skip-dry-run":
        options.skipDryRun = true;
        break;
      case "--include-closed":
        options.includeClosed = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function requiredValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

async function createRpc(options: CliOptions): Promise<{ rpc: RpcLike; scenario?: FixtureScenario }> {
  if (options.fixture) {
    const fixturePath = resolve(process.cwd(), options.fixture);
    const scenario = JSON.parse(await readFile(fixturePath, "utf8")) as FixtureScenario;
    return { rpc: new FixtureRpc(scenario), scenario };
  }

  if (!options.rpc) {
    throw new Error("Missing --rpc or --fixture.");
  }

  return {
    rpc: new FiberRpcClient({
      url: options.rpc,
      token: options.token
    })
  };
}

function preflightInput(options: CliOptions, scenario?: FixtureScenario): PreflightInput {
  const scenarioInput = scenario?.input ?? {};
  return {
    invoice: options.invoice ?? stringFromScenario(scenarioInput.invoice),
    amount: options.amount ?? stringFromScenario(scenarioInput.amount),
    maxFeeAmount: options.maxFeeAmount,
    maxFeeRate: options.maxFeeRate,
    maxParts: options.maxParts,
    skipDryRun: options.skipDryRun
  };
}

function stringFromScenario(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return undefined;
}

function printReport(report: PreflightReport, options: Pick<CliOptions, "json" | "markdown">): void {
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (options.markdown) {
    console.log(reportToMarkdown(report));
    return;
  }

  console.log(`Fiber Preflight`);
  console.log(`${report.verdict.toUpperCase()} (${report.score}/100): ${report.summary}`);
  console.log("");

  if (report.evidence.length > 0) {
    console.log("Evidence");
    for (const item of report.evidence) {
      console.log(`  ${item.label}: ${item.value}`);
    }
    console.log("");
  }

  if (report.route) {
    console.log("Route");
    console.log(`  Fee: ${report.route.fee}`);
    console.log(`  Routes: ${report.route.routeCount || 1}`);
    console.log(`  Hops: ${report.route.hopCount}`);
    for (const hop of report.route.hops.slice(0, 8)) {
      const amount = hop.amount ? ` amount ${hop.amount}` : "";
      const channel = hop.channelOutpoint ? ` via ${hop.channelOutpoint}` : "";
      console.log(`  - ${compactHash(hop.pubkey)}${amount}${channel}`);
    }
    console.log("");
  }

  if (report.probes && report.probes.length > 0) {
    console.log("Probes");
    for (const probe of report.probes) {
      const marker = probe.status === "pass" ? "[pass]" : probe.status === "fail" ? "[fail]" : "[skip]";
      console.log(`  ${marker} ${probe.label}`);
      console.log(`         ${probe.summary}`);
      if (probe.error) console.log(`         error: ${probe.error}`);
    }
    console.log("");
  }

  console.log("Checks");
  for (const check of report.checks) {
    printCheck(check);
  }

  if (report.actions.length > 0) {
    console.log("");
    console.log("Actions");
    for (const action of report.actions.slice(0, 8)) {
      console.log(`  [${action.priority}] ${action.title}`);
      console.log(`      ${action.detail}`);
      if (action.command) console.log(`      ${action.command}`);
    }
  }
}

function printChannelInventory(
  report: ChannelInventoryReport,
  options: Pick<CliOptions, "json" | "markdown">
): void {
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (options.markdown) {
    console.log(channelInventoryToMarkdown(report));
    return;
  }

  console.log("Fiber Preflight Channels");
  console.log(report.summary);
  console.log("");
  console.log("Totals");
  console.log(`  Total: ${report.totals.total}`);
  console.log(`  Ready: ${report.totals.ready}`);
  console.log(`  Enabled ready: ${report.totals.enabledReady}`);
  console.log(`  Public/private: ${report.totals.publicChannels}/${report.totals.privateChannels}`);
  console.log(`  CKB local balance: ${report.totals.ckbLocalBalance}`);
  console.log(`  UDT local balance: ${report.totals.udtLocalBalance}`);
  console.log(`  Pending TLCs: ${report.totals.pendingTlcCount}`);

  if (report.channels.length > 0) {
    console.log("");
    console.log("Channels");
    for (const channel of report.channels) {
      const flags = [
        channel.enabled ? "enabled" : "disabled",
        channel.isPublic ? "public" : "private",
        channel.isOneWay ? "one-way" : "two-way",
        channel.asset
      ].join(", ");
      console.log(`  - ${channel.channelId} peer ${channel.peer}`);
      console.log(`      ${channel.state}; ${flags}`);
      console.log(`      local ${channel.localBalance}, remote ${channel.remoteBalance}, pending TLCs ${channel.pendingTlcCount}`);
      if (channel.failureDetail) console.log(`      failure: ${channel.failureDetail}`);
    }
  }
}

function printNodeStatus(report: NodeStatusReport, options: Pick<CliOptions, "json" | "markdown">): void {
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (options.markdown) {
    console.log(nodeStatusToMarkdown(report));
    return;
  }

  console.log("Fiber Preflight Status");
  console.log(`${report.verdict.toUpperCase()} (${report.score}/100): ${report.summary}`);
  console.log("");

  if (report.evidence.length > 0) {
    console.log("Evidence");
    for (const item of report.evidence) {
      console.log(`  ${item.label}: ${item.value}`);
    }
    console.log("");
  }

  console.log("Checks");
  for (const check of report.checks) {
    printCheck(check);
  }
}

function printCheck(check: CheckResult): void {
  const marker = {
    pass: "[pass]",
    warn: "[warn]",
    fail: "[fail]",
    info: "[info]",
    skip: "[skip]"
  }[check.status];
  console.log(`  ${marker} ${check.title}`);
  console.log(`         ${check.detail}`);
  if (check.action) console.log(`         next: ${check.action}`);
}

function printHelp(): void {
  console.log(`Fiber Preflight

Usage:
  fiber-preflight check --rpc http://127.0.0.1:8227 --invoice fibt1...
  fiber-preflight check --fixture ../../fixtures/payable-route.json
  fiber-preflight explain --rpc http://127.0.0.1:8227 --payment-hash 0x...
  fiber-preflight channels --rpc http://127.0.0.1:8227
  fiber-preflight status --rpc http://127.0.0.1:8227

Options:
  --rpc <url>              Fiber JSON-RPC endpoint
  --token <token>          Biscuit bearer token
  --fixture <path>         Offline fixture scenario
  --invoice <invoice>      Fiber invoice
                            With status, this tests parse_invoice permissions
  --payment-hash <hash>    Payment hash for postmortem
  --amount <amount>        Amount for amountless invoice
  --max-fee-amount <amt>   Dry-run max fee amount
  --max-fee-rate <rate>    Dry-run max fee rate
  --max-parts <parts>      Dry-run MPP max parts
  --skip-dry-run           Do not call send_payment dry_run
  --include-closed         Include closed channels in channel inventory
  --json                   Print JSON report
  --markdown               Print Markdown report`);
}
