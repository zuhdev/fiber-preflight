# Fiber Preflight API

The local API server exposes Fiber Preflight diagnostics over HTTP. It is useful for wallets, merchant backends, the web dashboard proxy mode, and fixture-based demos.

## Run

```powershell
pnpm dev:api
```

Default URL:

```txt
http://127.0.0.1:8787
```

Optional environment variables:

```powershell
$env:HOST="127.0.0.1"
$env:PORT="8787"
$env:CORS_ORIGIN="http://127.0.0.1:5175"
pnpm dev:api
```

## Endpoints

`GET /health`

Returns service health.

`POST /api/preflight/check`

Runs invoice preflight against a live Fiber node or a fixture.

```json
{
  "rpcUrl": "http://127.0.0.1:8227",
  "token": "optional-biscuit-token",
  "invoice": "fibt1...",
  "amount": "100000",
  "maxFeeRate": "50",
  "maxParts": "12"
}
```

`POST /api/preflight/explain`

Explains a payment by hash.

```json
{
  "rpcUrl": "http://127.0.0.1:8227",
  "token": "optional-biscuit-token",
  "paymentHash": "0x..."
}
```

`POST /api/channels`

Returns channel and liquidity inventory.

```json
{
  "rpcUrl": "http://127.0.0.1:8227",
  "token": "optional-biscuit-token",
  "includeClosed": false
}
```

All endpoints can also accept a `fixture` object instead of `rpcUrl` for offline demos.

`POST /api/status`

Tests safe read-only Fiber RPC capabilities.

```json
{
  "rpcUrl": "http://127.0.0.1:8227",
  "token": "optional-biscuit-token",
  "sampleInvoice": "optional-fibt1..."
}
```

## Export

The CLI can emit Markdown artifacts:

```powershell
pnpm cli -- check --fixture ../../fixtures/mpp-needed.json --markdown
pnpm cli -- channels --fixture ../../fixtures/payable-route.json --markdown
```

The web dashboard can download the current report as JSON or Markdown.
