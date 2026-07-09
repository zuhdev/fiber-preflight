import { classifyFailure } from "./failure-classifier.js";
import {
  channelStateName,
  compactHash,
  formatAmount,
  outpointToString,
  quantityToBigInt,
  quantityToNumber,
  scriptFingerprint,
  stableStringify,
  toHexQuantity
} from "./format.js";
import { buildPreflightRunbook } from "./runbook.js";
import type {
  Channel,
  CheckResult,
  CkbInvoice,
  Evidence,
  GraphChannel,
  GraphNode,
  NodeInfoResult,
  PaymentExplainInput,
  PaymentResult,
  PreflightInput,
  ProbeResult,
  PreflightReport,
  RpcLike,
  RouteSummary,
  SuggestedAction,
  Verdict
} from "./types.js";

interface SafeResult<T> {
  ok: boolean;
  value?: T;
  error?: Error;
}

interface ParsedInvoiceFacts {
  amount?: bigint;
  currency?: string;
  paymentHash?: string;
  timestamp?: number;
  expirySeconds?: number;
  expiresAtMs?: number;
  payeePubkey?: string;
  udtScript?: string;
  allowsMpp?: boolean;
  allowsTrampoline?: boolean;
  raw?: CkbInvoice;
}

export async function runInvoicePreflight(
  rpc: RpcLike,
  input: PreflightInput
): Promise<PreflightReport> {
  const checks: CheckResult[] = [];
  const actions: SuggestedAction[] = [];
  const evidence: Evidence[] = [];
  const probes: ProbeResult[] = [];
  const raw: Record<string, unknown> = {};

  const node = await safeCall<NodeInfoResult>(rpc, "node_info");
  if (node.ok && node.value) {
    raw.node_info = node.value;
    checks.push({
      id: "rpc.node_info",
      category: "rpc",
      status: "pass",
      title: "RPC reachable",
      detail: `Connected to ${node.value.node_name ?? "Fiber node"} ${node.value.version ?? ""}`.trim()
    });
    evidence.push({ label: "Node", value: node.value.node_name ?? compactHash(node.value.pubkey) });
    evidence.push({ label: "Pubkey", value: compactHash(node.value.pubkey) });
    if (node.value.version) evidence.push({ label: "Version", value: node.value.version });
  } else {
    const classification = classifyFailure(node.error?.message);
    checks.push({
      id: "rpc.node_info",
      category: "rpc",
      status: "fail",
      title: "RPC unavailable",
      detail: node.error?.message ?? "Could not query node_info",
      action: classification.actions[0]?.title
    });
    actions.push(...classification.actions);
    return finalizeReport("invoice-preflight", checks, actions, evidence, raw);
  }

  const [peers, channels, pendingChannels, graphNodes, graphChannels] = await Promise.all([
    safeCall<{ peers?: unknown[] }>(rpc, "list_peers"),
    safeCallVariants<{ channels?: Channel[] }>(rpc, "list_channels", [[{}], []]),
    safeCallVariants<{ channels?: Channel[] }>(rpc, "list_channels", [
      [{ only_pending: true }],
      [{ only_pending: "0x1" }]
    ]),
    safeCall<{ nodes?: GraphNode[] }>(rpc, "graph_nodes", [
      { limit: toHexQuantity(input.graphLimit ?? 500) }
    ]),
    safeCall<{ channels?: GraphChannel[] }>(rpc, "graph_channels", [
      { limit: toHexQuantity(input.graphLimit ?? 500) }
    ])
  ]);

  raw.list_peers = peers.value;
  raw.list_channels = channels.value;
  raw.pending_channels = pendingChannels.value;
  raw.graph_nodes = graphNodes.value;
  raw.graph_channels = graphChannels.value;

  checks.push(peerCheck(peers, node.value));

  const allChannels = channels.value?.channels ?? [];
  const pending = pendingChannels.value?.channels ?? [];
  checks.push(...channelReadinessChecks(allChannels, pending, input));

  let parsedInvoice: ParsedInvoiceFacts | undefined;
  if (input.invoice) {
    const parsed = await safeCallVariants<{ invoice?: CkbInvoice }>(rpc, "parse_invoice", [
      [{ invoice: input.invoice }],
      [input.invoice]
    ]);
    raw.parse_invoice = parsed.value;
    if (parsed.ok && parsed.value?.invoice) {
      parsedInvoice = parseInvoiceFacts(parsed.value.invoice);
      checks.push(...invoiceChecks(parsedInvoice, input));
      evidence.push(...invoiceEvidence(parsedInvoice));
    } else {
      checks.push({
        id: "invoice.parse",
        category: "invoice",
        status: "fail",
        title: "Invoice could not be parsed",
        detail: parsed.error?.message ?? "parse_invoice failed",
        action: "Request or paste a valid Fiber invoice"
      });
      actions.push({
        title: "Use a valid Fiber invoice",
        detail: "The node could not parse the invoice, so route checks cannot continue.",
        priority: "high"
      });
    }
  } else {
    checks.push({
      id: "invoice.present",
      category: "invoice",
      status: "skip",
      title: "No invoice supplied",
      detail: "Provide an invoice to run payment-specific preflight checks."
    });
  }

  checks.push(...assetAndLiquidityChecks(allChannels, parsedInvoice, input));
  checks.push(...graphChecks(graphNodes, graphChannels, parsedInvoice, node.value));

  let route: RouteSummary | undefined;
  if (input.invoice && parsedInvoice && !input.skipDryRun) {
    const baseParams = dryRunParams(input);
    const dryRun = await safeCall<PaymentResult>(rpc, "send_payment", [baseParams]);
    raw.dry_run = dryRun.value ?? dryRun.error?.message;

    if (dryRun.ok && dryRun.value) {
      route = summarizeRoute(dryRun.value);
      checks.push({
        id: "route.dry_run",
        category: "route",
        status: "pass",
        title: "Dry-run route found",
        detail: `Fiber built ${route.routeCount || 1} route(s) with estimated fee ${route.fee}.`,
        evidence: route
      });
      evidence.push({ label: "Estimated fee", value: route.fee, raw: dryRun.value.fee });
      if (route.hopCount > 0) evidence.push({ label: "Route hops", value: String(route.hopCount) });
    } else {
      const classification = classifyFailure(dryRun.error?.message);
      const failureCheck: CheckResult = {
        id: "route.dry_run",
        category: "route",
        status: "fail",
        title: classification.title,
        detail: classification.detail,
        action: classification.actions[0]?.title,
        evidence: dryRun.error?.message
      };
      const retryProbes = await runDryRunProbes(rpc, input, parsedInvoice, classification.code);
      probes.push(...retryProbes);
      raw.probes = retryProbes;

      const successfulProbe = retryProbes.find((probe) => probe.status === "pass" && probe.route);
      if (successfulProbe?.route) {
        failureCheck.status = "warn";
        failureCheck.title = "Default dry-run failed";
        failureCheck.detail = `${classification.detail} An alternate probe did find a route.`;
        route = successfulProbe.route;
        evidence.push({
          label: "Working probe",
          value: successfulProbe.label,
          raw: successfulProbe.params
        });
        evidence.push({ label: "Estimated fee", value: successfulProbe.route.fee });
        checks.push(failureCheck);
        checks.push({
          id: "route.probe_success",
          category: "probe",
          status: "pass",
          title: "Alternate dry-run route found",
          detail: `${successfulProbe.label} produced a candidate route with fee ${successfulProbe.route.fee}.`,
          evidence: successfulProbe
        });
      } else {
        checks.push(failureCheck);
      }
      actions.push(...classification.actions);
    }
  } else if (input.invoice && input.skipDryRun) {
    checks.push({
      id: "route.dry_run",
      category: "route",
      status: "skip",
      title: "Dry-run skipped",
      detail: "The report did not attempt send_payment dry_run."
    });
  }

  actions.push(...actionsFromChecks(checks));
  return finalizeReport("invoice-preflight", checks, dedupeActions(actions), evidence, raw, route, probes);
}

