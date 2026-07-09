import { channelStateName, compactHash, formatAmount, outpointToString, quantityToBigInt } from "./format.js";
import type {
  Channel,
  CkbInvoice,
  LiquidityChannelInsight,
  LiquidityInsight,
  RouteSummary
} from "./types.js";

export interface BuildLiquidityInsightOptions {
  amount?: unknown;
  asset?: LiquidityInsight["asset"];
  route?: RouteSummary;
}

export function buildLiquidityInsight(
  channels: Channel[],
  options: BuildLiquidityInsightOptions
): LiquidityInsight | undefined {
  const amount = quantityToBigInt(options.amount);
  const asset = options.asset ?? "unknown";
  if (asset === "unknown" && amount === undefined) return undefined;

  const readyEnabled = channels.filter(
    (channel) => channelStateName(channel.state) === "ChannelReady" && channel.enabled !== false
  );
  const matchingChannels = asset === "unknown"
    ? readyEnabled
    : readyEnabled.filter((channel) =>
        asset === "UDT" ? Boolean(channel.funding_udt_type_script) : !channel.funding_udt_type_script
      );
  const channelInsights = matchingChannels
    .map((channel) => liquidityChannelInsight(channel, amount))
    .sort(compareLiquidityChannels);

  const total = matchingChannels.reduce(
    (sum, channel) => sum + (quantityToBigInt(channel.local_balance) ?? 0n),
    0n
  );
  const largest = matchingChannels.reduce((max, channel) => {
    const local = quantityToBigInt(channel.local_balance) ?? 0n;
    return local > max ? local : max;
  }, 0n);
  const shortage = amount !== undefined && total < amount ? amount - total : undefined;
  const canPayWithSingleChannel = amount === undefined ? undefined : largest >= amount;
  const likelyNeedsMpp =
    amount !== undefined && total >= amount && largest < amount && matchingChannels.length > 1;
  const status: LiquidityInsight["status"] =
    matchingChannels.length === 0 || shortage !== undefined ? "fail" : likelyNeedsMpp ? "warn" : "pass";
  const title = liquidityInsightTitle(status, likelyNeedsMpp);
  const routeCorrelation = liquidityRouteCorrelation({
    amount,
    asset,
    matchingChannelCount: matchingChannels.length,
    total,
    largest,
    shortage,
    likelyNeedsMpp,
    route: options.route
  });

  return {
    status,
    title,
    summary: routeCorrelation,
    asset,
    amount: amount === undefined ? undefined : formatAmount(amount),
    matchingChannelCount: matchingChannels.length,
    totalLocalBalance: formatAmount(total),
    largestLocalBalance: formatAmount(largest),
    shortage: shortage === undefined ? undefined : formatAmount(shortage),
    canPayWithSingleChannel,
    likelyNeedsMpp,
    routeCorrelation,
    largestChannel: channelInsights[0],
    channels: channelInsights.slice(0, 5)
  };
}

export function invoiceLiquidityAsset(invoice: CkbInvoice | undefined): LiquidityInsight["asset"] {
  if (!invoice) return "unknown";
  const attrs = invoice.data?.attrs ?? [];
  const hasUdtScript = attrs.some((attr) => {
    if (!attr || typeof attr !== "object") return false;
    return "udt_script" in attr || "UdtScript" in attr;
  });
  return hasUdtScript ? "UDT" : "CKB";
}

function liquidityChannelInsight(channel: Channel, amount: bigint | undefined): LiquidityChannelInsight {
  const local = quantityToBigInt(channel.local_balance) ?? 0n;
  const channelOutpoint = outpointToString(channel.channel_outpoint);
  return {
    channelId: compactHash(channel.channel_id ?? channelOutpoint),
    peer: compactHash(channel.pubkey),
    channelOutpoint: channelOutpoint ? compactHash(channelOutpoint) : undefined,
    asset: channel.funding_udt_type_script ? "UDT" : "CKB",
    state: channelStateName(channel.state),
    enabled: channel.enabled !== false,
    isPublic: channel.is_public === true,
    localBalance: formatAmount(local),
    remoteBalance: formatAmount(channel.remote_balance),
    pendingTlcCount: channel.pending_tlcs?.length ?? 0,
    canCoverAmount: amount === undefined ? undefined : local >= amount
  };
}

function compareLiquidityChannels(
  left: LiquidityChannelInsight,
  right: LiquidityChannelInsight
): number {
  const leftBalance = quantityToBigInt(left.localBalance.replace(/,/g, "")) ?? 0n;
  const rightBalance = quantityToBigInt(right.localBalance.replace(/,/g, "")) ?? 0n;
  if (leftBalance === rightBalance) return left.peer.localeCompare(right.peer);
  return leftBalance > rightBalance ? -1 : 1;
}

function liquidityInsightTitle(status: LiquidityInsight["status"], likelyNeedsMpp: boolean): string {
  if (status === "fail") return "Liquidity blocker";
  if (likelyNeedsMpp) return "MPP likely required";
  return "Liquidity matches route amount";
}

function liquidityRouteCorrelation(input: {
  amount: bigint | undefined;
  asset: LiquidityInsight["asset"];
  matchingChannelCount: number;
  total: bigint;
  largest: bigint;
  shortage: bigint | undefined;
  likelyNeedsMpp: boolean;
  route?: RouteSummary;
}): string {
  const assetLabel = input.asset === "unknown" ? "matching" : input.asset;
  if (input.matchingChannelCount === 0) {
    return `No enabled ready ${assetLabel} channel matches this payment.`;
  }
  if (input.amount === undefined) {
    return `${input.matchingChannelCount} matching channel(s), largest local balance ${formatAmount(input.largest)}.`;
  }
  if (input.shortage !== undefined) {
    return `${assetLabel} liquidity is short by ${formatAmount(input.shortage)} against amount ${formatAmount(input.amount)}.`;
  }
  if (input.likelyNeedsMpp) {
    if ((input.route?.routeCount ?? 0) > 1) {
      return `No single channel covers ${formatAmount(input.amount)}; the dry-run route uses ${input.route?.routeCount} parts.`;
    }
    return `No single channel covers ${formatAmount(input.amount)}; use MPP or add a larger channel.`;
  }
  if (input.route) {
    return `Largest matching channel covers the amount; route uses ${input.route.routeCount || 1} path(s) and ${input.route.hopCount} hop(s).`;
  }
  return `Matching ${assetLabel} liquidity covers amount ${formatAmount(input.amount)}; investigate fee policy or graph visibility if routing still fails.`;
}
