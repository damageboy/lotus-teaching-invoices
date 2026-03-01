import { describe, it, expect } from "vitest";
import { findRate } from "../../src/lib/invoice/calculator.js";
import { RateTier } from "../../src/lib/types.js";

const tiers: RateTier[] = [
  { minStudents: 1, maxStudents: 5, rate: 80 },
  { minStudents: 6, maxStudents: 10, rate: 100 },
  { minStudents: 11, maxStudents: null, rate: 120 },
];

describe("findRate", () => {
  it("returns rate for lowest tier", () => {
    expect(findRate(tiers, 1)).toBe(80);
    expect(findRate(tiers, 3)).toBe(80);
    expect(findRate(tiers, 5)).toBe(80);
  });

  it("returns rate for middle tier", () => {
    expect(findRate(tiers, 6)).toBe(100);
    expect(findRate(tiers, 8)).toBe(100);
    expect(findRate(tiers, 10)).toBe(100);
  });

  it("returns rate for unbounded tier", () => {
    expect(findRate(tiers, 11)).toBe(120);
    expect(findRate(tiers, 50)).toBe(120);
    expect(findRate(tiers, 100)).toBe(120);
  });

  it("throws for 0 students (below all tiers)", () => {
    expect(() => findRate(tiers, 0)).toThrow("No matching rate tier");
  });
});
