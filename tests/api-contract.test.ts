import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FixtureScenario, PreflightReport, RouteProbeReport } from "../packages/core/src/index.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface ApiServerHandle {
  baseUrl: string;
  process: ChildProcessWithoutNullStreams;
  output: string[];
}

let api: ApiServerHandle;

before(async () => {
  api = await startApiServer();
});

after(async () => {
  await stopApiServer(api);
});

describe("Fiber Preflight API", () => {
  test("GET /health returns service health", async () => {
    const response = await fetch(`${api.baseUrl}/health`);
    const payload = await response.json() as { ok?: boolean; service?: string };

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.service, "fiber-preflight-api");
  });

  test("OPTIONS preflight returns CORS headers", async () => {
    const response = await fetch(`${api.baseUrl}/api/preflight/check`, { method: "OPTIONS" });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-methods"), "GET,POST,OPTIONS");
    assert.match(response.headers.get("access-control-allow-headers") ?? "", /content-type/);
  });

  test("POST /api/preflight/check accepts fixture scenarios", async () => {
    const fixture = await loadFixture("mpp-needed");
    const response = await postJson<PreflightReport>("/api/preflight/check", {
      fixture,
      ...fixture.input
    });

    assert.equal(response.status, 200);
    assert.equal(response.payload.kind, "invoice-preflight");
    assert.equal(response.payload.verdict, "risky");
    assert.equal(response.payload.route?.routeCount, 2);
    assert.deepEqual(response.payload.route?.paths?.map((path) => path.label), ["Part 1", "Part 2"]);
    assert.equal(response.payload.liquidity?.status, "warn");
    assert.equal(response.payload.liquidity?.likelyNeedsMpp, true);
    assert.equal(response.payload.liquidity?.largestLocalBalance, "60,000");
    assert.equal(response.payload.runbook?.nextBestAction, "Retry with MPP with up to 12 parts");
  });

  test("POST /api/probes/route returns best MPP route settings", async () => {
    const fixture = await loadFixture("mpp-needed");
    const response = await postJson<RouteProbeReport>("/api/probes/route", {
      fixture,
      ...fixture.input
    });

    assert.equal(response.status, 200);
    assert.equal(response.payload.kind, "route-probe");
    assert.equal(response.payload.attempts.length, 20);
    assert.equal(response.payload.best?.feeRate, "25");
    assert.equal(response.payload.best?.maxParts, "4");
    assert.equal(response.payload.best?.route?.routeCount, 2);
    assert.equal(response.payload.liquidity?.status, "warn");
    assert.equal(response.payload.liquidity?.likelyNeedsMpp, true);
  });

  test("POST /api/preflight/explain explains failed payments", async () => {
    const fixture = await loadFixture("failed-payment");
    const response = await postJson<PreflightReport>("/api/preflight/explain", {
      fixture,
      paymentHash: fixture.input?.paymentHash
    });

    assert.equal(response.status, 200);
    assert.equal(response.payload.kind, "payment-postmortem");
    assert.equal(response.payload.verdict, "blocked");
    assert.equal(response.payload.route?.hopCount, 2);
    assert.equal(response.payload.runbook?.nextBestAction, "Retry with alternate routing");
  });

  test("POST /api/channels returns inventory totals", async () => {
    const fixture = await loadFixture("payable-route");
    const response = await postJson<{
      summary: string;
      totals: {
        total: number;
        ready: number;
        enabledReady: number;
        ckbLocalBalance: string;
      };
    }>("/api/channels", { fixture });

    assert.equal(response.status, 200);
    assert.equal(response.payload.summary, "2/2 channels are ready and enabled.");
    assert.equal(response.payload.totals.total, 2);
    assert.equal(response.payload.totals.ready, 2);
    assert.equal(response.payload.totals.enabledReady, 2);
    assert.equal(response.payload.totals.ckbLocalBalance, "150,000,000");
  });

  test("POST /api/status tests read module health", async () => {
    const fixture = await loadFixture("payable-route");
    const response = await postJson<{
      verdict: string;
      score: number;
      checks: Array<{ id: string; status: string }>;
    }>("/api/status", {
      fixture,
      sampleInvoice: fixture.input?.invoice
    });

    assert.equal(response.status, 200);
    assert.equal(response.payload.verdict, "ready");
    assert.equal(response.payload.score, 100);
    assert.deepEqual(
      response.payload.checks.map((check) => `${check.id}:${check.status}`),
      [
        "status.node_info:pass",
        "status.list_peers:pass",
        "status.list_channels:pass",
        "status.graph_nodes:pass",
        "status.graph_channels:pass",
        "status.list_payments:pass",
        "status.parse_invoice:pass"
      ]
    );
  });

  test("POST /api/preflight/explain validates required paymentHash", async () => {
    const fixture = await loadFixture("failed-payment");
    const response = await postJson<{ error: string }>("/api/preflight/explain", { fixture });

    assert.equal(response.status, 400);
    assert.equal(response.payload.error, "paymentHash is required");
  });

  test("POST endpoints reject invalid JSON", async () => {
    const response = await fetch(`${api.baseUrl}/api/channels`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json"
    });
    const payload = await response.json() as { error?: string };

    assert.equal(response.status, 400);
    assert.equal(payload.error, "Invalid JSON body");
  });

  test("POST endpoints require rpcUrl or fixture", async () => {
    const response = await postJson<{ error: string }>("/api/channels", {});

    assert.equal(response.status, 400);
    assert.equal(response.payload.error, "rpcUrl or fixture is required");
  });
});

async function startApiServer(): Promise<ApiServerHandle> {
  const port = await getOpenPort();
  const output: string[] = [];
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      CORS_ORIGIN: "http://127.0.0.1:5175"
    },
    windowsHide: true
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, child, output);
  return { baseUrl, process: child, output };
}

async function stopApiServer(handle: ApiServerHandle | undefined): Promise<void> {
  if (!handle || handle.process.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    handle.process.once("exit", () => resolve());
    handle.process.kill();
    setTimeout(resolve, 2_000).unref();
  });
}

async function waitForHealth(
  baseUrl: string,
  child: ChildProcessWithoutNullStreams,
  output: string[]
): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`API server exited before health check passed:\n${output.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Retry until the HTTP listener is ready.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for API server:\n${output.join("")}`);
}

async function postJson<T>(
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; payload: T }> {
  const response = await fetch(`${api.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return {
    status: response.status,
    payload: await response.json() as T
  };
}

async function loadFixture(name: string): Promise<FixtureScenario> {
  const path = resolve(projectRoot, "fixtures", `${name}.json`);
  return JSON.parse(await readFile(path, "utf8")) as FixtureScenario;
}

async function getOpenPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a test port"));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
