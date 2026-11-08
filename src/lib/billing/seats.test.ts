import { describe, expect, it } from "vitest";
import { seatCap, START_SEATS, TEAM_SEATS } from "./seats";

describe("seatCap", () => {
  it("keeps Start and Hire at 2", () => {
    expect(seatCap(false)).toBe(START_SEATS);
    expect(seatCap(false)).toBe(2);
  });

  it("raises the company to 10 while Team is active", () => {
    expect(seatCap(true)).toBe(TEAM_SEATS);
    expect(seatCap(true)).toBe(10);
  });
});
