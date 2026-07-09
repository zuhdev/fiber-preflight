import type { SuggestedAction } from "./types.js";

export interface FailureClassification {
  code: string;
  title: string;
  detail: string;
  retryable: boolean;
  actions: SuggestedAction[];
}

const failureMap: Record<string, Omit<FailureClassification, "code">> = {
  InvoiceExpired: {
    title: "Invoice expired",
    detail: "The recipient invoice has passed its expiry window.",
    retryable: false,
    actions: [
      {
        title: "Request a fresh invoice",
        detail: "The route may be healthy, but this invoice can no longer be paid.",
        priority: "high"
      }
    ]
  },
  InvoiceCancelled: {
    title: "Invoice cancelled",
    detail: "The recipient cancelled this invoice before settlement.",
    retryable: false,
    actions: [
      {
        title: "Ask the recipient to issue a new invoice",
        detail: "Do not retry the same payment hash unless the recipient explicitly restores it.",
        priority: "high"
      }
    ]
  },
  IncorrectOrUnknownPaymentDetails: {
    title: "Payment details rejected",
    detail: "The final recipient did not recognize the amount, hash, asset, or invoice details.",
    retryable: false,
    actions: [
      {
        title: "Verify invoice amount and asset",
        detail: "Re-parse the invoice and confirm the amount, payee, payment hash, and UDT/native asset.",
        priority: "high"
      }
    ]
  },
  FeeInsufficient: {
    title: "Fee budget too low",
    detail: "The selected route requires more forwarding fee than the payment allowed.",
    retryable: true,
    actions: [
      {
        title: "Raise the fee cap",
        detail: "Try a higher max fee amount or max fee rate, then run preflight again.",
        priority: "high"
      }
    ]
  },
  TemporaryChannelFailure: {
    title: "Temporary channel failure",
    detail: "A channel on the route could not currently forward the payment.",
    retryable: true,
    actions: [
      {
        title: "Retry with alternate routing",
        detail: "Use MPP if the invoice supports it, wait for liquidity to shift, or rebalance local channels.",
        priority: "medium"
      }
    ]
  },
  ChannelDisabled: {
    title: "Route uses a disabled channel",
    detail: "A channel direction in the candidate path is currently disabled.",
    retryable: true,
    actions: [
      {
        title: "Wait for gossip or choose another path",
        detail: "The graph may need to update, or the peer may need to re-enable the channel.",
        priority: "medium"
      }
    ]
  },
  UnknownNextPeer: {
    title: "Next peer unknown",
    detail: "A forwarding node could not reach or identify the next hop.",
    retryable: true,
    actions: [
      {
        title: "Refresh peer and graph state",
        detail: "Reconnect peers or wait for gossip updates before retrying.",
        priority: "medium"
      }
    ]
  },
  AmountBelowMinimum: {
    title: "Amount below route minimum",
    detail: "A channel policy requires a larger TLC amount than this payment carries.",
    retryable: false,
    actions: [
      {
        title: "Increase the payment amount or choose another route",
        detail: "Small payments can fail when intermediary channels enforce minimum TLC values.",
        priority: "medium"
      }
    ]
  },
  RequiredNodeFeatureMissing: {
    title: "Required node feature missing",
    detail: "A node in the route does not support a feature required by this payment.",
    retryable: false,
    actions: [
      {
        title: "Disable incompatible routing mode",
        detail: "Check trampoline, MPP, custom record, and invoice feature requirements.",
        priority: "high"
      }
    ]
  },
  RequiredChannelFeatureMissing: {
    title: "Required channel feature missing",
    detail: "A channel in the route does not support a feature required by this payment.",
    retryable: false,
    actions: [
      {
        title: "Use a different channel path",
        detail: "Run preflight again with route hints removed or with a different peer/channel.",
        priority: "medium"
      }
    ]
  },
  ExpiryTooSoon: {
    title: "Expiry too soon",
    detail: "The TLC expiry budget is too short for the route.",
    retryable: false,
    actions: [
      {
        title: "Use a longer expiry window",
        detail: "Request an invoice with more time or increase TLC expiry limits if you set them manually.",
        priority: "medium"
      }
    ]
  },
  ExpiryTooFar: {
    title: "Expiry too far",
    detail: "The TLC expiry exceeds a route or node policy.",
    retryable: false,
    actions: [
      {
        title: "Reduce the expiry limit",
        detail: "Try default expiry settings first, then run preflight again.",
        priority: "medium"
      }
    ]
  },
  HoldTlcTimeout: {
    title: "Hold invoice timed out",
    detail: "The payment reached a hold-invoice flow but the preimage was not released in time.",
    retryable: false,
    actions: [
      {
        title: "Coordinate with the recipient",
        detail: "The merchant or swap service must settle or issue a fresh invoice.",
        priority: "high"
      }
    ]
  },
  PermanentChannelFailure: {
    title: "Permanent channel failure",
    detail: "A channel in the route is unusable for this payment.",
    retryable: true,
    actions: [
      {
        title: "Avoid the failed channel",
        detail: "Wait for graph updates or use route hints to steer around the bad channel.",
        priority: "medium"
      }
    ]
  },
  TemporaryNodeFailure: {
    title: "Temporary node failure",
    detail: "A forwarding node is currently unable to handle the payment.",
    retryable: true,
    actions: [
      {
        title: "Retry later or choose another path",
        detail: "The failure can clear without changing the invoice.",
        priority: "low"
      }
    ]
  }
};

export function classifyFailure(error: unknown): FailureClassification {
  const message = typeof error === "string" ? error : "";
  const matched = Object.keys(failureMap).find((key) => message.includes(key));

  if (matched) {
    return {
      code: matched,
      ...failureMap[matched]
    };
  }

  if (/Failed to build route/i.test(message)) {
    return {
      code: "BuildRouteFailed",
      title: "No usable route",
      detail: message || "Fiber could not build a payment route from this node.",
      retryable: true,
      actions: [
        {
          title: "Check liquidity, graph visibility, and asset support",
          detail: "Confirm local ready channels, peer connectivity, target visibility, and fee budget.",
          priority: "high"
        }
      ]
    };
  }

  if (/Unauthorized/i.test(message)) {
    return {
      code: "Unauthorized",
      title: "RPC token missing permission",
      detail: "The Biscuit token does not allow this RPC method.",
      retryable: false,
      actions: [
        {
          title: "Use a scoped token with required read/write permissions",
          detail: "Preflight needs node, peer, channel, graph, invoice, and payment permissions.",
          priority: "high"
        }
      ]
    };
  }

  return {
    code: "Unknown",
    title: "Unclassified failure",
    detail: message || "Fiber returned a failure that Fiber Preflight does not classify yet.",
    retryable: true,
    actions: [
      {
        title: "Inspect raw payment details",
        detail: "Check the raw payment result and route history, then rerun preflight with JSON output.",
        priority: "medium"
      }
    ]
  };
}
