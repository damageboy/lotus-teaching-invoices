import { RateTier, ParsedClass, AppError } from "../types.js";

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

export interface StudioMonthStats {
  totalAmount: number;
  classCount: number;   // non-zero-student classes only
  avgPerClass: number;  // 0 when classCount is 0
}

export function computeStudioStats(
  classes: ParsedClass[],
  rateTiers: RateTier[],
): StudioMonthStats {
  let totalAmount = 0;
  let classCount = 0;
  for (const cls of classes) {
    if (cls.studentCount === 0) continue;
    totalAmount += findRate(rateTiers, cls.studentCount);
    classCount++;
  }
  return {
    totalAmount,
    classCount,
    avgPerClass: classCount === 0 ? 0 : totalAmount / classCount,
  };
}
