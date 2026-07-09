import type {
  ChannelInventoryReport,
  LiquidityInsight,
  NodeStatusReport,
  PreflightReport,
  RouteProbeReport,
  RouteSummary
} from "./types.js";
import { runbookToMarkdown } from "./runbook.js";

export function reportToMarkdown(report: PreflightReport): string {
  const lines: string[] = [];
  lines.push(`# Fiber Preflight Report`);
  lines.push("");
  lines.push(`**Verdict:** ${report.verdict.toUpperCase()} (${report.score}/100)`);
  lines.push("");
  lines.push(report.summary);
  lines.push("");

  if (report.evidence.length > 0) {
    lines.push("## Evidence");
    lines.push("");
    for (const item of report.evidence) {
      lines.push(`- **${item.label}:** ${item.value}`);
    }
    lines.push("");
  }

  if (report.liquidity) {
    lines.push("## Liquidity Lens");
    lines.push("");
    appendLiquidityLines(lines, report.liquidity);
    lines.push("");
  }

  if (report.route) {
    lines.push("## Route");
    lines.push("");
    lines.push(`- **Fee:** ${report.route.fee}`);
    lines.push(`- **Routes:** ${report.route.routeCount || 1}`);
    lines.push(`- **Hops:** ${report.route.hopCount}`);
    lines.push("");
    appendRoutePathLines(lines, report.route);
    lines.push("");
  }

  if (report.probes && report.probes.length > 0) {
    lines.push("## Probes");
    lines.push("");
    for (const probe of report.probes) {
      lines.push(`- **${probe.label}:** ${probe.status.toUpperCase()} - ${probe.summary}`);
      if (probe.error) lines.push(`  - Error: ${probe.error}`);
    }
    lines.push("");
  }

  if (report.actions.length > 0) {
    lines.push("## Actions");
    lines.push("");
    for (const action of report.actions) {
      lines.push(`- **[${action.priority}] ${action.title}:** ${action.detail}`);
      if (action.command) lines.push(`  - Command: \`${action.command}\``);
    }
    lines.push("");
  }

  if (report.runbook) {
    lines.push(runbookToMarkdown(report.runbook).trim());
    lines.push("");
  }

  lines.push("## Checks");
  lines.push("");
  for (const check of report.checks) {
    lines.push(`- **[${check.status}] ${check.title}:** ${check.detail}`);
    if (check.action) lines.push(`  - Next: ${check.action}`);
  }
  lines.push("");

  return `${lines.join("\n").trim()}\n`;
}

