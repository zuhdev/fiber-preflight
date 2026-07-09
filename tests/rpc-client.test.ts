import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_RPC_TIMEOUT_MS,
  FiberRpcClient,
  FiberRpcError,
  normalizeRpcTimeoutMs
} from "../packages/core/src/index.js";

describe("FiberRpcClient", () => {
  test("posts JSON-RPC requests with auth and timeout signal", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ input: String(input), init });
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    };
    const rpc = new FiberRpcClient({
      url: "http://127.0.0.1:8227",
      token: "secret",
      fetchImpl,
      timeoutMs: 5_000
    });

    assert.deepEqual(await rpc.call("node_info", []), { ok: true });
    assert.equal(calls[0]?.input, "http://127.0.0.1:8227");
    assert.equal(calls[0]?.init?.method, "POST");
    assert.equal((calls[0]?.init?.headers as Record<string, string>).authorization, "Bearer secret");
    assert.ok(calls[0]?.init?.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      jsonrpc: "2.0",
      id: 1,
      method: "node_info",
      params: []
    });
  });

  test("times out stalled requests with method context", async () => {
    const fetchImpl: typeof fetch = () => new Promise<Response>(() => {});
    const rpc = new FiberRpcClient({
      url: "http://127.0.0.1:8227",
      fetchImpl,
      timeoutMs: 10
    });

    await assert.rejects(
      () => rpc.call("node_info"),
      (error) => {
        assert.ok(error instanceof FiberRpcError);
        assert.equal(error.method, "node_info");
        assert.match(error.message, /node_info timed out after 10ms/);
        return true;
      }
    );
  });

  test("keeps JSON-RPC error code, data, and classifier-friendly message", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32000,
          message: "FeeInsufficient",
          data: { needed: "0x10" }
        }
      });
    const rpc = new FiberRpcClient({ url: "http://127.0.0.1:8227", fetchImpl });

    await assert.rejects(
      () => rpc.call("send_payment", [{ dry_run: true }]),
      (error) => {
        assert.ok(error instanceof FiberRpcError);
        assert.equal(error.method, "send_payment");
        assert.equal(error.code, -32000);
        assert.deepEqual(error.data, { needed: "0x10" });
        assert.match(error.message, /send_payment failed: FeeInsufficient/);
        return true;
      }
    );
  });

  test("rejects non-JSON responses with HTTP status", async () => {
    const fetchImpl: typeof fetch = async () => new Response("<html>bad gateway</html>", { status: 502 });
    const rpc = new FiberRpcClient({ url: "http://127.0.0.1:8227", fetchImpl });

    await assert.rejects(
      () => rpc.call("list_channels"),
      (error) => {
        assert.ok(error instanceof FiberRpcError);
        assert.match(error.message, /list_channels returned non-JSON response \(HTTP 502\)/);
        return true;
      }
    );
  });

  test("validates endpoint URLs and timeout values", () => {
    assert.equal(normalizeRpcTimeoutMs(undefined), DEFAULT_RPC_TIMEOUT_MS);
    assert.equal(normalizeRpcTimeoutMs("2500"), 2_500);
    assert.equal(normalizeRpcTimeoutMs(0), 0);
    assert.throws(() => normalizeRpcTimeoutMs("soon"), /Invalid Fiber RPC timeout/);
    assert.throws(() => new FiberRpcClient({ url: "not-a-url" }), /Invalid Fiber RPC URL/);
    assert.throws(() => new FiberRpcClient({ url: "fiber://127.0.0.1" }), /expected http or https/);
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}