export async function explainPayment(
  rpc: RpcLike,
  input: PaymentExplainInput
): Promise<PreflightReport> {
  const checks: CheckResult[] = [];
  const actions: SuggestedAction[] = [];
  const evidence: Evidence[] = [];
  const raw: Record<string, unknown> = {};

  const payment = await safeCallVariants<PaymentResult>(rpc, "get_payment", [
    [{ payment_hash: input.paymentHash }],
    [input.paymentHash]
  ]);

  if (!payment.ok || !payment.value) {
    const classification = classifyFailure(payment.error?.message);
    checks.push({
      id: "postmortem.get_payment",
      category: "postmortem",
      status: "fail",
      title: "Payment not found",
      detail: payment.error?.message ?? "get_payment failed",
      action: classification.actions[0]?.title
    });
    actions.push(...classification.actions);
    return finalizeReport("payment-postmortem", checks, actions, evidence, raw);
  }

  raw.get_payment = payment.value;
  const route = summarizeRoute(payment.value);
  evidence.push({ label: "Payment", value: compactHash(payment.value.payment_hash ?? input.paymentHash) });
  evidence.push({ label: "Status", value: payment.value.status ?? "unknown" });
  evidence.push({ label: "Fee", value: formatAmount(payment.value.fee) });

  if (payment.value.status === "Success") {
    checks.push({
      id: "postmortem.success",
      category: "postmortem",
      status: "pass",
      title: "Payment succeeded",
      detail: `Payment settled with fee ${formatAmount(payment.value.fee)}.`
    });
  } else if (payment.value.status === "Failed" || payment.value.failed_error) {
    const classification = classifyFailure(payment.value.failed_error);
    checks.push({
      id: "postmortem.failure",
      category: "postmortem",
      status: "fail",
      title: classification.title,
      detail: classification.detail,
      action: classification.actions[0]?.title,
      evidence: payment.value.failed_error
    });
    actions.push(...classification.actions);
  } else {
    checks.push({
      id: "postmortem.status",
      category: "postmortem",
      status: "warn",
      title: `Payment is ${payment.value.status ?? "unknown"}`,
      detail: "The payment has not reached Success or Failed in the current query."
    });
  }

  const channels = await safeCallVariants<{ channels?: Channel[] }>(rpc, "list_channels", [[{}], []]);
  raw.list_channels = channels.value;
  if (channels.ok) {
    checks.push(...channelReadinessChecks(channels.value?.channels ?? [], [], {}));
  }

  actions.push(...actionsFromChecks(checks));
  return finalizeReport(
    "payment-postmortem",
    checks,
    dedupeActions(actions),
    evidence,
    raw,
    route.hopCount ? route : undefined
  );
}

