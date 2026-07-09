import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  FixtureRpc,
  explainPayment,
  inspectChannels,
  inspectNodeStatus,
  probeRouteOptions,
  reportToMarkdown,
  routeProbeToMarkdown,
  runInvoicePreflight,
  type CheckResult,
  type FixtureScenario,
  type PreflightReport
} from "../packages/core/src/index.js";

const execFile = promisify(execFileCallback);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

interface ExpectedPreflight {
  fixture: string;
  verdict: PreflightReport["verdict"];
  score: number;
  route?: {
    fee: string;
    routeCount: number;
    hopCount: number;
    pathLabels: string[];
  };
  checks: Record<string, CheckResult["status"]>;
  probeStatuses?: Record<string, "pass" | "fail" | "skip">;
  nextAction: string;
}

const preflightCases: ExpectedPreflight[] = [
  {
    fixture: "payable-route",
    verdict: "payable",
    score: 100,
    route: { fee: "100", routeCount: 1, hopCount: 3, pathLabels: ["Route"] },
    checks: {
      "rpc.node_info": "pass",
      "invoice.expiry": "pass",
      "route.dry_run": "pass"
    },
    nextAction: "Pay with current route settings"
  },
  {
    fixture: "expired-invoice",
    verdict: "blocked",
    score: 26,
    checks: {
      "invoice.expiry": "fail",
      "route.dry_run": "fail"
    },
    probeStatuses: {
      "higher-fee": "skip",
      mpp: "skip"
    },
    nextAction: "Request a fresh invoice"
  },
  {
    fixture: "insufficient-liquidity",
    verdict: "blocked",
    score: 42,
    checks: {
      "liquidity.asset_balance": "fail",
      "route.dry_run": "fail"
    },
    probeStatuses: {
      "higher-fee": "fail",
      mpp: "fail"
    },
    nextAction: "Open, receive, or rebalance liquidity for this asset"
  },
  {
    fixture: "fee-too-low",
    verdict: "blocked",
    score: 75,
    checks: {
      "route.dry_run": "fail"
    },
    probeStatuses: {
      "higher-fee": "fail",
      mpp: "fail"
    },
    nextAction: "Raise the fee cap"
  },
  {
    fixture: "mpp-needed",
    verdict: "risky",
    score: 84,
    route: { fee: "200", routeCount: 2, hopCount: 6, pathLabels: ["Part 1", "Part 2"] },
    checks: {
      "liquidity.single_channel_capacity": "warn",
      "route.dry_run": "warn",
      "route.probe_success": "pass"
    },
    probeStatuses: {
      "higher-fee": "fail",
      mpp: "pass"
    },
    nextAction: "Retry with MPP with up to 12 parts"
  }
];

describe("invoice preflight fixtures", () => {
  for (const expected of preflightCases) {
    test(`${expected.fixture} produces the expected report`, async () => {
      const scenario = await loadFixture(expected.fixture);
      const report = await runInvoicePreflight(new FixtureRpc(scenario), scenario.input ?? {});

      assert.equal(report.kind, "invoice-preflight");
      assert.equal(report.verdict, expected.verdict);
      assert.equal(report.score, expected.score);
      assert.equal(report.runbook?.nextBestAction, expected.nextAction);
      assert.ok((report.runbook?.steps.length ?? 0) > 0, "expected a runbook");

      assertCheckStatuses(report, expected.checks);

      if (expected.route) {
        assert.ok(report.route, "expected a route summary");
        assert.equal(report.route.fee, expected.route.fee);
        assert.equal(report.route.routeCount, expected.route.routeCount);
        assert.equal(report.route.hopCount, expected.route.hopCount);
        assert.deepEqual(
          report.route.paths?.map((path) => path.label),
          expected.route.pathLabels
        );
      } else {
        assert.equal(report.route, undefined);
      }

      if (expected.probeStatuses) {
        const probes = new Map(report.probes?.map((probe) => [probe.id, probe.status]));
        for (const [id, status] of Object.entries(expected.probeStatuses)) {
          assert.equal(probes.get(id), status);
        }
      }
    });
  }
});

