# Demo Script

This script is tuned for a short hackathon judging slot. It demonstrates the problem, the product, and the most differentiated feature: turning Fiber route failures into exact retry settings and an operator runbook.

## Setup

```powershell
pnpm install
pnpm dev:web
```

Optional second terminal:

```powershell
pnpm dev:api
```

Open the web dashboard at the Vite URL, usually:

```txt
http://127.0.0.1:5173
```

## One-Minute Pitch

Fiber Preflight is a route doctor for Fiber payments. Before a wallet sends funds, it checks invoice expiry, local liquidity, graph visibility, fee policy, and dry-run route construction. When a payment cannot use the default settings, Probe Lab sweeps safe dry-runs and returns the best fee and MPP part settings plus an operator runbook.

## Main Demo: MPP Needed

1. In the web dashboard, keep source on `Demo`.
2. Select `MPP needed`.
3. Click `Run story`.
4. Point out the story card:
   - Problem: no single channel can carry the full amount.
   - Diagnosis: Probe Lab finds a working MPP route.
   - Fix: retry with the best passing setting.
5. Show the summary:
   - Verdict is `risky`, not blindly blocked.
   - Best setting recommends exact fee and part parameters.
6. Show the route graph:
   - `Part 1` and `Part 2` split the payment.
   - Each path lists hop amounts and channel outpoints.
7. Show the runbook:
   - Wallet action is ready.
   - Params include `dry_run=true`, `max_fee_rate`, and `max_parts`.

CLI equivalent:

```powershell
pnpm fixture:probe
```

## Second Demo: Failed Payment Postmortem

1. Select `Failed payment postmortem`.
2. Click `Run story`.
3. Show that the app switches to explain mode.
4. Point out:
   - The failed payment hash is inspected.
   - The failure is classified as a temporary channel failure.
   - Current channel state and pending TLCs are included as evidence.
   - The runbook recommends retrying with alternate routing or waiting for settlement.

CLI equivalent:

```powershell
pnpm fixture:postmortem
```

## Fast Fixture Tour

```powershell
pnpm fixture:payable
pnpm cli -- check --fixture ../../fixtures/expired-invoice.json
pnpm cli -- check --fixture ../../fixtures/insufficient-liquidity.json
pnpm cli -- check --fixture ../../fixtures/fee-too-low.json
pnpm fixture:mpp
```

## Judge Talking Points

- The project is not just a dashboard. The core is reusable by wallets, merchant services, APIs, and CLIs.
- The route checks are safe because they use dry-runs.
- The MPP probe turns a vague "route failed" into actionable retry parameters.
- The runbook assigns next actions to wallet, operator, merchant, or network roles.
- Offline fixtures make the demo deterministic, and CI locks those scenarios down.

## What To Show In The Repo

```powershell
pnpm test
pnpm check
pnpm build
```

Then show:

- [README.md](../README.md)
- [docs/api.md](api.md)
- [docs/architecture.md](architecture.md)
- [tests/fixture-regression.test.ts](../tests/fixture-regression.test.ts)