async function safeCall<T>(
  rpc: RpcLike,
  method: string,
  params: unknown[] = []
): Promise<SafeResult<T>> {
  try {
    const value = await rpc.call<T>(method, params);
    return { ok: true, value };
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

function dryRunParams(input: PreflightInput, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return stripUndefined({
    invoice: input.invoice,
    dry_run: true,
    amount: toHexQuantity(input.amount),
    max_fee_amount: toHexQuantity(input.maxFeeAmount),
    max_fee_rate: toHexQuantity(input.maxFeeRate),
    max_parts: toHexQuantity(input.maxParts),
    ...overrides
  });
}

async function runDryRunProbes(
  rpc: RpcLike,
  input: PreflightInput,
  invoice: ParsedInvoiceFacts,
  failureCode: string
): Promise<ProbeResult[]> {
  const probeSpecs: Array<{ id: string; label: string; params: Record<string, unknown>; enabled: boolean }> = [
    {
      id: "higher-fee",
      label: "Higher fee budget",
      params: dryRunParams(input, {
        max_fee_rate: toHexQuantity(input.maxFeeRate ?? 50),
        max_fee_amount: input.maxFeeAmount ? toHexQuantity(input.maxFeeAmount) : undefined
      }),
      enabled: ["FeeInsufficient", "BuildRouteFailed", "Unknown"].includes(failureCode)
    },
    {
      id: "mpp",
      label: "MPP with up to 12 parts",
      params: dryRunParams(input, {
        max_parts: toHexQuantity(input.maxParts ?? 12)
      }),
      enabled:
        invoice.allowsMpp === true ||
        ["BuildRouteFailed", "TemporaryChannelFailure", "TemporaryNodeFailure", "Unknown"].includes(failureCode)
    }
  ];

  const results: ProbeResult[] = [];
  for (const spec of probeSpecs) {
    if (!spec.enabled) {
      results.push({
        id: spec.id,
        label: spec.label,
        status: "skip",
        summary: "Probe skipped because it is unlikely to change this failure mode.",
        params: spec.params
      });
      continue;
    }

    const result = await safeCall<PaymentResult>(rpc, "send_payment", [spec.params]);
    if (result.ok && result.value) {
      const route = summarizeRoute(result.value);
      results.push({
        id: spec.id,
        label: spec.label,
        status: "pass",
        summary: `Route found with fee ${route.fee}.`,
        params: spec.params,
        route
      });
    } else {
      const classification = classifyFailure(result.error?.message);
      results.push({
        id: spec.id,
        label: spec.label,
        status: "fail",
        summary: classification.title,
        params: spec.params,
        error: result.error?.message
      });
    }
  }
  return results;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, inner]) => inner !== undefined)) as T;
}

