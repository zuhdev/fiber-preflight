# Fiber Preflight

Payment readiness and route diagnostics for the Fiber Network.

## Packages

- `packages/core`: JSON-RPC client, report schema, preflight checks, failure classifier.
- `apps/cli`: command line interface for invoice checks and payment postmortems.
- `apps/web`: browser dashboard for live RPC or demo fixtures.
- `apps/api`: local HTTP API for wallets, merchant services, and web proxy mode.
- `fixtures`: canned scenarios for judging and offline demos.

## Quick Start

```powershell
pnpm install
pnpm build
pnpm fixture:payable
pnpm dev:api
pnpm dev:web
```

## CLI Examples

```powershell
pnpm cli -- check --rpc http://127.0.0.1:8227 --invoice fibt1...
pnpm cli -- check --fixture ../../fixtures/expired-invoice.json
pnpm cli -- explain --rpc http://127.0.0.1:8227 --payment-hash 0x...
pnpm cli -- channels --rpc http://127.0.0.1:8227
pnpm cli -- status --rpc http://127.0.0.1:8227
pnpm cli -- check --fixture ../../fixtures/mpp-needed.json --markdown
```

## API

Run the local API server:

```powershell
pnpm dev:api
```

See [docs/api.md](docs/api.md) for endpoint details.
