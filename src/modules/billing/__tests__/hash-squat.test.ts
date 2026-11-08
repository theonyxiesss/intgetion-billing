import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { TRANSFER_TOPIC } from "@/lib/billing/verify-transfer";

/**
 * D589 (SEC-20261014-2): another order that holds the payer's transaction hash
 * must not block the payer, and one transfer still counts once. The database is
 * an in-memory fake with the indexes of 0086: (chain, tx_hash) is unique among
 * confirmed orders and in payments. The real index runs in
 * billing-hash.integration.test.ts.
 */

const dialect = new PgDialect();

const RECIPIENT = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const SQUATTER = "0x3333333333333333333333333333333333333333";
const TOKEN = "0x4444444444444444444444444444444444444444";
const TX = `0x${"b".repeat(64)}`;
const PAYER_USER = "00000000-0000-4000-8000-0000000000a1";
const SQUATTER_USER = "00000000-0000-4000-8000-0000000000a2";
const PAYER_ORDER = "00000000-0000-4000-8000-0000000000b1";
const SECOND_ORDER = "00000000-0000-4000-8000-0000000000b2";
const SQUATTER_ORDER = "00000000-0000-4000-8000-0000000000b3";

type Order = {
  id: string;
  purchase_id: string;
  user_id: string;
  job_id: string | null;
  company_id: string | null;
  plan_code: string;
  chain: string;
  token: string;
  token_contract: string;
  recipient: string;
  payer_address: string;
  amount_minor: string;
  token_amount: string;
  status: string;
  reason: string | null;
  tx_hash: string | null;
  expires_at: string;
  created_at: string;
};

const state = {
  orders: new Map<string, Order>(),
  purchases: new Map<string, string>(),
  payments: [] as { chain: string; tx_hash: string }[],
};

function uniqueViolation(): Error {
  return Object.assign(new Error("duplicate key value"), { code: "23505" });
}

function setOrder(id: string, patch: Partial<Order>) {
  const order = state.orders.get(id);
  if (!order || order.status === "confirmed") return;
  const next = { ...order, ...patch };
  const taken = [...state.orders.values()].some(
    (other) =>
      other.id !== id &&
      other.status === "confirmed" &&
      next.status === "confirmed" &&
      other.chain === next.chain &&
      other.tx_hash === next.tx_hash,
  );
  if (taken) throw uniqueViolation();
  state.orders.set(id, next);
}

function run(query: SQL) {
  const { sql: text, params } = dialect.sqlToQuery(query);
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.includes("from crypto_orders o")) {
    const order = state.orders.get(String(params[0]));
    return order && order.user_id === params[1] ? [order] : [];
  }
  if (flat.startsWith("select address from sanctioned_addresses")) return [];
  if (flat.startsWith("update crypto_orders")) {
    if (flat.includes("status = 'confirmed'")) {
      setOrder(String(params[1]), {
        status: "confirmed",
        reason: null,
        tx_hash: String(params[0]),
      });
    } else {
      setOrder(String(params[3]), {
        status: String(params[0]),
        reason: (params[1] as string | null) ?? null,
        tx_hash: (params[2] as string | null) ?? null,
      });
    }
    return [];
  }
  if (flat.startsWith("select id from payments")) {
    return state.payments
      .filter((row) => row.chain === params[0] && row.tx_hash === params[1])
      .map(() => ({ id: "payment" }));
  }
  if (flat.startsWith("insert into payments")) {
    const row = { chain: String(params[2]), tx_hash: String(params[4]) };
    if (
      state.payments.some(
        (other) => other.chain === row.chain && other.tx_hash === row.tx_hash,
      )
    ) {
      throw uniqueViolation();
    }
    state.payments.push(row);
    return [];
  }
  if (flat.startsWith("update purchases")) {
    state.purchases.set(String(params[1]), "paid");
    return [];
  }
  throw new Error(`unexpected SQL in test: ${flat}`);
}

const db = {
  execute: vi.fn(async (query: SQL) => run(query)),
  transaction: vi.fn(async (work: (tx: typeof db) => Promise<unknown>) =>
    work(db),
  ),
};

vi.mock("@/db/client", () => ({ getDb: () => db }));

const readChain = vi.fn();
vi.mock("@/lib/billing/rpc", () => ({
  readChain: (...args: unknown[]) => readChain(...args),
}));

vi.mock("@/modules/admin-console/service", () => ({
  notifyPlatformOwners: vi.fn(async () => {}),
}));

vi.mock("@/modules/companies/service", () => ({ findMemberRole: vi.fn() }));

const { confirmHireOrder } = await import("../service/billing-service");

