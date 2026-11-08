import { describe, expect, it } from "vitest";
import { PRICING } from "@/config/pricing";
import { clientStatus, SALE_PLANS, salePlan, settlement } from "./status";

const now = new Date("2026-10-08T12:00:00Z");
const later = new Date("2026-10-08T12:30:00Z");

describe("clientStatus", () => {
  it("shows Start until the server has confirmed the transfer", () => {
    expect(
      clientStatus({
        status: "open",
        reason: null,
        expiresAt: later,
        now,
      }),
    ).toBe("awaiting_payment");
    expect(
      clientStatus({
        status: "submitted",
        reason: null,
        expiresAt: later,
        now,
      }),
    ).toBe("checking");
    expect(
      clientStatus({
        status: "confirmed",
        reason: null,
        expiresAt: later,
        now,
      }),
    ).toBe("paid");
  });

  it("does not treat an underpaid or expired order as paid", () => {
    expect(
      clientStatus({
        status: "submitted",
        reason: "underpaid",
        expiresAt: later,
        now,
      }),
    ).toBe("underpaid");
    expect(
      clientStatus({
        status: "open",
        reason: null,
        expiresAt: now,
        now,
      }),
    ).toBe("expired");
  });
});

describe("sale plans", () => {
  it("charges the monthly card price, not a yearly total", () => {
    const dollars = (audience: "companies" | "candidates", code: string) =>
      PRICING[audience].find((tier) => tier.code === code)?.price ?? null;
    expect(SALE_PLANS.hire.priceMinor).toBe(
      BigInt((dollars("companies", "hire") ?? 0) * 100),
    );
    expect(SALE_PLANS.team.priceMinor).toBe(
      BigInt((dollars("companies", "team") ?? 0) * 100),
    );
    expect(SALE_PLANS.plus.priceMinor).toBe(
      BigInt((dollars("candidates", "plus") ?? 0) * 100),
    );
    expect(SALE_PLANS.pro.priceMinor).toBe(
      BigInt((dollars("candidates", "pro") ?? 0) * 100),
    );
    expect(salePlan("start")).toBeNull();
    expect(salePlan("team")?.code).toBe("company_team");
  });
});

describe("settlement", () => {
  it("grants Hire only when the transfer checks out", () => {
    expect(settlement({ ok: true, value: BigInt(1) })).toEqual({
      status: "confirmed",
      reason: null,
      grant: true,
    });
    expect(settlement({ ok: false, reason: "underpaid" }).grant).toBe(false);
    expect(settlement({ ok: false, reason: "no_transfer" }).grant).toBe(false);
    expect(settlement({ ok: false, reason: "sanctioned" })).toMatchObject({
      status: "frozen",
      grant: false,
    });
    expect(settlement({ ok: false, reason: "confirmations" })).toMatchObject({
      status: "submitted",
      grant: false,
    });
  });
});
