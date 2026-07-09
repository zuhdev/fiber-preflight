import type { RpcLike } from "./types.js";

export interface FiberRpcClientOptions {
  url: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

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

export class FiberRpcClient implements RpcLike {
  private id = 1;
  private readonly fetchImpl: typeof fetch;
  private readonly url: string;
  private readonly token?: string;

  constructor(options: FiberRpcClientOptions) {
    this.url = options.url;
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
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
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: this.id++,
          method,
          params
        })
      });
    } catch (error) {
      throw new FiberRpcError(error instanceof Error ? error.message : "Failed to reach Fiber RPC", {
        method
      });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new FiberRpcError(`Fiber RPC returned non-JSON response (${response.status})`, {
        method
      });
    }

    const envelope = body as {
      result?: T;
      error?: { code?: number; message?: string; data?: unknown };
    };

    if (!response.ok || envelope.error) {
      const message = envelope.error?.message ?? `Fiber RPC HTTP ${response.status}`;
      throw new FiberRpcError(message, {
        code: envelope.error?.code,
        data: envelope.error?.data,
        method
      });
    }

    return envelope.result as T;
  }
}