function peerCheck(peers: SafeResult<{ peers?: unknown[] }>, node?: NodeInfoResult): CheckResult {
  const peerCount = peers.value?.peers?.length ?? quantityToNumber(node?.peers_count) ?? 0;
  if (!peers.ok) {
    return {
      id: "node.peers",
      category: "node",
      status: "warn",
      title: "Peer list unavailable",
      detail: peers.error?.message ?? "list_peers failed",
      action: "Check peer RPC permissions"
    };
  }
  if (peerCount === 0) {
    return {
      id: "node.peers",
      category: "node",
      status: "warn",
      title: "No connected peers",
      detail: "The node is reachable but has no connected Fiber peers.",
      action: "Connect to at least one peer before paying"
    };
  }
  return {
    id: "node.peers",
    category: "node",
    status: "pass",
    title: "Peers connected",
    detail: `${peerCount} peer(s) connected.`
  };
}

function channelReadinessChecks(
  channels: Channel[],
  pendingChannels: Channel[],
  input: Pick<PreflightInput, "amount">
): CheckResult[] {
  const checks: CheckResult[] = [];
  const ready = channels.filter((channel) => channelStateName(channel.state) === "ChannelReady");
  const enabled = ready.filter((channel) => channel.enabled !== false);
  const totalLocal = enabled.reduce(
    (sum, channel) => sum + (quantityToBigInt(channel.local_balance) ?? 0n),
    0n
  );
  const requested = quantityToBigInt(input.amount);

  if (channels.length === 0) {
    checks.push({
      id: "liquidity.channels.present",
      category: "liquidity",
      status: "fail",
      title: "No channels found",
      detail: "This node has no channels available for payments.",
      action: "Open or receive a funded channel"
    });
  } else if (ready.length === 0) {
    checks.push({
      id: "liquidity.channels.ready",
      category: "liquidity",
      status: "fail",
      title: "No ready channels",
      detail: `${channels.length} channel(s) exist, but none are ChannelReady.`,
      action: "Wait for channel funding confirmation or inspect pending channels"
    });
  } else {
    checks.push({
      id: "liquidity.channels.ready",
      category: "liquidity",
      status: "pass",
      title: "Ready channels available",
      detail: `${ready.length} ready channel(s), ${enabled.length} enabled.`
    });
  }

  if (ready.length > 0 && enabled.length === 0) {
    checks.push({
      id: "liquidity.channels.enabled",
      category: "liquidity",
      status: "fail",
      title: "All ready channels are disabled",
      detail: "Ready channels exist, but none are currently enabled for routing.",
      action: "Enable a channel or wait for peer updates"
    });
  }

  if (requested !== undefined && enabled.length > 0) {
    if (totalLocal < requested) {
      checks.push({
        id: "liquidity.local_balance",
        category: "liquidity",
        status: "fail",
        title: "Insufficient local balance",
        detail: `Enabled local balance is ${formatAmount(totalLocal)}, below requested amount ${formatAmount(requested)}.`,
        action: "Open, receive, or rebalance liquidity"
      });
    } else {
      checks.push({
        id: "liquidity.local_balance",
        category: "liquidity",
        status: "pass",
        title: "Local balance covers amount",
        detail: `Enabled local balance is ${formatAmount(totalLocal)}.`
      });
    }
  }

  const pendingTlcs = enabled.reduce((sum, channel) => sum + (channel.pending_tlcs?.length ?? 0), 0);
  if (pendingTlcs > 0) {
    checks.push({
      id: "liquidity.pending_tlcs",
      category: "liquidity",
      status: "warn",
      title: "Pending TLCs detected",
      detail: `${pendingTlcs} pending TLC(s) may temporarily lock liquidity.`,
      action: "Wait for in-flight TLCs to settle if routing fails"
    });
  }

  const failedPending = pendingChannels.filter((channel) => channel.failure_detail);
  for (const channel of failedPending.slice(0, 3)) {
    checks.push({
      id: `liquidity.pending.${channel.channel_id ?? channel.pubkey ?? checks.length}`,
      category: "liquidity",
      status: "warn",
      title: "Channel opening failure",
      detail: channel.failure_detail ?? "A pending channel reported a failure.",
      action: "Inspect funding transaction or peer state",
      evidence: channel
    });
  }

  const unusableOneWay = enabled.filter((channel) => channel.is_one_way && channel.is_acceptor);
  if (unusableOneWay.length > 0) {
    checks.push({
      id: "liquidity.one_way",
      category: "liquidity",
      status: "warn",
      title: "Inbound one-way channels cannot send",
      detail: `${unusableOneWay.length} one-way channel(s) are acceptor-side and cannot be used for outbound payments.`,
      action: "Use an outbound/funded channel for sending"
    });
  }

  return checks;
}

