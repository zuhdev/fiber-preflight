export type HexQuantity = `0x${string}`;
export type CheckStatus = "pass" | "warn" | "fail" | "info" | "skip";
export type Verdict = "payable" | "risky" | "blocked" | "unknown";
export type CheckCategory =
  | "rpc"
  | "invoice"
  | "node"
  | "liquidity"
  | "graph"
  | "probe"
  | "route"
  | "postmortem";

export interface RpcLike {
  call<T = unknown>(method: string, params?: unknown[]): Promise<T>;
}

export interface CheckResult {
  id: string;
  category: CheckCategory;
  status: CheckStatus;
  title: string;
  detail: string;
  action?: string;
  evidence?: unknown;
}

export interface SuggestedAction {
  title: string;
  detail: string;
  command?: string;
  priority: "high" | "medium" | "low";
}

export type RunbookPriority = "critical" | "high" | "medium" | "low";
export type RunbookStepStatus = "ready" | "blocked" | "manual";

export interface RunbookStep {
  id: string;
  priority: RunbookPriority;
  status: RunbookStepStatus;
  title: string;
  detail: string;
  owner: "operator" | "wallet" | "merchant" | "network";
  command?: string;
  params?: Record<string, string>;
  source?: string;
}

export interface RunbookPlan {
  summary: string;
  nextBestAction?: string;
  steps: RunbookStep[];
}

export interface Evidence {
  label: string;
  value: string;
  raw?: unknown;
}

export interface RouteHopSummary {
  pubkey: string;
  amount?: string;
  channelOutpoint?: string;
}

export interface RoutePathSummary {
  id: string;
  label: string;
  hopCount: number;
  amount?: string;
  hops: RouteHopSummary[];
}

export interface RouteSummary {
  fee: string;
  feeRaw?: string;
  routeCount: number;
  hopCount: number;
  hops: RouteHopSummary[];
  paths?: RoutePathSummary[];
}

export interface ProbeResult {
  id: string;
  label: string;
  status: "pass" | "fail" | "skip";
  summary: string;
  params: Record<string, unknown>;
  route?: RouteSummary;
  error?: string;
}

export interface RouteProbeInput extends PreflightInput {
  feeRates?: Array<string | number | bigint>;
  partOptions?: Array<string | number | bigint>;
  stopOnFirstSuccess?: boolean;
}

export interface RouteProbeAttempt {
  id: string;
  label: string;
  status: "pass" | "fail";
  feeRate?: string;
  maxParts?: string;
  fee?: string;
  hopCount?: number;
  route?: RouteSummary;
  error?: string;
  params: Record<string, unknown>;
}

export interface RouteProbeReport {
  kind: "route-probe";
  verdict: Verdict;
  score: number;
  summary: string;
  attempts: RouteProbeAttempt[];
  best?: RouteProbeAttempt;
  evidence: Evidence[];
  actions: SuggestedAction[];
  runbook?: RunbookPlan;
  raw?: Record<string, unknown>;
}

export interface PreflightReport {
  kind: "invoice-preflight" | "payment-postmortem";
  verdict: Verdict;
  score: number;
  summary: string;
  checks: CheckResult[];
  actions: SuggestedAction[];
  evidence: Evidence[];
  probes?: ProbeResult[];
  route?: RouteSummary;
  runbook?: RunbookPlan;
  raw?: Record<string, unknown>;
}

export interface PreflightInput {
  invoice?: string;
  amount?: string | number | bigint;
  maxFeeAmount?: string | number | bigint;
  maxFeeRate?: string | number | bigint;
  maxParts?: string | number | bigint;
  graphLimit?: number;
  skipDryRun?: boolean;
}

export interface PaymentExplainInput {
  paymentHash: string;
}

export interface ChannelInventoryItem {
  channelId: string;
  peer: string;
  state: string;
  enabled: boolean;
  isPublic: boolean;
  isOneWay: boolean;
  isAcceptor: boolean;
  asset: "CKB" | "UDT";
  localBalance: string;
  remoteBalance: string;
  pendingTlcCount: number;
  failureDetail?: string;
}