export function channelInventoryToMarkdown(report: ChannelInventoryReport): string {
  const lines: string[] = [];
  lines.push("# Fiber Preflight Channel Inventory");
  lines.push("");
  lines.push(report.summary);
  lines.push("");
  lines.push("## Totals");
  lines.push("");
  lines.push(`- **Total:** ${report.totals.total}`);
  lines.push(`- **Ready:** ${report.totals.ready}`);
  lines.push(`- **Enabled ready:** ${report.totals.enabledReady}`);
  lines.push(`- **Public/private:** ${report.totals.publicChannels}/${report.totals.privateChannels}`);
  lines.push(`- **CKB local balance:** ${report.totals.ckbLocalBalance}`);
  lines.push(`- **UDT local balance:** ${report.totals.udtLocalBalance}`);
  lines.push(`- **Pending TLCs:** ${report.totals.pendingTlcCount}`);
  lines.push("");

  if (report.channels.length > 0) {
    lines.push("## Channels");
    lines.push("");
    for (const channel of report.channels) {
      const flags = [
        channel.enabled ? "enabled" : "disabled",
        channel.isPublic ? "public" : "private",
        channel.isOneWay ? "one-way" : "two-way",
        channel.asset
      ].join(", ");
      lines.push(`- **${channel.channelId}** peer ${channel.peer}`);
      lines.push(`  - ${channel.state}; ${flags}`);
      lines.push(
        `  - local ${channel.localBalance}, remote ${channel.remoteBalance}, pending TLCs ${channel.pendingTlcCount}`
      );
      if (channel.failureDetail) lines.push(`  - failure: ${channel.failureDetail}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

export function nodeStatusToMarkdown(report: NodeStatusReport): string {
  const lines: string[] = [];
  lines.push("# Fiber Preflight Node Status");
  lines.push("");
  lines.push(`**Verdict:** ${report.verdict.toUpperCase()} (${report.score}/100)`);
  lines.push("");
  lines.push(report.summary);
  lines.push("");

  if (report.evidence.length > 0) {
    lines.push("## Evidence");
    lines.push("");
    for (const item of report.evidence) {
      lines.push(`- **${item.label}:** ${item.value}`);
    }
    lines.push("");
  }

  lines.push("## Checks");
  lines.push("");
  for (const check of report.checks) {
    lines.push(`- **[${check.status}] ${check.title}:** ${check.detail}`);
    if (check.action) lines.push(`  - Next: ${check.action}`);
  }
  lines.push("");

  return `${lines.join("\n").trim()}\n`;
}

export function routeProbeToMarkdown(report: RouteProbeReport): string {
  const lines: string[] = [];
  lines.push("# Fiber Preflight Probe Lab");
  lines.push("");
  lines.push(`**Verdict:** ${report.verdict.toUpperCase()} (${report.score}/100)`);
  lines.push("");
  lines.push(report.summary);
  lines.push("");

  if (report.evidence.length > 0) {
    lines.push("## Evidence");
    lines.push("");
    for (const item of report.evidence) {
      lines.push(`- **${item.label}:** ${item.value}`);
    }
    lines.push("");
  }

  if (report.best) {
    lines.push("## Best Setting");
    lines.push("");
    lines.push(`- **Max fee rate:** ${report.best.feeRate ?? "default"}`);
    lines.push(`- **Max parts:** ${report.best.maxParts ?? "default"}`);
    lines.push(`- **Estimated fee:** ${report.best.fee ?? "unknown"}`);
    lines.push(`- **Hops:** ${report.best.hopCount ?? "unknown"}`);
    lines.push("");
  }

  if (report.liquidity) {
    lines.push("## Liquidity Lens");
    lines.push("");
    appendLiquidityLines(lines, report.liquidity);
    lines.push("");
  }

  if (report.best?.route) {
    lines.push("## Best Route");
    lines.push("");
    appendRoutePathLines(lines, report.best.route);
    lines.push("");
  }

  lines.push("## Attempts");
  lines.push("");
  for (const attempt of report.attempts) {
    const result = attempt.status === "pass"
      ? `fee ${attempt.fee ?? "unknown"}, ${attempt.hopCount ?? "unknown"} hops`
      : attempt.error ?? "route failed";
    lines.push(`- **${attempt.label}:** ${attempt.status.toUpperCase()} - ${result}`);
  }
  lines.push("");

  if (report.actions.length > 0) {
    lines.push("## Actions");
    lines.push("");
    for (const action of report.actions) {
      lines.push(`- **[${action.priority}] ${action.title}:** ${action.detail}`);
    }
    lines.push("");
  }

  if (report.runbook) {
    lines.push(runbookToMarkdown(report.runbook).trim());
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

function appendLiquidityLines(lines: string[], insight: LiquidityInsight): void {
  lines.push(`- **Status:** ${insight.status.toUpperCase()} - ${insight.title}`);
  lines.push(`- **Summary:** ${insight.summary}`);
  lines.push(`- **Asset:** ${insight.asset}`);
  if (insight.amount) lines.push(`- **Amount:** ${insight.amount}`);
  lines.push(`- **Matching channels:** ${insight.matchingChannelCount}`);
  lines.push(`- **Total local balance:** ${insight.totalLocalBalance}`);
  lines.push(`- **Largest local balance:** ${insight.largestLocalBalance}`);
  if (insight.shortage) lines.push(`- **Shortage:** ${insight.shortage}`);
  if (insight.likelyNeedsMpp) lines.push("- **MPP:** likely required");
  if (insight.largestChannel) {
    const channel = insight.largestChannel;
    const outpoint = channel.channelOutpoint ? `, outpoint ${channel.channelOutpoint}` : "";
    lines.push(
      `- **Largest channel:** ${channel.channelId} peer ${channel.peer}, local ${channel.localBalance}${outpoint}`
    );
  }
}

function appendRoutePathLines(lines: string[], route: RouteSummary): void {
  const paths = route.paths && route.paths.length > 0
    ? route.paths
    : [{ label: "Route", hopCount: route.hopCount, amount: undefined, hops: route.hops }];

  for (const path of paths) {
    const amount = path.amount ? `, amount ${path.amount}` : "";
    lines.push(`- **${path.label}:** ${path.hopCount} hop(s)${amount}`);
    for (const [index, hop] of path.hops.entries()) {
      const hopAmount = hop.amount ? `, amount ${hop.amount}` : "";
      const channel = hop.channelOutpoint ? `, channel ${hop.channelOutpoint}` : "";
      lines.push(`  ${index + 1}. ${hop.pubkey}${hopAmount}${channel}`);
    }
  }
}
