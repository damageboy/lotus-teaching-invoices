import { RateTier, AppError } from "../types.js";

export function findRate(tiers: RateTier[], studentCount: number): number {
  for (const tier of tiers) {
    const inMin = studentCount >= tier.minStudents;
    const inMax = tier.maxStudents === null || studentCount <= tier.maxStudents;
    if (inMin && inMax) {
      return tier.rate;
    }
  }

  throw new AppError(
    `No matching rate tier for ${studentCount} students`,
    "NO_MATCHING_TIER",
  );
}
