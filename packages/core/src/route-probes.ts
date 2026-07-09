import { classifyFailure } from "./failure-classifier.js";
import { compactHash, formatAmount, outpointToString, quantityToBigInt, toHexQuantity } from "./format.js";
import type {
  CkbInvoice,
  Evidence,
  NodeInfoResult,
  PaymentResult,
  RouteProbeAttempt,
  RouteProbeInput,
  RouteProbeReport,
  RouteSummary,
  RpcLike,
  SuggestedAction,
  Verdict
} from "./types.js";

interface SafeResult<T> {
  ok: boolean;
  value?: T;
  error?: Error;
}

export async function probeRouteOptions(
  rpc: RpcLike,
  input: RouteProbeInput
): Promise<RouteProbeReport> {
  const evidence: Evidence[] = [];
  const actions: SuggestedAction[] = [];
  const raw: Record<string, unknown> = {};

  if (!input.invoice) {
    return {
      kind: "route-probe",
      verdict: "blocked",
      score: 0,
      summary: "Route probes need an invoice before dry-run settings can be tested.",
      attempts: [],
      evidence,
      actions: [
        {
          title: "Provide a Fiber invoice",
          detail: "Probe Lab uses the invoice to run safe send_payment dry-runs across fee and MPP settings.",
          priority: "high"
        }
      ]
    };
  }

  const node = await safeCall<NodeInfoResult>(rpc, "node_info");
  raw.node_info = node.value ?? node.error?.message;
  if (node.ok && node.value) {
    evidence.push({ label: "Node", value: node.value.node_name ?? compactHash(node.value.pubkey) });
    if (node.value.pubkey) evidence.push({ label: "Pubkey", value: compactHash(node.value.pubkey) });
  } else {
    actions.push({
      title: "Fix RPC connectivity",
      detail: node.error?.message ?? "node_info failed before route probing could start.",
      priority: "high"
    });
  }

  const parsed = await safeCallVariants<{ invoice?: CkbInvoice }>(rpc, "parse_invoice", [
    [{ invoice: input.invoice }],
    [input.invoice]
  ]);
  raw.parse_invoice = parsed.value ?? parsed.error?.message;
  if (parsed.ok && parsed.value?.invoice) {
    const invoice = parsed.value.invoice;
    if (invoice.amount !== undefined && invoice.amount !== null) {
      evidence.push({ label: "Invoice amount", value: formatAmount(invoice.amount) });
    }
    if (invoice.data?.payment_hash) {
      evidence.push({ label: "Payment hash", value: compactHash(invoice.data.payment_hash) });
    }
  } else {
    actions.push({
      title: "Use a parseable invoice",
      detail: parsed.error?.message ?? "parse_invoice failed before route probing.",
      priority: "high"
    });
  }

  const feeRates = normalizeOptions(input.feeRates, input.maxFeeRate, [25, 50, 100, 250]);
  const partOptions = normalizeOptions(input.partOptions, input.maxParts, [1, 2, 4, 8, 12]);
  const attempts: RouteProbeAttempt[] = [];
  let stoppedEarly = false;

  for (const feeRate of feeRates) {
    for (const maxParts of partOptions) {
      const id = `fee-${optionId(feeRate)}-parts-${optionId(maxParts)}`;
      const params = dryRunParams(input, feeRate, maxParts);
      const result = await safeCall<PaymentResult>(rpc, "send_payment", [params]);
      raw[id] = result.value ?? result.error?.message;

      if (result.ok && result.value) {
        const route = summarizeRoute(result.value);
        attempts.push({
          id,
          label: `Fee ${optionLabel(feeRate)} / ${optionLabel(maxParts)} part${optionLabel(maxParts) === "1" ? "" : "s"}`,
          status: "pass",
          feeRate: optionLabel(feeRate),
          maxParts: optionLabel(maxParts),
          fee: route.fee,
          hopCount: route.hopCount,
          route,
          params
        });
        if (input.stopOnFirstSuccess) {
          stoppedEarly = true;
          break;
        }
      } else {
        const classification = classifyFailure(result.error?.message);
        attempts.push({
          id,
          label: `Fee ${optionLabel(feeRate)} / ${optionLabel(maxParts)} part${optionLabel(maxParts) === "1" ? "" : "s"}`,
          status: "fail",
          feeRate: optionLabel(feeRate),
          maxParts: optionLabel(maxParts),
          error: classification.title,
          params
        });
        actions.push(...classification.actions);
      }
    }
    if (stoppedEarly) break;
  }

  const best = chooseBestAttempt(attempts);
  const passingCount = attempts.filter((attempt) => attempt.status === "pass").length;
  evidence.push({ label: "Probe attempts", value: String(attempts.length) });
  evidence.push({ label: "Passing settings", value: String(passingCount) });
  if (best) {
    evidence.push({
      label: "Best setting",
      value: `fee ${best.feeRate ?? "default"}, parts ${best.maxParts ?? "default"}`
    });
    actions.unshift({
      title: "Use the best passing dry-run setting",
      detail: `Try max fee rate ${best.feeRate ?? "default"} with up to ${best.maxParts ?? "default"} parts. Estimated fee: ${best.fee ?? "unknown"}.`,
      priority: "high"
    });
  }

  return {
    kind: "route-probe",
    verdict: deriveVerdict(attempts, best),
    score: deriveScore(attempts, best),
    summary: summarizeProbeResult(attempts, best),
    attempts,
    best,
    evidence,
    actions: dedupeActions(actions),
    raw
  };
}

