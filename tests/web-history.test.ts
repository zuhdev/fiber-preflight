import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PreflightReport, RouteProbeReport } from "../packages/core/src/index.js";
import {
  HISTORY_LIMIT,
  HISTORY_STORAGE_KEY,
  createReportHistoryItem,
  loadReportHistory,
  saveReportHistory,
  upsertReportHistory,
  type ReportHistoryItem
} from "../apps/web/src/history.js";

describe("web report history", () => {
  test("creates demo preflight history labels without sensitive fields", () => {
    const item = createReportHistoryItem(preflightReport, {
      mode: "check",
      source: "demo",
      scenarioName: "Payable route",
      rpcUrl: "http://127.0.0.1:8227"
    }, new Date("2026-07-09T20:00:00.000Z"));

    assert.equal(item.label, "Check - Payable route");
    assert.equal(item.mode, "check");
    assert.equal(item.source, "demo");
    assert.equal(item.verdict, "payable");
    assert.equal(item.score, 98);
    assert.equal(item.createdAt, "2026-07-09T20:00:00.000Z");
    assert.equal(JSON.stringify(item).includes("optional-biscuit-token"), false);
  });

  test("normalizes route probe history to probe mode and live endpoint host", () => {
    const item = createReportHistoryItem(probeReport, {
      mode: "check",
      source: "live",
      rpcUrl: "http://127.0.0.1:8227"
    }, new Date("2026-07-09T20:01:00.000Z"));

    assert.equal(item.label, "Probe - 127.0.0.1:8227");
    assert.equal(item.mode, "probe");
    assert.equal(item.kind, "route-probe");
  });

  test("keeps newest history entries first and capped", () => {
    const items = Array.from({ length: HISTORY_LIMIT + 2 }, (_, index) => historyItem(`item-${index}`));
    const history = items.reduce<ReportHistoryItem[]>(
      (current, item) => upsertReportHistory(current, item),
      []
    );

    assert.equal(history.length, HISTORY_LIMIT);
    assert.equal(history[0]?.id, `item-${HISTORY_LIMIT + 1}`);
    assert.equal(history.at(-1)?.id, "item-2");
  });

  test("loads saved history and ignores malformed storage", () => {
    const storage = new MemoryStorage();
    const item = historyItem("saved");

    saveReportHistory([item], storage);
    assert.deepEqual(loadReportHistory(storage), [item]);

    storage.setItem(HISTORY_STORAGE_KEY, "{broken");
    assert.deepEqual(loadReportHistory(storage), []);
  });
});

const preflightReport: PreflightReport = {
  kind: "invoice-preflight",
  verdict: "payable",
  score: 98,
  summary: "Invoice is payable.",
  checks: [],
  actions: [],
  evidence: []
};

const probeReport: RouteProbeReport = {
  kind: "route-probe",
  verdict: "risky",
  score: 84,
  summary: "Best dry-run setting found.",
  attempts: [],
  evidence: [],
  actions: []
};

function historyItem(id: string): ReportHistoryItem {
  return {
    id,
    kind: "invoice-preflight",
    createdAt: "2026-07-09T20:00:00.000Z",
    label: id,
    source: "demo",
    mode: "check",
    verdict: "payable",
    score: 98,
    summary: "Invoice is payable.",
    report: preflightReport
  };
}

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}
