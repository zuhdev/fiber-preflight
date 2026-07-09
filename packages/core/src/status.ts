import {
  channelStateName,
  compactHash,
  formatAmount,
  quantityToBigInt,
  quantityToNumber,
  toHexQuantity
} from "./format.js";
import type {
  Channel,
  CheckResult,
  CkbInvoice,
  Evidence,
  GraphChannel,
  GraphNode,
  NodeInfoResult,
  NodeStatusInput,
  NodeStatusReport,
  RpcLike
} from "./types.js";

interface SafeResult<T> {
  ok: boolean;
  value?: T;
  error?: Error;
}

export async function inspectNodeStatus(
  rpc: RpcLike,
  input: NodeStatusInput = {}
): Promise<NodeStatusReport> {
  const checks: CheckResult[] = [];
  const evidence: Evidence[] = [];
  const raw: Record<string, unknown> = {};

  const node = await safeCall<NodeInfoResult>(rpc, "node_info");
  raw.node_info = node.value ?? node.error?.message;

  if (!node.ok || !node.value) {
    checks.push({
      id: "status.node_info",
      category: "rpc",
      status: "fail",
      title: "Node info unavailable",
      detail: node.error?.message ?? "node_info failed",
      action: "Check RPC URL, node process, and Biscuit token permissions"
    });
    return finalizeNodeStatus(checks, evidence, raw);
  }

  checks.push({
    id: "status.node_info",
    category: "rpc",
    status: "pass",
    title: "Node info reachable",
    detail: `Connected to ${node.value.node_name ?? "Fiber node"} ${node.value.version ?? ""}`.trim()
  });
  evidence.push({ label: "Node", value: node.value.node_name ?? compactHash(node.value.pubkey) });
  evidence.push({ label: "Pubkey", value: compactHash(node.value.pubkey) });
  if (node.value.version) evidence.push({ label: "Version", value: node.value.version });
  if (node.value.commit_hash) evidence.push({ label: "Commit", value: node.value.commit_hash });
  evidence.push({ label: "Peers", value: String(quantityToNumber(node.value.peers_count) ?? "unknown") });
  evidence.push({ label: "Channels", value: String(quantityToNumber(node.value.channel_count) ?? "unknown") });

  const [peers, channels, graphNodes, graphChannels, payments] = await Promise.all([
    safeCall<{ peers?: unknown[] }>(rpc, "list_peers"),
    safeCallVariants<{ channels?: Channel[] }>(rpc, "list_channels", [[{}], []]),
    safeCall<{ nodes?: GraphNode[] }>(rpc, "graph_nodes", [[{ limit: toHexQuantity(1) }][0]]),
    safeCall<{ channels?: GraphChannel[] }>(rpc, "graph_channels", [[{ limit: toHexQuantity(1) }][0]]),
    safeCall<{ payments?: unknown[] }>(rpc, "list_payments", [{ limit: toHexQuantity(1) }])
  ]);

  raw.list_peers = peers.value ?? peers.error?.message;
  raw.list_channels = channels.value ?? channels.error?.message;
  raw.graph_nodes = graphNodes.value ?? graphNodes.error?.message;
  raw.graph_channels = graphChannels.value ?? graphChannels.error?.message;
  raw.list_payments = payments.value ?? payments.error?.message;

  checks.push(peerStatusCheck(peers, node.value));
  checks.push(channelStatusCheck(channels));
  checks.push(readModuleCheck("status.graph_nodes", "Graph nodes RPC", "graph", graphNodes));
  checks.push(readModuleCheck("status.graph_channels", "Graph channels RPC", "graph", graphChannels));
  checks.push(readModuleCheck("status.list_payments", "Payment read RPC", "route", payments));

  if (input.sampleInvoice) {
    const invoice = await safeCallVariants<{ invoice?: CkbInvoice }>(rpc, "parse_invoice", [
      [{ invoice: input.sampleInvoice }],
      [input.sampleInvoice]
    ]);
    raw.parse_invoice = invoice.value ?? invoice.error?.message;
    checks.push(readModuleCheck("status.parse_invoice", "Invoice parse RPC", "invoice", invoice));
  } else {
    checks.push({
      id: "status.parse_invoice",
      category: "invoice",
      status: "skip",
      title: "Invoice parse not tested",
      detail: "Provide a sample invoice to test parse_invoice permissions."
    });
  }

  return finalizeNodeStatus(checks, evidence, raw);
}

