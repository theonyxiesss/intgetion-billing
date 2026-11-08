import { describe, expect, it } from "vitest";
import { TRANSFER_TOPIC, verifyTransfer, tokenUnits } from "./verify-transfer";

const token = "0x1111111111111111111111111111111111111111";
const recipient = "0x2222222222222222222222222222222222222222";
const payer = "0x3333333333333333333333333333333333333333";
const amount = tokenUnits(BigInt(7900));
const created = 1_700_000_000;

function topic(address: string) {
  return `0x${"0".repeat(24)}${address.slice(2)}`;
}

function receipt(overrides?: {
  status?: string;
  contract?: string;
  from?: string;
  to?: string;
  value?: bigint;
}) {
  return {
    status: overrides?.status ?? "0x1",
    logs: [
      {
        address: overrides?.contract ?? token,
        topics: [
          TRANSFER_TOPIC,
          topic(overrides?.from ?? payer),
          topic(overrides?.to ?? recipient),
        ],
        data: `0x${(overrides?.value ?? amount).toString(16)}`,
      },
    ],
  };
}

function check(overrides: Partial<Parameters<typeof verifyTransfer>[0]> = {}) {
  return verifyTransfer({
    receipt: receipt(),
    blockTimestamp: created,
    confirmations: 12,
    requiredConfirmations: 12,
    tokenContract: token,
    recipient,
    payer,
    amount,
    orderCreatedAt: created,
    sanctioned: false,
    ...overrides,
  });
}

describe("verifyTransfer", () => {
  it("accepts an exact transfer and an overpayment", () => {
    expect(check().ok).toBe(true);
    const over = check({ receipt: receipt({ value: amount + BigInt(1) }) });
    expect(over.ok).toBe(true);
  });

  it("rejects each broken receipt on its own", () => {
    expect(check({ receipt: null })).toEqual({ ok: false, reason: "missing" });
    expect(check({ receipt: receipt({ status: "0x0" }) })).toEqual({
      ok: false,
      reason: "reverted",
    });
    expect(
      check({ receipt: receipt({ contract: "0x" + "ab".repeat(20) }) }),
    ).toEqual({ ok: false, reason: "no_transfer" });
    expect(check({ receipt: receipt({ to: "0x" + "44".repeat(20) }) })).toEqual(
      { ok: false, reason: "wrong_recipient" },
    );
    expect(
      check({ receipt: receipt({ from: "0x" + "55".repeat(20) }) }),
    ).toEqual({ ok: false, reason: "wrong_payer" });
    expect(check({ sanctioned: true })).toEqual({
      ok: false,
      reason: "sanctioned",
    });
    expect(check({ receipt: receipt({ value: amount - BigInt(1) }) })).toEqual({
      ok: false,
      reason: "underpaid",
    });
    expect(check({ blockTimestamp: created - 121 })).toEqual({
      ok: false,
      reason: "too_old",
    });
    expect(check({ confirmations: 11 })).toEqual({
      ok: false,
      reason: "confirmations",
    });
  });
});
