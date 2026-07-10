#!/usr/bin/env tsx
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { FiberRpcClient } from "../packages/core/src/rpc.js";

interface JudgeProofConfig {
  senderRpcUrl: string;
  receiverRpcUrl: string;
  apiUrl: string;
  dashboardUrl: string;
  timeoutMs: number;
  amount: string;
  currency: string;
  expirySeconds: string;
  description: string;
  outRoot: string;
  nodeBin: string;
  cliBin: string;
  nodeConfig: string;
  senderDir: string;
  receiverDir: string;
  startNodes: boolean;
  startServices: boolean;
  openDashboard: boolean;
  autoLive: boolean;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

const args = parseArgs(process.argv.slice(2));
const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  if (flag("help") || flag("h")) {
    printHelp();
    return;
  }

  const config = readConfig();
  await mkdir(config.outRoot, { recursive: true });

  requireFile(config.cliBin, "Fiber CLI binary");
  if (config.startNodes) {
    requireFile(config.nodeBin, "Fiber node binary");
    requireFile(config.nodeConfig, "Fiber testnet config");
  }

  console.log("Fiber Preflight judge proof automation");
  console.log(`Sender RPC:   ${config.senderRpcUrl}`);
  console.log(`Receiver RPC: ${config.receiverRpcUrl}`);
  console.log("");

  await ensureFiberNode("sender", config.senderRpcUrl, config, senderNodeArgs(config));
  await ensureFiberNode("receiver", config.receiverRpcUrl, config, receiverNodeArgs(config));

  const invoice = await mintInvoice(config);
  const runId = timestampSlug(new Date());
  const proofDir = join(config.outRoot, runId);
  await mkdir(proofDir, { recursive: true });

  const proofArgs = [
    "live:proof",
    "--",
    "--rpc",
    config.senderRpcUrl,
    "--timeout-ms",
    String(config.timeoutMs),
    "--invoice",
    invoice,
    "--probe",
    "--expect-payable",
    "--out-dir",
    proofDir
  ];

  console.log("");
  console.log("Running live proof...");
  await runShellCommand(["pnpm", ...proofArgs], { cwd: workspaceRoot });

  if (config.startServices) {
    await ensureHttpService("API", `${trimTrailingSlash(config.apiUrl)}/health`, apiServiceCommand(config), config);
    await ensureHttpService("dashboard", config.dashboardUrl, webServiceCommand(config), config);
  }

  const dashboardProofUrl = buildDashboardProofUrl(config, invoice);
  const latest = {
    generatedAt: new Date().toISOString(),
    senderRpcUrl: config.senderRpcUrl,
    receiverRpcUrl: config.receiverRpcUrl,
    apiUrl: config.apiUrl,
    dashboardUrl: dashboardProofUrl,
    invoice,
    amount: config.amount,
    proofDir,
    summaryPath: join(proofDir, "proof-summary.md"),
    command: `pnpm live:proof -- --rpc ${config.senderRpcUrl} --invoice ${invoice} --probe --expect-payable --out-dir ${proofDir}`,
    dashboardSteps: [
      "Open the dashboard URL.",
      "The invoice and Live RPC source are prefilled.",
      "If autoLive=1 is present, the dashboard runs the live proof automatically.",
      "Confirm the Judge Proof panel reads live verified."
    ]
  };

