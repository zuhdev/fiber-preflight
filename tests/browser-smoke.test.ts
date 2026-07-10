import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

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

async function startWebServer(port: number): Promise<{ origin: string; stop: () => Promise<void> }> {
  const origin = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  const pnpm = pnpmInvocation([
    "--filter",
    "@fiber-preflight/web",
    "dev",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort"
  ]);
  const child = spawn(pnpm.command, pnpm.args, {
    cwd: repoRoot,
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

function pnpmInvocation(args: string[]): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", "pnpm", ...args] };
  }
  return { command: "pnpm", args };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
