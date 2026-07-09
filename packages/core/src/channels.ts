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
}

export async function inspectChannels(
  rpc: RpcLike,
  options: InspectChannelsOptions = {}
): Promise<ChannelInventoryReport> {
  const result = await callListChannels(rpc, options);
  const channels = result.channels ?? [];
  const items: ChannelInventoryItem[] = channels.map((channel) => {
    const state = channelStateName(channel.state);
    const asset: ChannelInventoryItem["asset"] = channel.funding_udt_type_script ? "UDT" : "CKB";
    return {
      channelId: compactHash(channel.channel_id ?? outpointToString(channel.channel_outpoint)),
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
  });

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

  return {
    summary: `${enabledReady.length}/${channels.length} channels are ready and enabled.`,
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
    raw: {
      list_channels: result
    }
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
