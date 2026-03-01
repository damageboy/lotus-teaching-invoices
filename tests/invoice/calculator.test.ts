import { describe, it, expect } from "vitest";
import { findRate, computeStudioStats } from "../../src/lib/invoice/calculator.js";
import { RateTier, ParsedClass } from "../../src/lib/types.js";

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

const classFixtures: ParsedClass[] = [
  { studioName: "Zen Yoga", classType: "Vinyasa", date: "2026-01-03", startTime: "09:00", endTime: "10:15", studentCount: 8 },   // → 100
  { studioName: "Zen Yoga", classType: "Yin",     date: "2026-01-05", startTime: "18:00", endTime: "19:15", studentCount: 3 },   // → 80
  { studioName: "Zen Yoga", classType: "Vinyasa", date: "2026-01-10", startTime: "09:00", endTime: "10:15", studentCount: 12 },  // → 120
];

describe("computeStudioStats", () => {
  it("sums rates and counts classes", () => {
    const stats = computeStudioStats(classFixtures, tiers);
    expect(stats.totalAmount).toBe(300); // 100 + 80 + 120
    expect(stats.classCount).toBe(3);
  });

  it("computes correct average", () => {
    const stats = computeStudioStats(classFixtures, tiers);
    expect(stats.avgPerClass).toBeCloseTo(100); // 300 / 3
  });

  it("skips zero-student classes", () => {
    const withZero: ParsedClass[] = [
      ...classFixtures,
      { studioName: "Zen Yoga", classType: "Hatha", date: "2026-01-12", startTime: "09:00", endTime: "10:15", studentCount: 0 },
    ];
    const stats = computeStudioStats(withZero, tiers);
    expect(stats.totalAmount).toBe(300);
    expect(stats.classCount).toBe(3);
  });

  it("returns zeros for empty input", () => {
    const stats = computeStudioStats([], tiers);
    expect(stats.totalAmount).toBe(0);
    expect(stats.classCount).toBe(0);
    expect(stats.avgPerClass).toBe(0);
  });
});