function invoiceChecks(invoice: ParsedInvoiceFacts, input: PreflightInput): CheckResult[] {
  const checks: CheckResult[] = [
    {
      id: "invoice.parse",
      category: "invoice",
      status: "pass",
      title: "Invoice parsed",
      detail: `${invoice.currency ?? "Unknown"} invoice ${compactHash(invoice.paymentHash)} parsed successfully.`
    }
  ];

  const now = Date.now();
  if (invoice.expiresAtMs !== undefined) {
    if (invoice.expiresAtMs <= now) {
      checks.push({
        id: "invoice.expiry",
        category: "invoice",
        status: "fail",
        title: "Invoice expired",
        detail: `Invoice expired ${new Date(invoice.expiresAtMs).toLocaleString()}.`,
        action: "Request a fresh invoice"
      });
    } else if (invoice.expiresAtMs - now < 5 * 60 * 1000) {
      checks.push({
        id: "invoice.expiry",
        category: "invoice",
        status: "warn",
        title: "Invoice expires soon",
        detail: `Invoice expires ${new Date(invoice.expiresAtMs).toLocaleString()}.`,
        action: "Pay soon or request a fresh invoice"
      });
    } else {
      checks.push({
        id: "invoice.expiry",
        category: "invoice",
        status: "pass",
        title: "Invoice has time remaining",
        detail: `Expires ${new Date(invoice.expiresAtMs).toLocaleString()}.`
      });
    }
  }

  if (invoice.amount === undefined && input.amount === undefined) {
    checks.push({
      id: "invoice.amount",
      category: "invoice",
      status: "warn",
      title: "Invoice has no amount",
      detail: "The invoice is amountless and no amount was supplied to preflight.",
      action: "Supply an amount when checking or paying"
    });
  } else {
    checks.push({
      id: "invoice.amount",
      category: "invoice",
      status: "pass",
      title: "Payment amount known",
      detail: `Amount ${formatAmount(invoice.amount ?? input.amount)}.`
    });
  }

  if (!invoice.payeePubkey) {
    checks.push({
      id: "invoice.payee",
      category: "invoice",
      status: "warn",
      title: "Payee pubkey not explicit",
      detail: "The parsed invoice did not expose a payee public key attribute.",
      action: "Rely on dry-run or ask recipient for a signed invoice"
    });
  }

  return checks;
}

