import type { RpcLike } from "./types.js";

export interface FiberRpcClientOptions {
  url: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number | string;
}

export const DEFAULT_RPC_TIMEOUT_MS = 10_000;

export class FiberRpcError extends Error {
  readonly code?: number;
  readonly data?: unknown;
  readonly method?: string;

  constructor(message: string, options: { code?: number; data?: unknown; method?: string } = {}) {
    super(message);
    this.name = "FiberRpcError";
    this.code = options.code;
    this.data = options.data;
    this.method = options.method;
  }
}

export function normalizeRpcTimeoutMs(
  value: number | string | null | undefined,
  fallback = DEFAULT_RPC_TIMEOUT_MS
): number {
  if (value === undefined || value === null || value === "") return fallback;

  const normalized = typeof value === "number" ? value : value.trim();
  if (normalized === "") return fallback;

  const parsed = typeof normalized === "number" ? normalized : Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new FiberRpcError("Invalid Fiber RPC timeout: expected a non-negative millisecond value.");
  }

  return Math.trunc(parsed);
}

export class FiberRpcClient implements RpcLike {
  private id = 1;
  private readonly fetchImpl: typeof fetch;
  private readonly url: string;
  private readonly token?: string;
  private readonly timeoutMs: number;

  constructor(options: FiberRpcClientOptions) {
    this.url = validateRpcUrl(options.url);
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = normalizeRpcTimeoutMs(options.timeoutMs);
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json"
    };

    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }

    let response: Response;
    try {
      response = await this.postWithTimeout(method, headers, params);
    } catch (error) {
      if (error instanceof FiberRpcError) throw error;
      const detail = error instanceof Error ? error.message : "Failed to reach Fiber RPC";
      throw new FiberRpcError(`Could not reach Fiber RPC at ${this.url} while calling ${method}: ${detail}`, {
        method
      });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new FiberRpcError(`Fiber RPC ${method} returned non-JSON response (HTTP ${response.status}).`, {
        method
      });
    }

    const envelope = body as {
      result?: T;
      error?: { code?: number; message?: string; data?: unknown };
    };

    if (!response.ok || envelope.error) {
      const message = envelope.error?.message
        ? `Fiber RPC ${method} failed: ${envelope.error.message}`
        : `Fiber RPC ${method} failed with HTTP ${response.status}`;
      throw new FiberRpcError(message, {
        code: envelope.error?.code,
        data: envelope.error?.data,
        method
      });
    }

    return envelope.result as T;
  }

  private async postWithTimeout(
    method: string,
    headers: Record<string, string>,
    params: unknown[]
  ): Promise<Response> {
    const controller = new AbortController();
    const request = this.fetchImpl(this.url, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.id++,
        method,
        params
      })
    });

    if (this.timeoutMs === 0) return request;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        request,
        new Promise<Response>((_, reject) => {
          timeout = setTimeout(() => {
            reject(
              new FiberRpcError(
                `Fiber RPC ${method} timed out after ${this.timeoutMs}ms. Check RPC URL, node process, network path, or timeout setting.`,
                { method }
              )
            );
            controller.abort();
          }, this.timeoutMs);
        })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

function validateRpcUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new FiberRpcError("Invalid Fiber RPC URL: value is empty.");

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new FiberRpcError(`Invalid Fiber RPC URL: ${trimmed}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new FiberRpcError("Invalid Fiber RPC URL: expected http or https.");
  }

  return trimmed;
}
