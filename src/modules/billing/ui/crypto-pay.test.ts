import { describe, expect, it } from "vitest";
import { classifyPayError } from "./pay-error";

describe("classifyPayError", () => {
  it("treats a closed wallet as a cancel, not a failed payment", () => {
    expect(classifyPayError({ code: 4001, message: "User rejected" })).toBe(
      "cancel",
    );
    expect(classifyPayError(new Error("wallet"))).toBe("wallet");
    expect(classifyPayError(new Error("network"))).toBe("network");
    expect(classifyPayError(new Error("token"))).toBe("token");
    expect(classifyPayError(new Error("order"))).toBe("failed");
  });
});
