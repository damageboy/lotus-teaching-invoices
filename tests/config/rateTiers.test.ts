import { describe, expect, it } from 'vitest';
import { getRateTierValidation } from '../../src/lib/config/rateTiers.js';
import { RateTier } from '../../src/lib/types.js';

describe('getRateTierValidation', () => {
  it('accepts contiguous tiers that start at 1 and end unbounded', () => {
    const tiers: RateTier[] = [
      { minStudents: 1, maxStudents: 5, rate: 80 },
      { minStudents: 6, maxStudents: null, rate: 100 },
    ];

    expect(getRateTierValidation(tiers).isValid).toBe(true);
  });

  it('accepts decimal rates', () => {
    const tiers: RateTier[] = [{ minStudents: 1, maxStudents: null, rate: 32.5 }];

    expect(getRateTierValidation(tiers).isValid).toBe(true);
  });

  it('rejects first tier minStudents above 1', () => {
    const tiers: RateTier[] = [
      { minStudents: 2, maxStudents: 5, rate: 80 },
      { minStudents: 6, maxStudents: null, rate: 100 },
    ];

    const validation = getRateTierValidation(tiers);

    expect(validation.isValid).toBe(false);
    expect(validation.tierErrors[0].minStudents).toContain('First tier');
  });

  it('rejects bounded last tiers', () => {
    const tiers: RateTier[] = [{ minStudents: 1, maxStudents: 5, rate: 80 }];

    const validation = getRateTierValidation(tiers);

    expect(validation.isValid).toBe(false);
    expect(validation.tierErrors[0].maxStudents).toContain('Last tier');
  });

  it('marks mid-tier gaps and overlaps on the touching min input', () => {
    const tiers: RateTier[] = [
      { minStudents: 1, maxStudents: 5, rate: 80 },
      { minStudents: 7, maxStudents: 10, rate: 100 },
      { minStudents: 10, maxStudents: null, rate: 120 },
    ];

    const validation = getRateTierValidation(tiers);

    expect(validation.isValid).toBe(false);
    expect(validation.tierErrors[1].minStudents).toContain('6');
    expect(validation.tierErrors[2].minStudents).toContain('11');
  });

  it('marks incomplete numeric fields', () => {
    const tiers: RateTier[] = [
      { minStudents: Number.NaN, maxStudents: 5, rate: 80 },
      { minStudents: 6, maxStudents: null, rate: Number.NaN },
    ];

    const validation = getRateTierValidation(tiers);

    expect(validation.isValid).toBe(false);
    expect(validation.tierErrors[0].minStudents).toContain('required');
    expect(validation.tierErrors[1].rate).toContain('required');
  });
});
