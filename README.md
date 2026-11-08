# INTGETION Billing Service

Standalone crypto-payment service for INTGETION JOB LIST: wallet checkout (USDT/USDC on EVM), on-chain transfer verification, SIWE wallet proof, OFAC sanctions screening, hire/team/plan purchases.

Runs as its own HTTP process with its own tables and migrations. The platform is not wired to it yet; it is developed separately.

## Run

```bash
npm install
cp .env.example .env   # fill in values
npm run migrate        # billing tables only
npm run dev            # http://localhost:4010
```

Checks: `npm run typecheck`, `npm test` (integration tests need `DATABASE_URL`).
Docker: `docker build -t intgetion-billing .` then run with the env from `.env.example`.

## How callers talk to it

Every request except `GET /health` needs `Authorization: Bearer <BILLING_SERVICE_TOKEN>`.

The caller (the platform) signs the person in and forwards who they are:

| Header | Meaning |
|---|---|
| `x-user-id` | user UUID (required on account routes) |
| `x-user-email` | email for the receipt after a hire payment |
| `x-user-locale` | `en`, `ru`, `es`, `pt-BR`, `de`, `fr`, `it` |

Rate limiting is the caller's job. Errors are `{ "error": { "code", "message", "details?" } }`.

## API

| Method | Path | User | Returns |
|---|---|---|---|
| GET | `/health` | — | `{ ok }` |
| GET | `/v1/features` | — | checkout on/off, hire grants |
| GET | `/v1/me` | yes | plans of the person and their companies |
| GET | `/v1/payable` | yes | jobs and companies the person can pay for |
| GET | `/v1/companies/:id` | yes (member) | company plan |
| GET | `/v1/companies/:id/active-team` | — | `{ active }` |
| GET | `/v1/jobs/:id/hire` | — | `{ paid }` |
| GET | `/v1/promoted-jobs` | — | `{ jobIds }` |
| POST | `/v1/interest` | optional | record interest `{ email?, token?, chain? }` |
| POST | `/v1/orders` | yes | create order `{ plan, token, jobId?, companyId? }` |
| GET | `/v1/orders/:id` | yes | order status, rechecks the chain |
| POST | `/v1/orders/confirm` | yes | `{ orderId, txHash }` → verifies transfer, grants plan |
| POST | `/v1/wallet/nonce` | yes | SIWE message `{ address, chainId }` or `{ network, address }` |
| POST | `/v1/wallet/verify` | yes | `{ signature }` |
| GET | `/v1/wallet` | yes | verified payer wallet |
| GET | `/v1/sanctions/check?address=` | — | `{ sanctioned }` |
| POST | `/v1/jobs/recheck-orders` | — | scheduler: every minute |
| POST | `/v1/jobs/refresh-sanctions` | — | scheduler: daily 02:40 UTC |

## What the platform must answer (callbacks)

Billing calls `PLATFORM_URL` with `Authorization: Bearer <PLATFORM_CALLBACK_TOKEN>`:

| Method | Path | Body / query | Answer |
|---|---|---|---|
| POST | `/api/internal/billing/notify-owners` | `{ subject, text }` | 2xx |
| GET | `/api/internal/billing/member-role` | `?companyId&userId` | `{ role: "owner" \| "member" \| null }` |

## Data

Tables owned by billing: `plans`, `purchases`, `payments`, `crypto_orders`, `billing_wallet_sessions`, `billing_interest`, `sanctioned_addresses`. Migrations in `migrations/`, applied by `npm run migrate` and tracked in `billing_schema_migrations`.

Billing runs against the same Postgres as the platform and reads platform tables `users`, `companies`, `company_members`, `jobs` (read-only), and needs the platform helper `public.enable_rls_deny_all` and roles `app_rw`, `anon`, `authenticated`. CI creates stand-ins from `test/sql/platform-stub.sql`.

## Packages inside

- `.` — service functions (`src/modules/billing/service`)
- `./engine` — chains, RPC, transfer checks, SIWE, sanctions, escrow (`src/lib/billing`)
- `./ports` — `setBillingPorts()`
- `./server` — `createApp()` HTTP handler

Shared helpers come from `@intgetion/kit` (git tag). Checkout UI stays in the platform.
