import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Page, type Route } from "playwright";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const webRoot = join(repoRoot, "apps/web");
const viteBin = join(webRoot, "node_modules/vite/bin/vite.js");

test("dashboard judge proof demo works in a real browser", { timeout: 90_000 }, async (t) => {
  const port = await getFreePort();
  const web = await startWebServer(port);
  t.after(() => web.stop());

  const browser = await chromium.launch();
  t.after(() => browser.close());

  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const browserErrors = collectBrowserErrors(page);

  await page.goto(web.origin, { waitUntil: "networkidle" });
  await expectVisibleText(page, "Payment readiness and route diagnostics");
  await expectVisibleText(page, "Proof Mode");
  await expectVisibleText(page, "Probe demo");
  await expectVisibleText(page, "Live proof");

  await page.getByRole("button", { name: "Run demo" }).click();

  await expectVisibleText(page, "Route found");
  await expectVisibleText(page, "demo verified");
  await expectVisibleText(page, "Best setting");
  await expectVisibleText(page, "Best route graph");
  await expectVisibleText(page, "Part 1");
  await expectVisibleText(page, "Part 2");
  await expectVisibleText(page, "Runbook");
  await expectVisibleText(page, "Use the best passing dry-run setting");

  assert.equal(await page.locator(".error").count(), 0, "dashboard should not render an app error");
  assert.deepEqual(browserErrors(), [], "browser console/page errors should stay clean");
});

test("dashboard auto-runs live proof from a judge proof URL", { timeout: 90_000 }, async (t) => {
  const port = await getFreePort();
  const web = await startWebServer(port);
  t.after(() => web.stop());

  const browser = await chromium.launch();
  t.after(() => browser.close());

  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const browserErrors = collectBrowserErrors(page);
  const apiCalls: string[] = [];
  await installAutoLiveApiMock(page, apiCalls);

  const url = new URL(web.origin);
  url.searchParams.set("source", "live");
  url.searchParams.set("mode", "check");
  url.searchParams.set("rpcUrl", "http://127.0.0.1:8227");
  url.searchParams.set("apiUrl", web.origin);
  url.searchParams.set("invoice", "fibt1autoliveproofinvoice");
  url.searchParams.set("autoLive", "1");

  await page.goto(url.toString(), { waitUntil: "domcontentloaded" });

  await expectVisibleText(page, "Auto proof");
  await expectVisibleText(page, "live verified");
  await expectVisibleText(page, "Testnet");
  await expectVisibleText(page, "Live proof");
  await expectVisibleText(page, "Verified");
  await expectVisibleText(page, "1/1 channels are ready and enabled");
  await expectVisibleText(page, "Best route");

  assert.equal(await page.locator(".error").count(), 0, "dashboard should not render an app error");
  assert.deepEqual(
    apiCalls,
    ["/api/status", "/api/channels", "/api/preflight/check", "/api/probes/route"],
    "auto-live should call each proof endpoint once"
  );
  assert.deepEqual(browserErrors(), [], "browser console/page errors should stay clean");
});

async function expectVisibleText(page: Page, text: string): Promise<void> {
  await page.getByText(text, { exact: false }).first().waitFor({ state: "visible", timeout: 10_000 });
}

function collectBrowserErrors(page: Page): () => string[] {
  const errors: string[] = [];

  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  return () => errors;
}

async function installAutoLiveApiMock(page: Page, apiCalls: string[]): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders() });
      return;
    }

    apiCalls.push(url.pathname);
    await fulfillJson(route, autoLiveResponse(url.pathname));
  });
}

async function fulfillJson(route: Route, payload: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    headers: corsHeaders(),
    contentType: "application/json",
    body: JSON.stringify(payload)
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization"
  };
}

function autoLiveResponse(pathname: string): unknown {
  if (pathname === "/api/status") return nodeStatusReport;
  if (pathname === "/api/channels") return channelInventoryReport;
  if (pathname === "/api/preflight/check") return preflightReport;
  if (pathname === "/api/probes/route") return routeProbeReport;
  return { error: `Unexpected API route: ${pathname}` };
}

