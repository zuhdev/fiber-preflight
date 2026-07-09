import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  FixtureRpc,
  buildSupportBundle,
  redactForSupportBundle,
  runInvoicePreflight,
  type FixtureScenario,
  type PreflightReport
} from "../packages/core/src/index.js";

const execFile = promisify(execFileCallback);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("support bundle redaction", () => {
  test("builds a shareable preflight bundle without raw RPC payloads or full invoice identifiers", async () => {
    const scenario = await loadFixture("payable-route");
    const report = await runInvoicePreflight(new FixtureRpc(scenario), scenario.input ?? {});
    const bundle = buildSupportBundle(report, {
      generatedAt: "2026-07-09T20:00:00.000Z",
      source: "web"
    });
    const bundleText = JSON.stringify(bundle, null, 2);
    const redactedReport = bundle.report as PreflightReport;

    assert.equal(bundle.kind, "fiber-preflight-support-bundle");
    assert.equal(bundle.version, 1);
    assert.equal(bundle.generatedAt, "2026-07-09T20:00:00.000Z");
    assert.equal(bundle.source, "web");
    assert.equal(bundle.reportKind, "invoice-preflight");
    assert.equal(bundle.verdict, "payable");
    assert.equal(bundle.score, 100);
    assert.equal(bundle.privacy.rawRpcPayloadsIncluded, false);
    assert.equal(redactedReport.route?.hopCount, 3);
    assert.match(bundleText, /raw RPC payload omitted/);
    assert.doesNotMatch(bundleText, /fibt1payableroute/);
    assert.doesNotMatch(bundleText, /0x9999999999999999999999999999999999999999999999999999999999999999/);
    assert.match(bundleText, /0x999999\.\.\.999999/);
  });

  test("redacts sensitive keys recursively", () => {
    const redacted = redactForSupportBundle({
      token: "short-demo-token",
      nested: {
        invoice: "fibt1payableroute",
        signature: "0xdemo",
        payment_hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      summary: "route failed for fibt1payableroute with hash 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    });
    const text = JSON.stringify(redacted);

    assert.doesNotMatch(text, /short-demo-token/);
    assert.doesNotMatch(text, /fibt1payableroute/);
    assert.doesNotMatch(text, /0xdemo/);
    assert.doesNotMatch(text, /0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
    assert.match(text, /\[redacted: invoice\]/);
    assert.match(text, /0xaaaaaa\.\.\.aaaaaa/);
    assert.match(text, /0xbbbbbb\.\.\.bbbbbb/);
  });

  test("CLI --bundle emits a support bundle", async () => {
    const command = pnpmCommand([
      "--filter",
      "@fiber-preflight/cli",
      "start",
      "--",
      "check",
      "--fixture",
      "../../fixtures/payable-route.json",
      "--bundle"
    ]);
    const { stdout } = await execFile(command.file, command.args, {
      cwd: projectRoot,
      timeout: 120_000,
      windowsHide: true
    });
    const payload = JSON.parse(stdout) as { kind?: string; reportKind?: string; source?: string; report?: unknown };
    const outputText = JSON.stringify(payload);

    assert.equal(payload.kind, "fiber-preflight-support-bundle");
    assert.equal(payload.reportKind, "invoice-preflight");
    assert.equal(payload.source, "cli");
    assert.doesNotMatch(outputText, /fibt1payableroute/);
    assert.match(outputText, /raw RPC payload omitted/);
  });
});

async function loadFixture(name: string): Promise<FixtureScenario> {
  const path = resolve(projectRoot, "fixtures", `${name}.json`);
  return JSON.parse(await readFile(path, "utf8")) as FixtureScenario;
}

function pnpmCommand(args: string[]): { file: string; args: string[] } {
  if (process.platform !== "win32") return { file: "pnpm", args };
  return { file: "cmd.exe", args: ["/d", "/s", "/c", ["pnpm", ...args].join(" ")] };
}
