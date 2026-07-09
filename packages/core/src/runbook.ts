import type {
  CheckResult,
  PreflightReport,
  RouteProbeReport,
  RunbookPlan,
  RunbookPriority,
  RunbookStep,
  RunbookStepStatus,
  SuggestedAction
} from "./types.js";

export function buildPreflightRunbook(report: Omit<PreflightReport, "runbook">): RunbookPlan {
  const steps: RunbookStep[] = [];
  const workingProbe = report.probes?.find((probe) => probe.status === "pass" && probe.route);

  if (report.verdict === "payable" && report.route) {
    steps.push({
      id: "pay-current-route",
      priority: "high",
      status: "ready",
      owner: "wallet",
      title: "Pay with current route settings",
      detail: `Dry-run found ${report.route.hopCount} hop(s) with estimated fee ${report.route.fee}.`,
      params: routeParamsFromReport(report)
    });
  }

  if (workingProbe) {
    steps.push({
      id: `retry-${workingProbe.id}`,
      priority: "high",
      status: "ready",
      owner: "wallet",
      title: `Retry with ${workingProbe.label}`,
      detail: `An alternate dry-run produced a route with estimated fee ${workingProbe.route?.fee ?? "unknown"}.`,
      params: copyableParams(workingProbe.params),
      source: workingProbe.id
    });
  }

  for (const check of report.checks) {
    if (check.status !== "fail" && check.status !== "warn") continue;
    const step = stepFromCheck(check);
    if (step) steps.push(step);
  }

  for (const action of report.actions) {
    steps.push(stepFromAction(action, steps.length));
  }

  const uniqueSteps = dedupeSteps(steps).sort(compareSteps);
  return {
    summary: summarizeRunbook(report.verdict, uniqueSteps),
    nextBestAction: uniqueSteps[0]?.title,
    steps: uniqueSteps
  };
}

export function buildRouteProbeRunbook(report: Omit<RouteProbeReport, "runbook">): RunbookPlan {
  const steps: RunbookStep[] = [];

  if (report.best) {
    steps.push({
      id: "use-best-probe",
      priority: "high",
      status: "ready",
      owner: "wallet",
      title: "Use the best passing dry-run setting",
      detail: `Set max fee rate to ${report.best.feeRate ?? "default"} and max parts to ${report.best.maxParts ?? "default"}. Estimated fee: ${report.best.fee ?? "unknown"}.`,
      params: copyableParams(report.best.params),
      source: report.best.id
    });
  } else {
    steps.push({
      id: "no-probe-route",
      priority: "critical",
      status: "blocked",
      owner: "operator",
      title: "Fix route blockers before retrying payment",
      detail: "No tested fee-rate or MPP part setting produced a route.",
      source: "route-probe"
    });
  }

  for (const action of report.actions) {
    if (report.best && action.title === "Use the best passing dry-run setting") continue;
    steps.push(stepFromAction(action, steps.length));
  }

  const failedAttempts = report.attempts.filter((attempt) => attempt.status === "fail");
  if (failedAttempts.length > 0 && report.best) {
    steps.push({
      id: "avoid-failing-settings",
      priority: "medium",
      status: "manual",
      owner: "wallet",
      title: "Avoid failing fee and part combinations",
      detail: `${failedAttempts.length} tested setting(s) failed. Start with the best passing setting instead of increasing fees blindly.`,
      source: "route-probe"
    });
  }

  const uniqueSteps = dedupeSteps(steps).sort(compareSteps);
  return {
    summary: summarizeRunbook(report.verdict, uniqueSteps),
    nextBestAction: uniqueSteps[0]?.title,
    steps: uniqueSteps
  };
}

export function runbookToMarkdown(plan: RunbookPlan): string {
  const lines: string[] = [];
  lines.push("## Operator Runbook");
  lines.push("");
  lines.push(plan.summary);
  lines.push("");
  if (plan.nextBestAction) {
    lines.push(`**Next best action:** ${plan.nextBestAction}`);
    lines.push("");
  }

  for (const [index, step] of plan.steps.entries()) {
    lines.push(`${index + 1}. **[${step.priority}] ${step.title}**`);
    lines.push(`   - Owner: ${step.owner}`);
    lines.push(`   - Status: ${step.status}`);
    lines.push(`   - ${step.detail}`);
    if (step.command) lines.push(`   - Command: \`${step.command}\``);
    if (step.params) lines.push(`   - Params: \`${formatParams(step.params)}\``);
  }
  lines.push("");

  return lines.join("\n");
}

function stepFromCheck(check: CheckResult): RunbookStep | undefined {
  const priority = check.status === "fail" ? "critical" : "medium";
  const status: RunbookStepStatus = check.status === "fail" ? "blocked" : "manual";
  const owner = ownerForCategory(check.category);
  return {
    id: `check-${check.id}`,
    priority,
    status,
    owner,
    title: check.action ?? check.title,
    detail: check.detail,
    source: check.id
  };
}

function stepFromAction(action: SuggestedAction, index: number): RunbookStep {
  return {
    id: `action-${slug(action.title)}-${index}`,
    priority: action.priority === "high" ? "high" : action.priority,
    status: action.priority === "high" ? "blocked" : "manual",
    owner: "operator",
    title: action.title,
    detail: action.detail,
    command: action.command
  };
}

function routeParamsFromReport(report: Omit<PreflightReport, "runbook">): Record<string, string> | undefined {
  if (!report.route) return undefined;
  return {
    estimated_fee: report.route.fee,
    routes: String(report.route.routeCount || 1),
    hops: String(report.route.hopCount)
  };
}

function copyableParams(params: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!params) return undefined;
  const allowed = [
    "amount",
    "dry_run",
    "max_fee_amount",
    "max_fee_rate",
    "max_parts"
  ];
  const entries = allowed
    .filter((key) => params[key] !== undefined)
    .map((key) => [key, String(params[key])] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function ownerForCategory(category: CheckResult["category"]): RunbookStep["owner"] {
  if (category === "invoice") return "merchant";
  if (category === "route" || category === "probe") return "wallet";
  if (category === "graph") return "network";
  return "operator";
}

function summarizeRunbook(verdict: string, steps: RunbookStep[]): string {
  if (!steps.length) return "No operator action is required from the current report.";
  const ready = steps.filter((step) => step.status === "ready").length;
  const blocked = steps.filter((step) => step.status === "blocked").length;
  if (ready > 0) return `${countLabel(ready, "ready action")}, ${countLabel(blocked, "blocker")}, verdict ${verdict}.`;
  return `${countLabel(blocked, "blocker")} and ${countLabel(steps.length - blocked, "manual follow-up")}, verdict ${verdict}.`;
}

function dedupeSteps(steps: RunbookStep[]): RunbookStep[] {
  const seen = new Set<string>();
  return steps.filter((step) => {
    const key = `${step.title}:${step.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareSteps(left: RunbookStep, right: RunbookStep): number {
  const byStatus = statusRank(left.status) - statusRank(right.status);
  if (byStatus !== 0) return byStatus;
  return priorityRank(left.priority) - priorityRank(right.priority);
}

function statusRank(status: RunbookStepStatus): number {
  if (status === "ready") return 0;
  if (status === "blocked") return 1;
  return 2;
}

function priorityRank(priority: RunbookPriority): number {
  if (priority === "critical") return 0;
  if (priority === "high") return 1;
  if (priority === "medium") return 2;
  return 3;
}

function formatParams(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "step";
}

function countLabel(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}