async function startWebServer(port: number): Promise<{ origin: string; stop: () => Promise<void> }> {
  const origin = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  const child = spawn(process.execPath, [
    viteBin,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort"
  ], {
    cwd: webRoot,
    env: {
      ...process.env,
      BROWSER: "none"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  await waitForHttp(origin, child, logs);

  return {
    origin,
    stop: () => stopProcess(child)
  };
}

async function waitForHttp(origin: string, child: ChildProcessWithoutNullStreams, logs: string[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Web server exited with code ${child.exitCode}.\n${logs.join("")}`);
    }

    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }

    await sleep(250);
  }

  throw new Error(`Timed out waiting for ${origin}: ${String(lastError)}\n${logs.join("")}`);
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;

  if (process.platform === "win32" && child.pid) {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      killer.once("close", () => resolve());
      killer.once("error", () => resolve());
    });
    return;
  }

  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a TCP port.")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const nodeStatusReport = {
  kind: "node-status",
  verdict: "ready",
  score: 100,
  summary: "Fiber RPC is ready for preflight checks.",
  checks: [
    {
      id: "status.node_info",
      category: "rpc",
      status: "pass",
      title: "Node info reachable",
      detail: "Connected to auto-live test node"
    }
  ],
  evidence: [
    { label: "Node", value: "auto-live-node" },
    { label: "Pubkey", value: "023780cc...036662" }
  ]
};

const channelInventoryReport = {
  summary: "1/1 channels are ready and enabled.",
  totals: {
    total: 1,
    ready: 1,
    enabledReady: 1,
    publicChannels: 0,
    privateChannels: 1,
    ckbLocalBalance: "100,000,000",
    udtLocalBalance: "0",
    pendingTlcCount: 0
  },
  channels: [
    {
      channelId: "0xb03c6afeef30227de285309c9c4fc968eb1467f3818bec81211b15f12437dbfb",
      channelOutpoint: "0x2c3240e3d8592c1ef959c7008a4b3f5b5253a4de9d3dd075b3ed79a24f246f3500000000",
      peer: "026a5a65...f62874",
      state: "ChannelReady",
      enabled: true,
      isPublic: false,
      isOneWay: false,
      isAcceptor: false,
      asset: "CKB",
      localBalance: "100,000,000",
      remoteBalance: "0",
      pendingTlcCount: 0
    }
  ],
  pendingChannels: []
};

const preflightReport = {
  kind: "invoice-preflight",
  verdict: "risky",
  score: 60,
  summary: "This payment may work, but Fiber Preflight found risk factors.",
  checks: [],
  actions: [],
  evidence: [{ label: "Invoice amount", value: "1,000,000" }]
};

const bestRouteAttempt = {
  id: "fee-25-parts-1",
  label: "Fee 25 / 1 part",
  status: "pass",
  summary: "fee 0, 0 hops",
  feeRate: "25",
  maxParts: "1",
  fee: "0",
  hopCount: 0,
  params: {
    dry_run: true,
    max_fee_rate: "0x19",
    max_parts: "0x1"
  },
  route: {
    fee: "0",
    routeCount: 1,
    hopCount: 0,
    hops: []
  }
};

const routeProbeReport = {
  kind: "route-probe",
  verdict: "payable",
  score: 96,
  summary: "Best dry-run setting: max fee rate 25, max parts 1, estimated fee 0.",
  attempts: [bestRouteAttempt],
  best: bestRouteAttempt,
  evidence: [{ label: "Best setting", value: "fee 25, parts 1" }],
  actions: [],
  runbook: {
    summary: "1 ready action, 0 blockers, verdict payable.",
    nextBestAction: "Use the best passing dry-run setting",
    steps: [
      {
        id: "use-best-setting",
        priority: "high",
        status: "ready",
        title: "Use the best passing dry-run setting",
        detail: "Set max fee rate to 25 and max parts to 1. Estimated fee: 0.",
        owner: "wallet",
        params: {
          dry_run: "true",
          max_fee_rate: "0x19",
          max_parts: "0x1"
        }
      }
    ]
  }
};
