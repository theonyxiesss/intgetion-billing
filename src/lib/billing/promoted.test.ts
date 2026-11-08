import { describe, expect, it } from "vitest";
import { isHirePromoted } from "./status";

describe("Hire promoted window", () => {
  const now = new Date("2026-10-08T12:00:00.000Z");

  it("stays on for 7 days and then drops", () => {
    expect(isHirePromoted(new Date("2026-10-08T12:00:00.000Z"), now)).toBe(
      true,
    );
    expect(isHirePromoted(new Date("2026-10-01T12:00:01.000Z"), now)).toBe(
      true,
    );
    expect(isHirePromoted(new Date("2026-10-01T12:00:00.000Z"), now)).toBe(
      false,
    );
    expect(isHirePromoted(new Date("2026-10-09T12:00:00.000Z"), now)).toBe(
      false,
    );
  });
});
