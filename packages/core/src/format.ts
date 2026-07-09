export function toHexQuantity(value: string | number | bigint | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("0x")) return trimmed;
    if (/^\d+$/.test(trimmed)) return `0x${BigInt(trimmed).toString(16)}`;
    return trimmed;
  }
  return `0x${BigInt(value).toString(16)}`;
}

export function quantityToBigInt(value: unknown): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    try {
      return trimmed.startsWith("0x") ? BigInt(trimmed) : BigInt(trimmed);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function quantityToNumber(value: unknown): number | undefined {
  const parsed = quantityToBigInt(value);
  if (parsed === undefined) return undefined;
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  return Number(parsed);
}

export function formatAmount(value: unknown): string {
  const parsed = quantityToBigInt(value);
  if (parsed === undefined) return "unknown";
  return parsed.toLocaleString("en-US");
}

export function compactHash(value: unknown, head = 8, tail = 6): string {
  if (typeof value !== "string") return "unknown";
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

export function stableStringify(value: unknown): string {
  if (value === undefined) return "";
  return JSON.stringify(value, (_key, inner) => {
    if (typeof inner === "bigint") return inner.toString();
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)));
    }
    return inner;
  });
}

export function scriptFingerprint(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.toLowerCase();
  return stableStringify(value).toLowerCase();
}

export function channelStateName(state: unknown): string {
  if (typeof state === "string") return state;
  if (!state || typeof state !== "object") return "Unknown";
  const record = state as Record<string, unknown>;
  if (typeof record.state_name === "string") return record.state_name;
  if (typeof record.type === "string") return record.type;
  const keys = Object.keys(record);
  return keys[0] ?? "Unknown";
}

export function outpointToString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  return stableStringify(value);
}
