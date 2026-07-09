import expiredInvoice from "../../../fixtures/expired-invoice.json";
import failedPayment from "../../../fixtures/failed-payment.json";
import feeTooLow from "../../../fixtures/fee-too-low.json";
import insufficientLiquidity from "../../../fixtures/insufficient-liquidity.json";
import mppNeeded from "../../../fixtures/mpp-needed.json";
import payableRoute from "../../../fixtures/payable-route.json";
import type { FixtureScenario } from "@fiber-preflight/core";

export type DemoStoryMode = "check" | "explain" | "probe";

export interface DemoStory {
  scenarioName: string;
  mode: DemoStoryMode;
  title: string;
  expectedVerdict: string;
  problem: string;
  diagnosis: string;
  fix: string;
  payoff: string;
}

export const demoScenarios = [
  payableRoute,
  expiredInvoice,
  insufficientLiquidity,
  mppNeeded,
  feeTooLow,
  failedPayment
] as FixtureScenario[];

export const demoStories: Record<string, DemoStory> = {
  "Payable route": {
    scenarioName: "Payable route",
    mode: "check",
    title: "Healthy payment preflight",
    expectedVerdict: "payable",
    problem: "A wallet wants to know whether this Fiber invoice is safe to pay before sending.",
    diagnosis: "Fiber Preflight checks RPC health, peers, invoice facts, graph visibility, liquidity, and a dry-run route.",
    fix: "No fix is required. The dry-run route is already available with an estimated fee.",
    payoff: "The operator gets a green-light report and can export the evidence before paying."
  },
  "Expired invoice": {
    scenarioName: "Expired invoice",
    mode: "check",
    title: "Expired invoice guardrail",
    expectedVerdict: "blocked",
    problem: "The node is healthy, but the invoice can no longer be settled.",
    diagnosis: "The invoice parser exposes timestamp and expiry data, and the report blocks before route execution matters.",
    fix: "Request a fresh invoice from the merchant and rerun preflight.",
    payoff: "The wallet avoids wasting route attempts on an invoice that cannot succeed."
  },
  "Insufficient liquidity": {
    scenarioName: "Insufficient liquidity",
    mode: "check",
    title: "Liquidity shortfall diagnosis",
    expectedVerdict: "blocked",
    problem: "The node is online, but local channel balance is far below the invoice amount.",
    diagnosis: "Preflight compares matching asset liquidity against invoice amount and confirms route dry-runs fail.",
    fix: "Open, receive, or rebalance liquidity for the required asset before retrying.",
    payoff: "The runbook separates a liquidity problem from graph or fee issues."
  },
  "MPP needed": {
    scenarioName: "MPP needed",
    mode: "probe",
    title: "MPP route tuning",
    expectedVerdict: "risky",
    problem: "No single channel can carry the full amount, so the default route attempt fails.",
    diagnosis: "Probe Lab sweeps fee-rate and part limits to find the smallest MPP setting that works.",
    fix: "Retry with the best passing dry-run setting from the runbook.",
    payoff: "The wallet gets exact max fee and max parts params instead of guessing."
  },
  "Fee too low": {
    scenarioName: "Fee too low",
    mode: "check",
    title: "Fee budget failure",
    expectedVerdict: "blocked",
    problem: "Liquidity exists, but the configured fee budget is too low for the available route.",
    diagnosis: "The dry-run failure is classified as fee-related and converted into a concrete action.",
    fix: "Increase the max fee amount or max fee rate, then rerun preflight.",
    payoff: "The operator sees a payment policy issue instead of misreading it as missing liquidity."
  },
  "Failed payment postmortem": {
    scenarioName: "Failed payment postmortem",
    mode: "explain",
    title: "Post-payment route doctor",
    expectedVerdict: "blocked",
    problem: "A payment already failed and the operator needs to know whether the channel path was the cause.",
    diagnosis: "The postmortem reads payment history, classifies the failure, and cross-checks current channel health.",
    fix: "Avoid the failed channel or wait for the temporary channel condition to clear.",
    payoff: "Support teams get a concise failure narrative with evidence from the original payment."
  }
};

export function storyForScenario(scenario?: FixtureScenario): DemoStory | undefined {
  return scenario?.name ? demoStories[scenario.name] : undefined;
}
