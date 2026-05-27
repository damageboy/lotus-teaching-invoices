import { RateTier } from '../types.js';

export interface RateTierFieldErrors {
  minStudents?: string;
  maxStudents?: string;
  rate?: string;
}

export interface RateTierValidation {
  isValid: boolean;
  tierErrors: RateTierFieldErrors[];
}

function isValidInteger(value: number): boolean {
  return Number.isInteger(value);
}

function isValidNumber(value: number): boolean {
  return Number.isFinite(value);
}

export function getRateTierValidation(tiers: RateTier[]): RateTierValidation {
  const tierErrors = tiers.map(() => ({}) as RateTierFieldErrors);

  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    const isFirst = i === 0;
    const isLast = i === tiers.length - 1;

    if (!isValidInteger(tier.minStudents)) {
      tierErrors[i].minStudents = 'Min students is required';
    } else if (tier.minStudents < 1) {
      tierErrors[i].minStudents = 'Min students must be at least 1';
    } else if (isFirst && tier.minStudents !== 1) {
      tierErrors[i].minStudents = 'First tier must start at 1 student';
    }

    if (!isValidNumber(tier.rate)) {
      tierErrors[i].rate = 'Rate is required';
    } else if (tier.rate <= 0) {
      tierErrors[i].rate = 'Rate must be greater than 0';
    }

    if (tier.maxStudents === null) {
      if (!isLast) {
        tierErrors[i].maxStudents = 'Only the last tier can have no maximum';
      }
    } else if (!isValidInteger(tier.maxStudents)) {
      tierErrors[i].maxStudents = 'Max students is required';
    } else if (isLast) {
      tierErrors[i].maxStudents = 'Last tier must be unbounded';
    } else if (isValidInteger(tier.minStudents) && tier.maxStudents < tier.minStudents) {
      tierErrors[i].maxStudents =
        `Max students (${tier.maxStudents}) must be at least min students (${tier.minStudents})`;
    }

    if (i > 0) {
      const prev = tiers[i - 1];
      if (prev.maxStudents === null) {
        tierErrors[i - 1].maxStudents = 'Only the last tier can have no maximum';
      } else if (isValidInteger(prev.maxStudents) && isValidInteger(tier.minStudents)) {
        const expectedMin = prev.maxStudents + 1;
        if (tier.minStudents !== expectedMin) {
          tierErrors[i].minStudents = `Must be ${expectedMin} to touch the previous tier`;
        }
      }
    }
  }

  return {
    isValid: tierErrors.every((errors) => Object.keys(errors).length === 0),
    tierErrors,
  };
}