function peerStatusCheck(
  peers: SafeResult<{ peers?: unknown[] }>,
  node: NodeInfoResult
): CheckResult {
  if (!peers.ok) {
    return {
      id: "status.list_peers",
      category: "node",
      status: "fail",
      title: "Peer RPC unavailable",
      detail: peers.error?.message ?? "list_peers failed",
      action: "Grant read peers permission or enable the peer module"
    };
  }

  const peerCount = peers.value?.peers?.length ?? quantityToNumber(node.peers_count) ?? 0;
  return {
    id: "status.list_peers",
    category: "node",
    status: peerCount > 0 ? "pass" : "warn",
    title: peerCount > 0 ? "Peers connected" : "No connected peers",
    detail: `${peerCount} peer(s) connected.`,
    action: peerCount > 0 ? undefined : "Connect at least one Fiber peer before paying"
  };
}

function channelStatusCheck(channels: SafeResult<{ channels?: Channel[] }>): CheckResult {
  if (!channels.ok) {
    return {
      id: "status.list_channels",
      category: "liquidity",
      status: "fail",
      title: "Channel RPC unavailable",
      detail: channels.error?.message ?? "list_channels failed",
      action: "Grant read channels permission or enable the channel module"
    };
  }

  const all = channels.value?.channels ?? [];
  const ready = all.filter((channel) => channelStateName(channel.state) === "ChannelReady");
  const enabled = ready.filter((channel) => channel.enabled !== false);
  const ckbLocal = enabled
    .filter((channel) => !channel.funding_udt_type_script)
    .reduce((sum, channel) => sum + (quantityToBigInt(channel.local_balance) ?? 0n), 0n);

  return {
    id: "status.list_channels",
    category: "liquidity",
    status: enabled.length > 0 ? "pass" : all.length > 0 ? "warn" : "fail",
    title: enabled.length > 0 ? "Usable channels available" : all.length > 0 ? "No enabled ready channels" : "No channels",
    detail: `${enabled.length}/${all.length} channel(s) are ready and enabled. Native local balance: ${formatAmount(ckbLocal)}.`,
    action: enabled.length > 0 ? undefined : "Open, wait for, or enable a channel"
  };
}

function readModuleCheck<T>(
  id: string,
  title: string,
  category: CheckResult["category"],
  result: SafeResult<T>
): CheckResult {
  return {
    id,
    category,
    status: result.ok ? "pass" : "fail",
    title: result.ok ? `${title} reachable` : `${title} unavailable`,
    detail: result.ok ? "Read call completed successfully." : result.error?.message ?? "RPC call failed",
    action: result.ok ? undefined : "Check enabled modules and Biscuit read permissions"
  };
}

async function safeCall<T>(
  rpc: RpcLike,
  method: string,
  params: unknown[] = []
): Promise<SafeResult<T>> {
  try {
    return { ok: true, value: await rpc.call<T>(method, params) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

async function safeCallVariants<T>(
  rpc: RpcLike,
  method: string,
  paramVariants: unknown[][]
): Promise<SafeResult<T>> {
  let lastError: Error | undefined;
  for (const params of paramVariants) {
    const result = await safeCall<T>(rpc, method, params);
    if (result.ok) return result;
    lastError = result.error;
  }
  return { ok: false, error: lastError ?? new Error(`${method} failed`) };
}

function finalizeNodeStatus(
  checks: CheckResult[],
  evidence: Evidence[],
  raw: Record<string, unknown>
): NodeStatusReport {
  const score = checks.reduce((current, check) => {
    if (check.status === "fail") return current - 18;
    if (check.status === "warn") return current - 8;
    if (check.status === "skip") return current - 2;
    return current;
  }, 100);
  const normalizedScore = Math.max(0, Math.min(100, score));
  const hasNodeInfoFailure = checks.some((check) => check.id === "status.node_info" && check.status === "fail");
  const hasFailure = checks.some((check) => check.status === "fail");
  const hasWarning = checks.some((check) => check.status === "warn" || check.status === "skip");
  const verdict = hasNodeInfoFailure || normalizedScore < 45 ? "blocked" : hasFailure || hasWarning ? "limited" : "ready";

  return {
    kind: "node-status",
    verdict,
    score: normalizedScore,
    summary:
      verdict === "ready"
        ? "Fiber RPC is ready for preflight checks."
        : verdict === "limited"
          ? "Fiber RPC is reachable, but some preflight capabilities are limited."
          : "Fiber RPC is not ready for preflight checks.",
    checks,
    evidence,
    raw
  };
}