  await writeFile(join(config.outRoot, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`, "utf8");
  await writeFile(join(config.outRoot, "latest-invoice.txt"), `${invoice}\n`, "utf8");
  await writeFile(join(config.outRoot, "latest-dashboard-url.txt"), `${dashboardProofUrl}\n`, "utf8");

  if (config.openDashboard) openUrl(dashboardProofUrl);

  console.log("");
  console.log("Judge proof is ready.");
  console.log(`Invoice:       ${invoice}`);
  console.log(`Proof summary: ${latest.summaryPath}`);
  console.log(`Dashboard:     ${dashboardProofUrl}`);
  console.log(`Handoff:       ${join(config.outRoot, "latest.json")}`);
}

async function ensureFiberNode(
  label: "sender" | "receiver",
  rpcUrl: string,
  config: JudgeProofConfig,
  startArgs: string[]
): Promise<void> {
  if (await rpcReady(rpcUrl, config.timeoutMs)) {
    console.log(`${title(label)} node RPC is already reachable.`);
    return;
  }

  if (!config.startNodes) {
    throw new Error(`${title(label)} node RPC is not reachable at ${rpcUrl}. Start it or rerun without --no-start-nodes.`);
  }

  console.log(`Starting ${label} Fiber node...`);
  startDetached(config.nodeBin, startArgs, {
    cwd: workspaceRoot,
    logBase: join(config.outRoot, `${label}-node`)
  });
  await waitFor(`${label} RPC`, () => rpcReady(rpcUrl, config.timeoutMs), 75_000);
}

async function ensureHttpService(
  label: string,
  healthUrl: string,
  command: { bin: string; args: string[]; logName: string },
  config: JudgeProofConfig
): Promise<void> {
  if (await httpReady(healthUrl)) {
    console.log(`${label} is already reachable.`);
    return;
  }

  console.log(`Starting ${label}...`);
  startDetached(command.bin, command.args, {
    cwd: workspaceRoot,
    logBase: join(config.outRoot, command.logName),
    shell: true
  });
  await waitFor(label, () => httpReady(healthUrl), 60_000);
}

async function rpcReady(rpcUrl: string, timeoutMs: number): Promise<boolean> {
  try {
    await new FiberRpcClient({ url: rpcUrl, timeoutMs }).call("node_info");
    return true;
  } catch {
    return false;
  }
}

async function httpReady(url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function mintInvoice(config: JudgeProofConfig): Promise<string> {
  console.log("Minting fresh receiver invoice...");
  const result = await runCommand(config.cliBin, [
    "--url",
    config.receiverRpcUrl,
    "--raw-data",
    "--output-format",
    "json",
    "invoice",
    "new_invoice",
    "--amount",
    config.amount,
    "--currency",
    config.currency,
    "--description",
    config.description,
    "--expiry",
    config.expirySeconds,
    "--allow-mpp",
    "false",
    "--allow-trampoline-routing",
    "false"
  ], { cwd: workspaceRoot, echo: false });

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Could not parse invoice response as JSON: ${result.stdout || result.stderr}`);
  }

  const invoice = readStringProperty(parsed, "invoice_address") ?? readStringProperty(parsed, "invoiceAddress");
  if (!invoice) throw new Error(`Invoice response did not include invoice_address: ${result.stdout}`);
  return invoice;
}

function senderNodeArgs(config: JudgeProofConfig): string[] {
  return ["--config", config.nodeConfig, "--dir", config.senderDir];
}

function receiverNodeArgs(config: JudgeProofConfig): string[] {
  return [
    "--config",
    config.nodeConfig,
    "--dir",
    config.receiverDir,
    "--fiber-listening-addr",
    "/ip4/127.0.0.1/tcp/8428",
    "--fiber-announced-addrs",
    "/ip4/127.0.0.1/tcp/8428",
    "--fiber-announce-listening-addr",
    "true",
    "--fiber-announce-private-addr",
    "true",
    "--fiber-announced-node-name",
    "fiber-preflight-node-c",
    "--rpc-listening-addr",
    "127.0.0.1:8427",
    "--fiber-open-channel-auto-accept-min-ckb-funding-amount",
    "100000000",
    "--fiber-auto-accept-channel-ckb-funding-amount",
    "9900000000",
    "--fiber-min-outbound-peers",
    "0"
  ];
}

function apiServiceCommand(config: JudgeProofConfig): { bin: string; args: string[]; logName: string } {
  return {
    bin: "pnpm",
    args: ["--filter", "@fiber-preflight/api", "dev"],
    logName: "api"
  };
}

function webServiceCommand(config: JudgeProofConfig): { bin: string; args: string[]; logName: string } {
  const url = new URL(config.dashboardUrl);
  return {
    bin: "pnpm",
    args: ["--filter", "@fiber-preflight/web", "dev", "--host", url.hostname, "--port", url.port || "5176"],
    logName: "web"
  };
}

function buildDashboardProofUrl(config: JudgeProofConfig, invoice: string): string {
  const url = new URL(config.dashboardUrl);
  url.searchParams.set("source", "live");
  url.searchParams.set("mode", "check");
  url.searchParams.set("rpcUrl", config.senderRpcUrl);
  url.searchParams.set("apiUrl", config.apiUrl);
  url.searchParams.set("invoice", invoice);
  url.searchParams.set("autoLive", config.autoLive ? "1" : "0");
  return url.toString();
}

function startDetached(
  bin: string,
  commandArgs: string[],
  options: { cwd: string; logBase: string; shell?: boolean }
): void {
  const out = openSync(`${options.logBase}.out.log`, "a");
  const err = openSync(`${options.logBase}.err.log`, "a");
  const child = spawn(bin, commandArgs, {
    cwd: options.cwd,
    detached: true,
    shell: options.shell ?? false,
    stdio: ["ignore", out, err],
    windowsHide: true
  });
  child.unref();
  closeSync(out);
  closeSync(err);
}

async function runCommand(
  bin: string,
  commandArgs: string[],
  options: { cwd: string; shell?: boolean; echo?: boolean }
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, commandArgs, {
      cwd: options.cwd,
      shell: options.shell ?? false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (options.echo !== false) process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (options.echo !== false) process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(new Error(`${bin} ${commandArgs.join(" ")} failed with exit code ${code}.`));
    });
  });
}