function dryRunParams(
  input: RouteProbeInput,
  feeRate: string | number | bigint,
  maxParts: string | number | bigint
): Record<string, unknown> {
  return stripUndefined({
    invoice: input.invoice,
    dry_run: true,
    amount: toHexQuantity(input.amount),
    max_fee_amount: toHexQuantity(input.maxFeeAmount),
    max_fee_rate: toHexQuantity(feeRate),
    max_parts: toHexQuantity(maxParts)
  });
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

function normalizeOptions(
  provided: Array<string | number | bigint> | undefined,
  preferred: string | number | bigint | undefined,
  defaults: number[]
): Array<string | number | bigint> {
  const values = provided && provided.length > 0 ? [...provided] : [...defaults];
  if (preferred !== undefined) values.unshift(preferred);

  const seen = new Set<string>();
  return values.filter((value) => {
    const key = optionLabel(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function optionLabel(value: string | number | bigint): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return String(value);
  const trimmed = value.trim();
  if (trimmed.startsWith("0x")) return quantityToBigInt(trimmed)?.toString() ?? trimmed;
  return trimmed;
}

function optionId(value: string | number | bigint): string {
  return optionLabel(value).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "default";
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

function chooseBestAttempt(attempts: RouteProbeAttempt[]): RouteProbeAttempt | undefined {
  const passing = attempts.filter((attempt) => attempt.status === "pass");
  return passing.sort(compareAttempts)[0];
}

function compareAttempts(left: RouteProbeAttempt, right: RouteProbeAttempt): number {
  const leftFee = quantityToBigInt(left.route?.feeRaw) ?? BigInt(Number.MAX_SAFE_INTEGER);
  const rightFee = quantityToBigInt(right.route?.feeRaw) ?? BigInt(Number.MAX_SAFE_INTEGER);
  if (leftFee !== rightFee) return leftFee < rightFee ? -1 : 1;

  const leftParts = quantityToBigInt(left.maxParts) ?? BigInt(Number.MAX_SAFE_INTEGER);
  const rightParts = quantityToBigInt(right.maxParts) ?? BigInt(Number.MAX_SAFE_INTEGER);
  if (leftParts !== rightParts) return leftParts < rightParts ? -1 : 1;

  const leftRate = quantityToBigInt(left.feeRate) ?? BigInt(Number.MAX_SAFE_INTEGER);
  const rightRate = quantityToBigInt(right.feeRate) ?? BigInt(Number.MAX_SAFE_INTEGER);
  if (leftRate !== rightRate) return leftRate < rightRate ? -1 : 1;

  return 0;
}

function deriveVerdict(attempts: RouteProbeAttempt[], best: RouteProbeAttempt | undefined): Verdict {
  if (!attempts.length) return "blocked";
  if (!best) return "blocked";
  return attempts[0]?.status === "pass" ? "payable" : "risky";
}

function deriveScore(attempts: RouteProbeAttempt[], best: RouteProbeAttempt | undefined): number {
  if (!attempts.length) return 0;
  if (!best) return 35;
  const failureCount = attempts.filter((attempt) => attempt.status === "fail").length;
  const score = attempts[0]?.status === "pass" ? 96 : 84;
  return Math.max(55, score - Math.min(24, failureCount * 2));
}

function summarizeProbeResult(
  attempts: RouteProbeAttempt[],
  best: RouteProbeAttempt | undefined
): string {
  if (!attempts.length) return "No route probes were run.";
  if (!best) return "No tested fee or MPP setting produced a dry-run route.";
  return `Best dry-run setting: max fee rate ${best.feeRate ?? "default"}, max parts ${best.maxParts ?? "default"}, estimated fee ${best.fee ?? "unknown"}.`;
}

function dedupeActions(actions: SuggestedAction[]): SuggestedAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = `${action.title}:${action.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, inner]) => inner !== undefined)) as T;
}