function assetAndLiquidityChecks(
  channels: Channel[],
  invoice: ParsedInvoiceFacts | undefined,
  input: PreflightInput
): CheckResult[] {
  const checks: CheckResult[] = [];
  const amount = invoice?.amount ?? quantityToBigInt(input.amount);
  const asset = invoice?.udtScript ? "udt" : "ckb";
  const readyEnabled = channels.filter(
    (channel) => channelStateName(channel.state) === "ChannelReady" && channel.enabled !== false
  );
  const assetChannels = readyEnabled.filter((channel) =>
    asset === "udt" ? Boolean(channel.funding_udt_type_script) : !channel.funding_udt_type_script
  );

  if (!invoice) return checks;

  if (assetChannels.length === 0) {
    checks.push({
      id: "liquidity.asset",
      category: "liquidity",
      status: "fail",
      title: asset === "udt" ? "No ready UDT channels" : "No ready native CKB channels",
      detail: `The invoice requires ${asset.toUpperCase()} liquidity, but no enabled ready channel matches.`,
      action: "Open or rebalance a channel for the required asset"
    });
  } else {
    checks.push({
      id: "liquidity.asset",
      category: "liquidity",
      status: "pass",
      title: "Asset liquidity exists",
      detail: `${assetChannels.length} enabled ready channel(s) match the invoice asset.`
    });
  }

  if (amount !== undefined && assetChannels.length > 0) {
    const total = assetChannels.reduce((sum, channel) => {
      return sum + (quantityToBigInt(channel.local_balance) ?? 0n);
    }, 0n);
    const largest = assetChannels.reduce((max, channel) => {
      const local = quantityToBigInt(channel.local_balance) ?? 0n;
      return local > max ? local : max;
    }, 0n);
    if (total < amount) {
      checks.push({
        id: "liquidity.asset_balance",
        category: "liquidity",
        status: "fail",
        title: "Insufficient local asset balance",
        detail: `Matching local balance is ${formatAmount(total)}, below amount ${formatAmount(amount)}.`,
        action: "Open, receive, or rebalance liquidity for this asset"
      });
    } else if (largest < amount) {
      checks.push({
        id: "liquidity.single_channel_capacity",
        category: "liquidity",
        status: "warn",
        title: "No single channel covers the amount",
        detail: `Largest matching local balance is ${formatAmount(largest)}, below amount ${formatAmount(amount)}.`,
        action: "Use MPP if supported or rebalance/open a larger channel"
      });
    }
  }

  return checks;
}

