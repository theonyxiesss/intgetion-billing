import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { TRANSFER_TOPIC } from "@/lib/billing/verify-transfer";

/**
 * D589 (SEC-20261014-2) against the real indexes of 0086: another order holding
 * the payer's hash does not block the payer, and one transfer counts once.
 * Only the chain read is mocked.
 */

const readChain = vi.fn();
vi.mock("@/lib/billing/rpc", () => ({
  readChain: (...args: unknown[]) => readChain(...args),
}));

const { confirmHireOrder } = await import("./service");

const RECIPIENT = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const SQUATTER = "0x3333333333333333333333333333333333333333";
const TOKEN = "0x4444444444444444444444444444444444444444";
function randomHash() {
  return `0x${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
}
const TX = randomHash();

const payerUser = randomUUID();
const squatterUser = randomUUID();
const purchaseIds: string[] = [];

async function openOrder(userId: string, payer: string): Promise<string> {
  const db = getDb();
  const purchase = await db.execute<{ id: string }>(sql`
    insert into public.purchases (user_id, plan_code, status)
    values (${userId}, 'candidate_plus', 'pending')
    returning id
  `);
  const purchaseId = purchase[0]?.id;
  if (!purchaseId) throw new Error("purchase fixture");
  purchaseIds.push(purchaseId);
  const order = await db.execute<{ id: string }>(sql`
    insert into public.crypto_orders (
      purchase_id, user_id, chain, token, token_contract, recipient,
      payer_address, amount_minor, token_amount, status, expires_at, created_at
    )
    values (
      ${purchaseId}, ${userId}, 'base', 'USDC', ${TOKEN}, ${RECIPIENT},
      ${payer}, 500, '5000000', 'open', now() + interval '30 minutes',
      now() - interval '1 minute'
    )
    returning id
  `);
  const orderId = order[0]?.id;
  if (!orderId) throw new Error("order fixture");
  return orderId;
}

async function orderRow(orderId: string) {
  const rows = await getDb().execute<{
    status: string;
    reason: string | null;
    tx_hash: string | null;
  }>(
    sql`select status, reason, tx_hash from public.crypto_orders where id = ${orderId}`,
  );
  return rows[0];
}

async function paymentsForTx() {
  const rows = await getDb().execute<{ count: number }>(sql`
    select count(*)::int as count from public.payments
    where chain = 'base' and tx_hash = ${TX}
  `);
  return rows[0]?.count ?? 0;
}

function topic(address: string) {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

function pendingTransfer() {
  readChain.mockResolvedValue({
    receipt: null,
    blockTimestamp: null,
    confirmations: 0,
  });
}

function minedTransferFrom(payer: string) {
  readChain.mockResolvedValue({
    receipt: {
      status: "0x1",
      logs: [
        {
          address: TOKEN,
          topics: [TRANSFER_TOPIC, topic(payer), topic(RECIPIENT)],
          data: `0x${BigInt(5000000).toString(16)}`,
        },
      ],
    },
    blockTimestamp: Math.floor(Date.now() / 1000),
    confirmations: 20,
  });
}

beforeAll(async () => {
  await getDb().execute(sql`
    insert into public.users (id, auth_uid, terms_accepted_at, terms_version)
    values (${payerUser}, ${randomUUID()}, now(), 'test'),
           (${squatterUser}, ${randomUUID()}, now(), 'test')
  `);
});

afterAll(async () => {
  const db = getDb();
  if (purchaseIds.length) {
    const ids = sql.join(
      purchaseIds.map((id) => sql`${id}`),
      sql`, `,
    );
    await db.execute(sql`delete from public.purchases where id in (${ids})`);
  }
  await db.execute(
    sql`delete from public.users where id in (${payerUser}, ${squatterUser})`,
  );
});

describe("transaction hash held by another order (D589)", () => {
  it("the payer is confirmed after a squatter submitted the hash first", async () => {
    const squatOrder = await openOrder(squatterUser, SQUATTER);
    const payerOrder = await openOrder(payerUser, PAYER);

    pendingTransfer();
    await confirmHireOrder(squatterUser, squatOrder, TX);
    expect(await orderRow(squatOrder)).toMatchObject({
      status: "submitted",
      tx_hash: TX,
    });

    minedTransferFrom(PAYER);
    const paid = await confirmHireOrder(payerUser, payerOrder, TX);
    expect(paid.granted).toBe(true);
    expect(paid.status).toBe("paid");
    expect(await paymentsForTx()).toBe(1);

    await confirmHireOrder(squatterUser, squatOrder, TX);
    expect(await orderRow(squatOrder)).toMatchObject({
      status: "failed",
      reason: "wrong_payer",
      tx_hash: null,
    });
  });

  it("the same transfer is not counted for a second order", async () => {
    const secondOrder = await openOrder(payerUser, PAYER);
    minedTransferFrom(PAYER);
    await expect(
      confirmHireOrder(payerUser, secondOrder, TX),
    ).rejects.toMatchObject({ status: 409, code: "HASH_USED" });
    expect((await orderRow(secondOrder))?.status).toBe("open");
    expect(await paymentsForTx()).toBe(1);
  });

  it("two confirmed orders cannot share a hash; other statuses can", async () => {
    const one = await openOrder(payerUser, PAYER);
    const two = await openOrder(payerUser, PAYER);
    const hash = randomHash();
    const db = getDb();
    await db.execute(sql`
      update public.crypto_orders set status = 'submitted', tx_hash = ${hash}
      where id in (${one}, ${two})
    `);
    await db.execute(sql`
      update public.crypto_orders set status = 'confirmed' where id = ${one}
    `);
    await expect(
      db.execute(sql`
        update public.crypto_orders set status = 'confirmed' where id = ${two}
      `),
    ).rejects.toThrow();
  });
});