export interface ChannelInventoryReport {
  summary: string;
  totals: {
    total: number;
    ready: number;
    enabledReady: number;
    publicChannels: number;
    privateChannels: number;
    ckbLocalBalance: string;
    udtLocalBalance: string;
    pendingTlcCount: number;
  };
  channels: ChannelInventoryItem[];
  raw?: Record<string, unknown>;
}

export type NodeStatusVerdict = "ready" | "limited" | "blocked";

export interface NodeStatusReport {
  kind: "node-status";
  verdict: NodeStatusVerdict;
  score: number;
  summary: string;
  checks: CheckResult[];
  evidence: Evidence[];
  raw?: Record<string, unknown>;
}

export interface NodeStatusInput {
  sampleInvoice?: string;
}

export interface NodeInfoResult {
  version?: string;
  commit_hash?: string;
  pubkey?: string;
  features?: string[];
  node_name?: string | null;
  addresses?: string[];
  chain_hash?: string;
  channel_count?: string | number;
  pending_channel_count?: string | number;
  peers_count?: string | number;
  udt_cfg_infos?: unknown;
  [key: string]: unknown;
}

export interface PeerInfo {
  pubkey?: string;
  address?: string;
  [key: string]: unknown;
}

export interface Channel {
  channel_id?: string;
  is_public?: boolean;
  is_acceptor?: boolean;
  is_one_way?: boolean;
  channel_outpoint?: string | Record<string, unknown> | null;
  pubkey?: string;
  funding_udt_type_script?: unknown;
  state?: unknown;
  local_balance?: string | number;
  offered_tlc_balance?: string | number;
  remote_balance?: string | number;
  received_tlc_balance?: string | number;
  pending_tlcs?: Array<Record<string, unknown>>;
  enabled?: boolean;
  tlc_expiry_delta?: string | number;
  tlc_fee_proportional_millionths?: string | number;
  failure_detail?: string | null;
  [key: string]: unknown;
}

export interface CkbInvoice {
  currency?: "Fibb" | "Fibt" | "Fibd" | string;
  amount?: string | number | null;
  signature?: string | null;
  data?: {
    timestamp?: string | number;
    payment_hash?: string;
    attrs?: unknown[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface PaymentResult {
  payment_hash?: string;
  status?: string;
  created_at?: string | number;
  last_updated_at?: string | number;
  failed_error?: string | null;
  fee?: string | number;
  routers?: Array<{
    nodes?: Array<{
      pubkey?: string;
      amount?: string | number;
      channel_outpoint?: string | Record<string, unknown>;
    }>;
  }>;
  router?: Array<{
    pubkey?: string;
    amount?: string | number;
    channel_outpoint?: string | Record<string, unknown>;
  }>;
  [key: string]: unknown;
}

export interface GraphNode {
  pubkey?: string;
  node_name?: string;
  addresses?: string[];
  features?: string[];
  timestamp?: string | number;
  chain_hash?: string;
  udt_cfg_infos?: unknown;
  [key: string]: unknown;
}

export interface GraphChannel {
  channel_outpoint?: string | Record<string, unknown>;
  node1?: string;
  node2?: string;
  created_timestamp?: string | number;
  update_info_of_node1?: ChannelUpdateInfo | null;
  update_info_of_node2?: ChannelUpdateInfo | null;
  capacity?: string | number;
  chain_hash?: string;
  udt_type_script?: unknown;
  [key: string]: unknown;
}

export interface ChannelUpdateInfo {
  timestamp?: string | number;
  enabled?: boolean;
  outbound_liquidity?: string | number | null;
  tlc_expiry_delta?: string | number;
  tlc_minimum_value?: string | number;
  fee_rate?: string | number;
  [key: string]: unknown;
}