function graphChecks(
  nodesResult: SafeResult<{ nodes?: GraphNode[] }>,
  channelsResult: SafeResult<{ channels?: GraphChannel[] }>,
  invoice: ParsedInvoiceFacts | undefined,
  node?: NodeInfoResult
): CheckResult[] {
  const checks: CheckResult[] = [];
  if (!nodesResult.ok || !channelsResult.ok) {
    checks.push({
      id: "graph.available",
      category: "graph",
      status: "warn",
      title: "Graph unavailable",
      detail: nodesResult.error?.message ?? channelsResult.error?.message ?? "Graph RPC failed",
      action: "Enable graph RPC or check Biscuit read permissions"
    });
    return checks;
  }

  const nodes = nodesResult.value?.nodes ?? [];
  const channels = channelsResult.value?.channels ?? [];
  checks.push({
    id: "graph.synced",
    category: "graph",
    status: nodes.length > 0 || channels.length > 0 ? "pass" : "warn",
    title: nodes.length > 0 || channels.length > 0 ? "Graph data available" : "Graph appears empty",
    detail: `${nodes.length} node(s), ${channels.length} public channel(s) returned.`
  });

  if (invoice?.payeePubkey) {
    const target = normalizePubkey(invoice.payeePubkey);
    const payee = nodes.find((graphNode) => normalizePubkey(graphNode.pubkey) === target);
    checks.push({
      id: "graph.payee",
      category: "graph",
      status: payee ? "pass" : "warn",
      title: payee ? "Payee visible in graph" : "Payee not visible in graph",
      detail: payee
        ? `${payee.node_name ?? compactHash(payee.pubkey)} appears in local graph.`
        : "The payee may rely on a private channel or your graph may be stale.",
      action: payee ? undefined : "Use invoice hop hints or refresh graph state"
    });
  }

  const self = normalizePubkey(node?.pubkey);
  if (self) {
    const selfPublicChannels = channels.filter(
      (channel) => normalizePubkey(channel.node1) === self || normalizePubkey(channel.node2) === self
    );
    if (selfPublicChannels.length === 0) {
      checks.push({
        id: "graph.self_public_channels",
        category: "graph",
        status: "warn",
        title: "No public graph channels for this node",
        detail: "Local private channels can still pay, but public route discovery may be limited.",
        action: "Confirm private hop hints or public channel announcements"
      });
    }
  }

  const disabledDirections = channels.reduce((count, channel) => {
    const updates = [channel.update_info_of_node1, channel.update_info_of_node2].filter(Boolean);
    return count + updates.filter((update) => update?.enabled === false).length;
  }, 0);

  if (disabledDirections > 0) {
    checks.push({
      id: "graph.disabled_directions",
      category: "graph",
      status: "info",
      title: "Disabled graph directions observed",
      detail: `${disabledDirections} channel direction(s) in the sampled graph are disabled.`
    });
  }

  return checks;
}

function parseInvoiceFacts(invoice: CkbInvoice): ParsedInvoiceFacts {
  const attrs = invoice.data?.attrs ?? [];
  const timestampSeconds = quantityToNumber(invoice.data?.timestamp);
  const expirySeconds = quantityToNumber(readAttr(attrs, ["expiry_time", "ExpiryTime"]));
  const payeePubkey = readAttr(attrs, ["payee_public_key", "PayeePublicKey"]);
  const udtScript = readAttr(attrs, ["udt_script", "UdtScript"]);
  const features = readAttr(attrs, ["feature", "Feature"]);
  const featureText = Array.isArray(features) ? features.join(" ") : String(features ?? "");

  return {
    amount: quantityToBigInt(invoice.amount),
    currency: invoice.currency,
    paymentHash: invoice.data?.payment_hash,
    timestamp: timestampSeconds,
    expirySeconds,
    expiresAtMs:
      timestampSeconds !== undefined && expirySeconds !== undefined
        ? (timestampSeconds + expirySeconds) * 1000
        : undefined,
    payeePubkey: typeof payeePubkey === "string" ? payeePubkey : undefined,
    udtScript: typeof udtScript === "string" ? scriptFingerprint(udtScript) : scriptFingerprint(udtScript),
    allowsMpp: /mpp/i.test(featureText),
    allowsTrampoline: /trampoline/i.test(featureText),
    raw: invoice
  };
}

function readAttr(attrs: unknown[], names: string[]): unknown {
  for (const attr of attrs) {
    if (!attr || typeof attr !== "object") continue;
    const record = attr as Record<string, unknown>;
    for (const name of names) {
      if (name in record) return record[name];
    }
  }
  return undefined;
}

