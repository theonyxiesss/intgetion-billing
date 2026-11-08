import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { TRANSFER_TOPIC } from "@/lib/billing/verify-transfer";

/**
 * D380: the payment path with the sanctions list as a fixture. No network:
 * the chain read and the owner mail are mocked, the database is an in-memory
 * fake that answers the service's SQL.
 */

const dialect = new PgDialect();

const RECIPIENT = "0x1111111111111111111111111111111111111111";
const CLEAN_PAYER = "0x2222222222222222222222222222222222222222";
const LISTED_PAYER = "0x33333333333333333333333333333333333333aa";
const TOKEN = "0x4444444444444444444444444444444444444444";
const TX = `0x${"a".repeat(64)}`;
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const USER_ID = "00000000-0000-4000-8000-0000000000bb";

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
  order: null as Order | null,
  purchaseStatus: "pending",
  payments: [] as unknown[],
  sanctioned: new Set<string>(),
  statements: [] as string[],
};

function run(query: SQL) {
  const { sql: text, params } = dialect.sqlToQuery(query);
  const flat = text.replace(/\s+/g, " ").trim();
  state.statements.push(flat);
  if (flat.includes("from crypto_orders o"))
    return state.order ? [state.order] : [];
  if (flat.startsWith("select address from sanctioned_addresses")) {
    return state.sanctioned.has(String(params[0]))
      ? [{ address: params[0] }]
      : [];
  }
  if (flat.startsWith("update crypto_orders") && state.order) {
    if (flat.includes("status = 'confirmed'")) {
      state.order = {
        ...state.order,
        status: "confirmed",
        tx_hash: String(params[0]),
      };
    } else {
      state.order = {
        ...state.order,
        status: String(params[0]),
        reason: (params[1] as string | null) ?? null,
        tx_hash: (params[2] as string | null) ?? null,
      };
    }
    return [];
  }
  if (flat.startsWith("select id from payments")) return [];
  if (flat.startsWith("insert into payments")) {
    state.payments.push(params);
    return [];
  }
  if (flat.startsWith("update purchases")) {
    state.purchaseStatus = "paid";
    return [];
  }
  if (flat.startsWith("delete from sanctioned_addresses")) {
    state.sanctioned.clear();
    return [];
  }
  if (flat.startsWith("insert into sanctioned_addresses")) {
    for (let i = 0; i < params.length; i += 2)
      state.sanctioned.add(String(params[i]));
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

const notifyPlatformOwners = vi.fn(async () => {});
vi.mock("@/modules/admin-console/service", () => ({
  notifyPlatformOwners: (...args: unknown[]) =>
    (notifyPlatformOwners as (...a: unknown[]) => Promise<void>)(...args),
}));

vi.mock("@/modules/companies/service", () => ({ findMemberRole: vi.fn() }));

const { confirmHireOrder, refreshSanctionsList } =
  await import("../service/billing-service");

function topic(address: string) {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

function orderFor(payer: string): Order {
  const now = Date.now();
  return {
    id: ORDER_ID,
    purchase_id: "00000000-0000-4000-8000-0000000000cc",
    user_id: USER_ID,
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
  };
}

function goodTransferFrom(payer: string) {
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
  state.order = null;
  state.purchaseStatus = "pending";
  state.payments = [];
  state.sanctioned = new Set(["0x33333333333333333333333333333333333333aa"]);
  state.statements = [];
  readChain.mockReset();
  notifyPlatformOwners.mockClear();
});

describe("sanctions on the payment path (D380)", () => {
  it("a sender on the list freezes the order and grants no plan", async () => {
    state.order = orderFor(LISTED_PAYER);
    goodTransferFrom(LISTED_PAYER);
    const result = await confirmHireOrder(USER_ID, ORDER_ID, TX);
    expect(result.status).toBe("frozen");
    expect(result.plan).toBe("start");
    expect(result.granted).toBe(false);
    expect(state.order?.status).toBe("frozen");
    expect(state.order?.reason).toBe("sanctioned");
    expect(state.purchaseStatus).toBe("pending");
    expect(state.payments).toHaveLength(0);
    expect(
      state.statements.some((text) => text.startsWith("update purchases")),
    ).toBe(false);
    expect(notifyPlatformOwners).toHaveBeenCalledTimes(1);
  });

  it("matches the list in any letter case of the sender", async () => {
    const mixed = "0x33333333333333333333333333333333333333AA";
    state.order = orderFor(mixed);
    goodTransferFrom(mixed);
    const result = await confirmHireOrder(USER_ID, ORDER_ID, TX);
    expect(result.status).toBe("frozen");
  });

  it("does not alert the owner twice for an order already frozen", async () => {
    state.order = {
      ...orderFor(LISTED_PAYER),
      status: "frozen",
      reason: "sanctioned",
    };
    goodTransferFrom(LISTED_PAYER);
    await confirmHireOrder(USER_ID, ORDER_ID, TX);
    expect(notifyPlatformOwners).not.toHaveBeenCalled();
  });

  it("a clean sender goes the usual way: paid, payment row, purchase on", async () => {
    state.order = orderFor(CLEAN_PAYER);
    goodTransferFrom(CLEAN_PAYER);
    const result = await confirmHireOrder(USER_ID, ORDER_ID, TX);
    expect(result.status).toBe("paid");
    expect(result.plan).toBe("hire");
    expect(result.granted).toBe(true);
    expect(state.purchaseStatus).toBe("paid");
    expect(state.payments).toHaveLength(1);
    expect(notifyPlatformOwners).not.toHaveBeenCalled();
  });
});

describe("sanctions list refresh (D380)", () => {
  it("an empty download keeps the stored list", async () => {
    const result = await refreshSanctionsList(async () => "<html>down</html>");
    expect(result).toEqual({ stored: 0, replaced: false });
    expect(state.sanctioned.has(LISTED_PAYER)).toBe(true);
    expect(
      state.statements.some((text) =>
        text.startsWith("delete from sanctioned_addresses"),
      ),
    ).toBe(false);
  });

  it("a download with addresses replaces the list", async () => {
    const xml = `<sdnList><sdnEntry><lastName>FIXTURE</lastName><idList><id>
      <idType>Digital Currency Address - ETH</idType>
      <idNumber>0x5555555555555555555555555555555555555555</idNumber>
    </id></idList></sdnEntry></sdnList>`;
    const result = await refreshSanctionsList(async () => xml);
    expect(result).toEqual({ stored: 1, replaced: true });
    expect([...state.sanctioned]).toEqual([
      "0x5555555555555555555555555555555555555555",
    ]);
  });
});
