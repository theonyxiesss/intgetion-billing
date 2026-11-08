# @intgetion/billing

Crypto payments for INTGETION JOB LIST: wallet checkout, transfer verification, sanctions screening, escrow helpers.

- `@intgetion/billing` — service (`src/modules/billing/service`)
- `@intgetion/billing/engine` — chains, RPC, transfer checks, SIWE, sanctions, escrow (`src/lib/billing`)
- `@intgetion/billing/ports` — `setBillingPorts()` for platform-owned functions (admin notify, company membership)

Shared helpers come from `@intgetion/kit`.

Checkout UI stays in the platform for now; it is not part of this package.

Integration tests need `DATABASE_URL` and run in CI.