function invoiceEvidence(invoice: ParsedInvoiceFacts): Evidence[] {
  const evidence: Evidence[] = [];
  if (invoice.currency) evidence.push({ label: "Invoice network", value: invoice.currency });
  if (invoice.amount !== undefined) evidence.push({ label: "Invoice amount", value: formatAmount(invoice.amount) });
  if (invoice.paymentHash) evidence.push({ label: "Payment hash", value: compactHash(invoice.paymentHash) });
  if (invoice.payeePubkey) evidence.push({ label: "Payee", value: compactHash(invoice.payeePubkey) });
  if (invoice.udtScript) evidence.push({ label: "Asset", value: "UDT" });
  return evidence;
}

function summarizeRoute(payment: PaymentResult): RouteSummary {
  const routes = payment.routers ?? (payment.router ? [{ nodes: payment.router }] : []);
  const hops = routes.flatMap((route) =>
    (route.nodes ?? []).map((node) => ({
      pubkey: compactHash(node.pubkey),
      amount: node.amount === undefined ? undefined : formatAmount(node.amount),
      channelOutpoint: compactHash(outpointToString(node.channel_outpoint))
    }))
  );

  return {
    fee: formatAmount(payment.fee),
    feeRaw: typeof payment.fee === "string" ? payment.fee : undefined,
    routeCount: routes.length,
    hopCount: hops.length,
    hops
  };
}

function actionsFromChecks(checks: CheckResult[]): SuggestedAction[] {
  return checks
    .filter((check) => check.action && (check.status === "fail" || check.status === "warn"))
    .map((check) => ({
      title: check.action as string,
      detail: check.detail,
      priority: check.status === "fail" ? "high" : "medium"
    }));
}

function dedupeActions(actions: SuggestedAction[]): SuggestedAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = action.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function finalizeReport(
  kind: PreflightReport["kind"],
  checks: CheckResult[],
  actions: SuggestedAction[],
  evidence: Evidence[],
  raw: Record<string, unknown>,
  route?: RouteSummary,
  probes?: ProbeResult[]
): PreflightReport {
  const verdict = deriveVerdict(checks);
  const score = deriveScore(checks);
  const report: PreflightReport = {
    kind,
    verdict,
    score,
    summary: summarizeVerdict(kind, verdict, checks),
    checks,
    actions,
    evidence,
    probes: probes && probes.length > 0 ? probes : undefined,
    route,
    raw
  };
  return {
    ...report,
    runbook: buildPreflightRunbook(report)
  };
}

function deriveVerdict(checks: CheckResult[]): Verdict {
  const criticalFail = checks.some(
    (check) =>
      check.status === "fail" &&
      ["rpc", "invoice", "liquidity", "route", "postmortem"].includes(check.category)
  );
  if (criticalFail) return "blocked";
  const routePass = checks.some(
    (check) =>
      (check.id === "route.dry_run" || check.id === "route.probe_success") &&
      check.status === "pass"
  );
  if (routePass && checks.some((check) => check.status === "warn")) return "risky";
  if (routePass) return "payable";
  if (checks.some((check) => check.status === "warn")) return "risky";
  return "unknown";
}

function deriveScore(checks: CheckResult[]): number {
  const score = checks.reduce((current, check) => {
    if (check.status === "fail") return current - 25;
    if (check.status === "warn") return current - 8;
    if (check.status === "skip") return current - 3;
    return current;
  }, 100);
  return Math.max(0, Math.min(100, score));
}

function summarizeVerdict(
  kind: PreflightReport["kind"],
  verdict: Verdict,
  checks: CheckResult[]
): string {
  const firstFailure = checks.find((check) => check.status === "fail");
  if (kind === "payment-postmortem" && firstFailure) return firstFailure.title;
  if (verdict === "payable") return "This payment looks payable from the current node.";
  if (verdict === "risky") return "This payment may work, but Fiber Preflight found risk factors.";
  if (verdict === "blocked") return firstFailure?.title ?? "This payment is blocked.";
  return "Fiber Preflight needs more information to make a route verdict.";
}

function normalizePubkey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/^0x/, "").toLowerCase();
}
