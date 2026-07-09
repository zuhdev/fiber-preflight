import type { RpcLike } from "./types.js";

export interface FixtureCall {
  result?: unknown;
  error?: string | { message?: string; code?: number; data?: unknown };
}

export interface FixtureScenario {
  name: string;
  description?: string;
  input?: Record<string, unknown>;
  calls: Record<string, FixtureCall | unknown | Array<FixtureCall | unknown>>;
}

export class FixtureRpc implements RpcLike {
  readonly scenario: FixtureScenario;
  private readonly callCounts = new Map<string, number>();

  constructor(scenario: FixtureScenario) {
    this.scenario = scenario;
  }

  async call<T = unknown>(method: string): Promise<T> {
    const configured = this.scenario.calls[method];
    const entry = this.pickEntry(method, configured);
    if (entry === undefined) {
      throw new Error(`Fixture does not define RPC method: ${method}`);
    }

    if (isFixtureCall(entry)) {
      if (entry.error) {
        const message = typeof entry.error === "string" ? entry.error : entry.error.message;
        throw new Error(message ?? `Fixture RPC error for ${method}`);
      }
      return entry.result as T;
    }

    return entry as T;
  }

  private pickEntry(
    method: string,
    entry: FixtureCall | unknown | Array<FixtureCall | unknown> | undefined
  ): FixtureCall | unknown | undefined {
    if (!Array.isArray(entry)) return entry;
    const count = this.callCounts.get(method) ?? 0;
    this.callCounts.set(method, count + 1);
    return entry[Math.min(count, entry.length - 1)];
  }
}

function isFixtureCall(value: unknown): value is FixtureCall {
  return Boolean(
    value &&
      typeof value === "object" &&
      ("result" in (value as Record<string, unknown>) || "error" in (value as Record<string, unknown>))
  );
}
