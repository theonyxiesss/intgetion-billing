import { describe, expect, it } from "vitest";
import { siweMessage } from "./siwe";

const base = {
  address: "0x1111111111111111111111111111111111111111",
  chainId: 8453,
  nonce: "abc",
  issuedAt: "2026-10-16T00:00:00.000Z",
  expirationTime: "2026-10-16T00:10:00.000Z",
};

describe("SIWE message (D354, D463)", () => {
  it("keeps the checkout line by default", () => {
    expect(siweMessage(base)).toContain("\nPay for INTGETION JOB LIST.\n");
  });

  it("says what a payout signature is for", () => {
    const text = siweMessage({ ...base, statement: "Confirm payouts." });
    expect(text).toContain("\nConfirm payouts.\n");
    expect(text).not.toContain("Pay for INTGETION JOB LIST.");
    expect(text).toContain("Chain ID: 8453");
  });
});