test("MPP route markdown preserves split route parts", async () => {
  const scenario = await loadFixture("mpp-needed");
  const report = await runInvoicePreflight(new FixtureRpc(scenario), scenario.input ?? {});
  const markdown = reportToMarkdown(report);

  assert.match(markdown, /## Route/);
  assert.match(markdown, /Part 1/);
  assert.match(markdown, /Part 2/);
  assert.match(markdown, /50,000/);
});

test("Probe Lab finds the best MPP setting and exports its route", async () => {
  const scenario = await loadFixture("mpp-needed");
  const report = await probeRouteOptions(new FixtureRpc(scenario), scenario.input ?? {});

  assert.equal(report.verdict, "risky");
  assert.equal(report.attempts.length, 20);
  assert.equal(report.attempts.filter((attempt) => attempt.status === "pass").length, 12);
  assert.equal(report.best?.feeRate, "25");
  assert.equal(report.best?.maxParts, "4");
  assert.equal(report.best?.route?.routeCount, 2);
  assert.deepEqual(report.best?.route?.paths?.map((path) => path.label), ["Part 1", "Part 2"]);
  assert.equal(report.runbook?.nextBestAction, "Use the best passing dry-run setting");

  const markdown = routeProbeToMarkdown(report);
  assert.match(markdown, /## Best Route/);
  assert.match(markdown, /Part 2/);
});

test("failed payment fixture explains the postmortem route and blocker", async () => {
  const scenario = await loadFixture("failed-payment");
  const report = await explainPayment(new FixtureRpc(scenario), {
    paymentHash: String(scenario.input?.paymentHash)
  });

  assert.equal(report.kind, "payment-postmortem");
  assert.equal(report.verdict, "blocked");
  assert.equal(report.score, 67);
  assert.equal(report.route?.fee, "0");
  assert.equal(report.route?.hopCount, 2);
  assert.deepEqual(report.route?.paths?.map((path) => path.label), ["Route"]);
  assertCheckStatuses(report, {
    "postmortem.failure": "fail",
    "liquidity.pending_tlcs": "warn"
  });
  assert.equal(report.runbook?.nextBestAction, "Retry with alternate routing");
});

test("channel inventory summarizes payable-route liquidity", async () => {
  const scenario = await loadFixture("payable-route");
  const report = await inspectChannels(new FixtureRpc(scenario));

  assert.equal(report.summary, "2/2 channels are ready and enabled.");
  assert.deepEqual(report.totals, {
    total: 2,
    ready: 2,
    enabledReady: 2,
    publicChannels: 2,
    privateChannels: 0,
    ckbLocalBalance: "150,000,000",
    udtLocalBalance: "0",
    pendingTlcCount: 0
  });
});

test("node status fixture checks all read modules", async () => {
  const scenario = await loadFixture("payable-route");
  const report = await inspectNodeStatus(new FixtureRpc(scenario), {
    sampleInvoice: String(scenario.input?.invoice)
  });

  assert.equal(report.verdict, "ready");
  assert.equal(report.score, 100);
  assertCheckStatuses(report, {
    "status.node_info": "pass",
    "status.list_peers": "pass",
    "status.list_channels": "pass",
    "status.graph_nodes": "pass",
    "status.graph_channels": "pass",
    "status.list_payments": "pass",
    "status.parse_invoice": "pass"
  });
});

test("CLI check output includes MPP route parts", async () => {
  const command = pnpmCommand([
    "--filter",
    "@fiber-preflight/cli",
    "start",
    "--",
    "check",
    "--fixture",
    "../../fixtures/mpp-needed.json"
  ]);
  const { stdout } = await execFile(command.file, command.args, {
    cwd: projectRoot,
    timeout: 120_000,
    windowsHide: true
  });

  assert.match(stdout, /RISKY \(84\/100\)/);
  assert.match(stdout, /Part 1: 3 hop\(s\) amount 50,000/);
  assert.match(stdout, /Part 2: 3 hop\(s\) amount 50,000/);
});

async function loadFixture(name: string): Promise<FixtureScenario> {
  const path = resolve(projectRoot, "fixtures", `${name}.json`);
  return JSON.parse(await readFile(path, "utf8")) as FixtureScenario;
}

function assertCheckStatuses(
  report: Pick<PreflightReport, "checks">,
  expected: Record<string, CheckResult["status"]>
): void {
  const checks = new Map(report.checks.map((check) => [check.id, check.status]));
  for (const [id, status] of Object.entries(expected)) {
    assert.equal(checks.get(id), status, `unexpected status for ${id}`);
  }
}

function pnpmCommand(args: string[]): { file: string; args: string[] } {
  if (process.platform !== "win32") return { file: pnpm, args };
  return { file: "cmd.exe", args: ["/d", "/s", "/c", ["pnpm", ...args].join(" ")] };
}
