import {
  channelStateName,
  compactHash,
  formatAmount,
  outpointToString,
  quantityToBigInt
} from "./format.js";
import type { Channel, ChannelInventoryItem, ChannelInventoryReport, RpcLike } from "./types.js";

export interface InspectChannelsOptions {
  includeClosed?: boolean;
  includePending?: boolean;
}

export async function inspectChannels(
  rpc: RpcLike,
  options: InspectChannelsOptions = {}
): Promise<ChannelInventoryReport> {
  const result = await callListChannels(rpc, options);
  const channels = result.channels ?? [];
  const items = channels.map(channelInventoryItem);
  const pendingResult = options.includePending ? await callPendingChannels(rpc) : undefined;
  const pendingItems = pendingResult?.result?.channels?.map(channelInventoryItem) ?? [];

  const ready = channels.filter((channel) => channelStateName(channel.state) === "ChannelReady");
  const enabledReady = ready.filter((channel) => channel.enabled !== false);
  const ckbLocal = enabledReady
    .filter((channel) => !channel.funding_udt_type_script)
    .reduce((sum, channel) => sum + (quantityToBigInt(channel.local_balance) ?? 0n), 0n);
  const udtLocal = enabledReady
    .filter((channel) => channel.funding_udt_type_script)
    .reduce((sum, channel) => sum + (quantityToBigInt(channel.local_balance) ?? 0n), 0n);
  const pendingTlcCount = enabledReady.reduce(
    (sum, channel) => sum + (channel.pending_tlcs?.length ?? 0),
    0
  );

  const pendingSummary = pendingItems.length > 0 ? ` ${pendingItems.length} channel(s) are pending funding.` : "";

  return {
    summary: `${enabledReady.length}/${channels.length} channels are ready and enabled.${pendingSummary}`,
    totals: {
      total: channels.length,
      ready: ready.length,
      enabledReady: enabledReady.length,
      publicChannels: channels.filter((channel) => channel.is_public === true).length,
      privateChannels: channels.filter((channel) => channel.is_public !== true).length,
      ckbLocalBalance: formatAmount(ckbLocal),
      udtLocalBalance: formatAmount(udtLocal),
      pendingTlcCount
    },
    channels: items,
    ...(options.includePending ? { pendingChannels: pendingItems } : {}),
    raw: {
      list_channels: result,
      ...(options.includePending
        ? {
            pending_channels: pendingResult?.result,
            pending_channels_error: pendingResult?.error
          }
        : {})
    }
  };
}

function channelInventoryItem(channel: Channel): ChannelInventoryItem {
  const state = channelStateName(channel.state);
  const asset: ChannelInventoryItem["asset"] = channel.funding_udt_type_script ? "UDT" : "CKB";
  const channelOutpoint = outpointToString(channel.channel_outpoint);
  return {
    channelId: compactHash(channel.channel_id ?? channelOutpoint),
    ...(channelOutpoint ? { channelOutpoint } : {}),
    peer: compactHash(channel.pubkey),
    state,
    enabled: channel.enabled !== false,
    isPublic: channel.is_public === true,
    isOneWay: channel.is_one_way === true,
    isAcceptor: channel.is_acceptor === true,
    asset,
    localBalance: formatAmount(channel.local_balance),
    remoteBalance: formatAmount(channel.remote_balance),
    pendingTlcCount: channel.pending_tlcs?.length ?? 0,
    failureDetail: channel.failure_detail ?? undefined
  };
}

async function callListChannels(
  rpc: RpcLike,
  options: InspectChannelsOptions
): Promise<{ channels?: Channel[] }> {
  const params = options.includeClosed ? [{ include_closed: true }] : [{}];
  try {
    return await rpc.call<{ channels?: Channel[] }>("list_channels", params);
  } catch (firstError) {
    if (options.includeClosed) throw firstError;
    return rpc.call<{ channels?: Channel[] }>("list_channels", []);
  }
}

async function callPendingChannels(
  rpc: RpcLike
): Promise<{ result?: { channels?: Channel[] }; error?: string }> {
  try {
    return {
      result: await rpc.call<{ channels?: Channel[] }>("list_channels", [{ only_pending: true }])
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
