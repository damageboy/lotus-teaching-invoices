import { describe, it, expect } from 'vitest';
import { groupByStudio, filterByDateRange, filterByStudio } from '../../src/lib/invoice/grouper.js';
import { ParsedClass } from '../../src/lib/types.js';

const classes: ParsedClass[] = [
  {
    studioName: 'Zen Yoga',
    classType: 'Vinyasa',
    date: '2026-01-05',
    startTime: '09:00',
    endTime: '10:15',
    studentCount: 8,
  },
  {
    studioName: 'Power House',
    classType: 'HIIT',
    date: '2026-01-03',
    startTime: '18:00',
    endTime: '19:15',
    studentCount: 6,
  },
  {
    studioName: 'Zen Yoga',
    classType: 'Yin',
    date: '2026-01-03',
    startTime: '10:00',
    endTime: '11:15',
    studentCount: 3,
  },
  {
    studioName: 'Power House',
    classType: 'Power Flow',
    date: '2026-01-10',
    startTime: '14:00',
    endTime: '15:15',
    studentCount: 2,
  },
];

describe('groupByStudio', () => {
  it('groups classes by studio name', () => {
    const groups = groupByStudio(classes);
    expect(groups.size).toBe(2);
    expect(groups.get('Zen Yoga')).toHaveLength(2);
    expect(groups.get('Power House')).toHaveLength(2);
  });

  it('sorts classes within each group by date then time', () => {
    const groups = groupByStudio(classes);
    const zen = groups.get('Zen Yoga')!;
    expect(zen[0].date).toBe('2026-01-03');
    expect(zen[1].date).toBe('2026-01-05');
  });
});

describe('filterByDateRange', () => {
  it('includes classes within range', () => {
    const result = filterByDateRange(classes, '2026-01-01', '2026-01-05');
    expect(result).toHaveLength(3);
  });

  it('excludes classes outside range', () => {
    const result = filterByDateRange(classes, '2026-01-06', '2026-01-15');
    expect(result).toHaveLength(1);
    expect(result[0].studioName).toBe('Power House');
  });
});

describe('filterByStudio', () => {
  it('filters to specified studio', () => {
    const result = filterByStudio(classes, 'Zen Yoga');
    expect(result).toHaveLength(2);
    expect(result.every((c) => c.studioName === 'Zen Yoga')).toBe(true);
  });
});