function topic(address: string) {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

function addOrder(id: string, userId: string, payer: string) {
  const now = Date.now();
  const purchaseId = `purchase-${id}`;
  state.purchases.set(purchaseId, "pending");
  state.orders.set(id, {
    id,
    purchase_id: purchaseId,
    user_id: userId,
    job_id: "00000000-0000-4000-8000-0000000000dd",
    company_id: "00000000-0000-4000-8000-0000000000ee",
    plan_code: "company_hire",
    chain: "base",
    token: "USDC",
    token_contract: TOKEN,
    recipient: RECIPIENT,
    payer_address: payer,
    amount_minor: "7900",
    token_amount: "79000000",
    status: "open",
    reason: null,
    tx_hash: null,
    expires_at: new Date(now + 30 * 60 * 1000).toISOString(),
    created_at: new Date(now - 60 * 1000).toISOString(),
  });
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
          data: `0x${BigInt(79000000).toString(16)}`,
        },
      ],
    },
    blockTimestamp: Math.floor(Date.now() / 1000),
    confirmations: 20,
  });
}

beforeEach(() => {
  state.orders = new Map();
  state.purchases = new Map();
  state.payments = [];
  readChain.mockReset();
  addOrder(PAYER_ORDER, PAYER_USER, PAYER);
  addOrder(SQUATTER_ORDER, SQUATTER_USER, SQUATTER);
});

describe("someone else's order holding the hash (D589)", () => {
  it("a hash taken from the mempool does not block the payer", async () => {
    pendingTransfer();
    const squat = await confirmHireOrder(SQUATTER_USER, SQUATTER_ORDER, TX);
    expect(squat.granted).toBe(false);
    expect(state.orders.get(SQUATTER_ORDER)?.status).toBe("submitted");

    minedTransferFrom(PAYER);
    const paid = await confirmHireOrder(PAYER_USER, PAYER_ORDER, TX);
    expect(paid.status).toBe("paid");
    expect(paid.granted).toBe(true);
    expect(state.purchases.get(`purchase-${PAYER_ORDER}`)).toBe("paid");
    expect(state.payments).toHaveLength(1);
  });

  it("the squatting order fails on recheck, keeps no hash and gets no plan", async () => {
    pendingTransfer();
    await confirmHireOrder(SQUATTER_USER, SQUATTER_ORDER, TX);
    minedTransferFrom(PAYER);
    await confirmHireOrder(PAYER_USER, PAYER_ORDER, TX);

    const squat = await confirmHireOrder(SQUATTER_USER, SQUATTER_ORDER, TX);
    expect(squat.granted).toBe(false);
    expect(state.orders.get(SQUATTER_ORDER)).toMatchObject({
      status: "failed",
      reason: "wrong_payer",
      tx_hash: null,
    });
    expect(state.purchases.get(`purchase-${SQUATTER_ORDER}`)).toBe("pending");
    expect(state.payments).toHaveLength(1);
  });

  it("a hash submitted after it was mined fails the squatter first, payer still paid", async () => {
    minedTransferFrom(PAYER);
    const squat = await confirmHireOrder(SQUATTER_USER, SQUATTER_ORDER, TX);
    expect(squat.status).not.toBe("paid");
    expect(state.orders.get(SQUATTER_ORDER)?.tx_hash).toBeNull();

    const paid = await confirmHireOrder(PAYER_USER, PAYER_ORDER, TX);
    expect(paid.granted).toBe(true);
  });
});

describe("one transfer counts once (D589)", () => {
  beforeEach(() => addOrder(SECOND_ORDER, PAYER_USER, PAYER));

  it("a second order of the same payer gets HASH_USED", async () => {
    minedTransferFrom(PAYER);
    await confirmHireOrder(PAYER_USER, PAYER_ORDER, TX);
    await expect(
      confirmHireOrder(PAYER_USER, SECOND_ORDER, TX),
    ).rejects.toMatchObject({ status: 409, code: "HASH_USED" });
    expect(state.orders.get(SECOND_ORDER)?.status).toBe("open");
    expect(state.purchases.get(`purchase-${SECOND_ORDER}`)).toBe("pending");
    expect(state.payments).toHaveLength(1);
  });

  it("the confirmed-order index refuses the hash even without a payment row", async () => {
    minedTransferFrom(PAYER);
    const first = state.orders.get(PAYER_ORDER);
    if (!first) throw new Error("fixture");
    state.orders.set(PAYER_ORDER, {
      ...first,
      status: "confirmed",
      tx_hash: TX,
    });
    await expect(
      confirmHireOrder(PAYER_USER, SECOND_ORDER, TX),
    ).rejects.toMatchObject({ status: 409, code: "HASH_USED" });
    expect(state.orders.get(SECOND_ORDER)?.status).toBe("open");
  });
});
