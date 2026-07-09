import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  FiberRpcClient,
  FixtureRpc,
  explainPayment,
  inspectChannels,
  inspectNodeStatus,
  probeRouteOptions,
  runInvoicePreflight,
  type FixtureScenario,
  type NodeStatusInput,
  type PreflightInput,
  type RouteProbeInput
} from "@fiber-preflight/core";

interface RpcConnectionBody {
  rpcUrl?: string;
  token?: string;
  fixture?: FixtureScenario;
}

interface CheckBody extends RpcConnectionBody, PreflightInput {}

interface ExplainBody extends RpcConnectionBody {
  paymentHash?: string;
}

interface ChannelsBody extends RpcConnectionBody {
  includeClosed?: boolean;
}

interface StatusBody extends RpcConnectionBody, NodeStatusInput {}

interface ProbeBody extends RpcConnectionBody, RouteProbeInput {}

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    sendJson(response, status, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(port, host, () => {
  console.log(`Fiber Preflight API listening on http://${host}:${port}`);
});

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  setCors(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      service: "fiber-preflight-api"
    });
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  if (url.pathname === "/api/preflight/check") {
    const body = await readJson<CheckBody>(request);
    const rpc = createRpc(body);
    const report = await runInvoicePreflight(rpc, {
      invoice: body.invoice,
      amount: body.amount,
      maxFeeAmount: body.maxFeeAmount,
      maxFeeRate: body.maxFeeRate,
      maxParts: body.maxParts,
      graphLimit: body.graphLimit,
      skipDryRun: body.skipDryRun
    });
    sendJson(response, 200, report);
    return;
  }

  if (url.pathname === "/api/preflight/explain") {
    const body = await readJson<ExplainBody>(request);
    if (!body.paymentHash) {
      sendJson(response, 400, { error: "paymentHash is required" });
      return;
    }
    const report = await explainPayment(createRpc(body), { paymentHash: body.paymentHash });
    sendJson(response, 200, report);
    return;
  }

  if (url.pathname === "/api/channels") {
    const body = await readJson<ChannelsBody>(request);
    const report = await inspectChannels(createRpc(body), { includeClosed: body.includeClosed });
    sendJson(response, 200, report);
    return;
  }

  if (url.pathname === "/api/status") {
    const body = await readJson<StatusBody>(request);
    const report = await inspectNodeStatus(createRpc(body), { sampleInvoice: body.sampleInvoice });
    sendJson(response, 200, report);
    return;
  }

  if (url.pathname === "/api/probes/route") {
    const body = await readJson<ProbeBody>(request);
    const report = await probeRouteOptions(createRpc(body), {
      invoice: body.invoice,
      amount: body.amount,
      maxFeeAmount: body.maxFeeAmount,
      maxFeeRate: body.maxFeeRate,
      maxParts: body.maxParts,
      feeRates: body.feeRates,
      partOptions: body.partOptions,
      stopOnFirstSuccess: body.stopOnFirstSuccess
    });
    sendJson(response, 200, report);
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

function createRpc(body: RpcConnectionBody) {
  if (body.fixture) return new FixtureRpc(body.fixture);
  if (!body.rpcUrl) throw new HttpError(400, "rpcUrl or fixture is required");
  return new FiberRpcClient({
    url: body.rpcUrl,
    token: body.token
  });
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {} as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  setCors(response);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(value, null, 2));
}

function setCors(response: ServerResponse): void {
  response.setHeader("access-control-allow-origin", process.env.CORS_ORIGIN ?? "*");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type,authorization");
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}
