import { findRate } from '../../lib/invoice/calculator.js';
import { AppError, type ParsedClass, type StudioConfig } from '../../lib/types.js';

export function lessonExpectedAmount(lesson: ParsedClass, studio?: StudioConfig): number | null {
  if (
    lesson.studentCount <= 0 ||
    lesson.ambiguousStudentCount ||
    !Number.isSafeInteger(lesson.studentCount)
  ) {
    return null;
  }

  if (lesson.rateOverride !== undefined) return lesson.rateOverride;
  if (!studio) return null;

  try {
    return findRate(studio.rateTiers, lesson.studentCount);
  } catch (error) {
    if (error instanceof AppError && error.code === 'NO_MATCHING_TIER') return null;
    throw error;
  }
}

export function lessonNeedsConfiguration(lesson: ParsedClass, studio?: StudioConfig): boolean {
  return Boolean(lesson.unconfigured) || lessonExpectedAmount(lesson, studio) === null;
}