async function runShellCommand(commandParts: string[], options: { cwd: string }): Promise<CommandResult> {
  const commandLine = commandParts.map(quoteShellArg).join(" ");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(commandLine, {
      cwd: options.cwd,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(new Error(`${commandLine} failed with exit code ${code}.`));
    });
  });
}

async function waitFor(label: string, probe: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await probe()) return;
    await sleep(1_000);
  }
  throw new Error(`${label} did not become reachable within ${timeoutMs}ms.`);
}

function readConfig(): JudgeProofConfig {
  const artifactRoot = join(workspaceRoot, "artifacts", "fiber-node");
  const ext = process.platform === "win32" ? ".exe" : "";
  return {
    senderRpcUrl: option("sender-rpc") ?? env("FIBER_PREFLIGHT_SENDER_RPC") ?? "http://127.0.0.1:8227",
    receiverRpcUrl: option("receiver-rpc") ?? env("FIBER_PREFLIGHT_RECEIVER_RPC") ?? "http://127.0.0.1:8427",
    apiUrl: option("api-url") ?? env("FIBER_PREFLIGHT_API_URL") ?? "http://127.0.0.1:8787",
    dashboardUrl: option("dashboard-url") ?? env("FIBER_PREFLIGHT_DASHBOARD_URL") ?? "http://127.0.0.1:5176/",
    timeoutMs: Number(option("timeout-ms") ?? env("FIBER_PREFLIGHT_TIMEOUT_MS") ?? "15000"),
    amount: option("amount") ?? env("FIBER_PREFLIGHT_AMOUNT") ?? "1000000",
    currency: option("currency") ?? env("FIBER_PREFLIGHT_CURRENCY") ?? "Fibt",
    expirySeconds: option("expiry") ?? env("FIBER_PREFLIGHT_INVOICE_EXPIRY") ?? "3600",
    description: option("description") ?? "fiber-preflight-judge-proof",
    outRoot: resolvePath(option("out-dir") ?? "artifacts/judge-proof"),
    nodeBin: resolvePath(option("node-bin") ?? join(artifactRoot, `fnn${ext}`)),
    cliBin: resolvePath(option("cli-bin") ?? join(artifactRoot, `fnn-cli${ext}`)),
    nodeConfig: resolvePath(option("node-config") ?? join(artifactRoot, "config", "testnet", "config.yml")),
    senderDir: resolvePath(option("sender-dir") ?? join(artifactRoot, "testnet-data")),
    receiverDir: resolvePath(option("receiver-dir") ?? join(artifactRoot, "testnet-data-c")),
    startNodes: !flag("no-start-nodes"),
    startServices: !flag("no-services"),
    openDashboard: !flag("no-open"),
    autoLive: !flag("no-auto-live")
  };
}

function parseArgs(values: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (arg === "--") continue;
    if (!arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
    const key = arg.slice(2);
    if (["help", "h", "no-start-nodes", "no-services", "no-open", "no-auto-live"].includes(key)) {
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

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value : undefined;
}

function resolvePath(value: string): string {
  return isAbsolute(value) ? value : join(workspaceRoot, value);
}

function requireFile(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" && property.trim() ? property : undefined;
}

function timestampSlug(value: Date): string {
  return value.toISOString().replace(/[:.]/g, "-");
}

function title(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  if (process.platform === "win32") return `"${value.replace(/"/g, '\\"')}"`;
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

function openUrl(url: string): void {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return;
  }
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
}

function printHelp(): void {
  console.log(`Fiber Preflight judge proof automation

Usage:
  pnpm judge:proof
  pnpm judge:proof -- --no-open

What it does:
  1. Ensures the local sender and receiver Fiber testnet nodes are reachable.
  2. Starts missing local nodes when artifacts/fiber-node exists.
  3. Mints a fresh receiver invoice.
  4. Runs pnpm live:proof with --probe --expect-payable.
  5. Starts local API/web services when needed.
  6. Opens the dashboard with the invoice prefilled and autoLive=1.

Common flags:
  --sender-rpc <url>       Default http://127.0.0.1:8227
  --receiver-rpc <url>     Default http://127.0.0.1:8427
  --api-url <url>          Default http://127.0.0.1:8787
  --dashboard-url <url>    Default http://127.0.0.1:5176/
  --amount <amount>        Default 1000000
  --out-dir <path>         Default artifacts/judge-proof
  --no-start-nodes         Require nodes to already be running
  --no-services            Do not start API or web dashboard
  --no-open                Do not open the dashboard URL
  --no-auto-live           Prefill dashboard but do not auto-run live proof`);
}
