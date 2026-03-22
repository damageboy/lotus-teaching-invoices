import { describe, it, expect } from 'vitest';
import { extractClasses } from '../../src/lib/calendar/parser.js';
import { CalendarEvent } from '../../src/lib/types.js';

const testEvents: CalendarEvent[] = [
  {
    uid: 'event-1',
    summary: 'Zen Yoga / Vinyasa Flow',
    description: '8',
    start: new Date('2026-01-03T09:00:00'),
    end: new Date('2026-01-03T10:15:00'),
  },
  {
    uid: 'event-2',
    summary: 'Zen Yoga / Yin Yoga',
    description: '3',
    start: new Date('2026-01-05T18:00:00'),
    end: new Date('2026-01-05T19:15:00'),
  },
  {
    uid: 'event-3',
    summary: 'Power House / HIIT Yoga',
    description: '6',
    start: new Date('2026-01-07T10:00:00'),
    end: new Date('2026-01-07T11:15:00'),
  },
  {
    uid: 'event-4',
    summary: 'Zen Yoga / Vinyasa Flow',
    description: '12',
    start: new Date('2026-01-10T09:00:00'),
    end: new Date('2026-01-10T10:15:00'),
  },
  {
    uid: 'event-5',
    summary: 'Power House / Power Flow',
    description: '2',
    start: new Date('2026-01-12T14:00:00'),
    end: new Date('2026-01-12T15:15:00'),
  },
  {
    uid: 'event-6',
    summary: 'Zen Yoga / Hatha',
    description: '',
    start: new Date('2026-01-15T09:00:00'),
    end: new Date('2026-01-15T10:15:00'),
  },
  {
    uid: 'event-7',
    summary: 'Unknown Studio / Mystery Class',
    description: '5',
    start: new Date('2026-01-20T10:00:00'),
    end: new Date('2026-01-20T11:15:00'),
  },
  {
    uid: 'event-8',
    summary: 'No Separator Here',
    description: '5',
    start: new Date('2026-01-25T09:00:00'),
    end: new Date('2026-01-25T10:15:00'),
  },
  {
    uid: 'event-9',
    summary: 'YFD / mitte / Vinyasa',
    description: '7',
    start: new Date('2026-01-08T17:00:00'),
    end: new Date('2026-01-08T18:15:00'),
  },
  {
    uid: 'event-10',
    summary: 'YFD / schoeneberg / Hatha',
    description: '4',
    start: new Date('2026-01-14T17:00:00'),
    end: new Date('2026-01-14T18:15:00'),
  },
];

const knownStudios = new Map([
  ['zen yoga', 'Zen Yoga'],
  ['power house', 'Power House'],
]);

describe('extractClasses', () => {
  it('extracts valid classes', () => {
    const { classes } = extractClasses(testEvents, knownStudios);
    expect(classes.length).toBeGreaterThanOrEqual(5);
  });

  it('parses studio name and class type', () => {
    const { classes } = extractClasses(testEvents, knownStudios);
    const first = classes.find((c) => c.classType === 'Vinyasa Flow' && c.studentCount === 8);
    expect(first).toBeDefined();
    expect(first!.studioName).toBe('Zen Yoga');
    expect(first!.date).toBe('2026-01-03');
    expect(first!.startTime).toBe('09:00');
    expect(first!.endTime).toBe('10:15');
  });

  it('includes unknown studio as unconfigured class (not a warning)', () => {
    const { classes, warnings } = extractClasses(testEvents, knownStudios);
    expect(warnings.some((w) => w.code === 'UNKNOWN_STUDIO')).toBe(false);
    expect(classes.some((c) => c.unconfigured && c.studioName === 'Unknown Studio')).toBe(true);
  });

  it('warns on missing separator', () => {
    const { warnings } = extractClasses(testEvents, knownStudios);
    expect(warnings.some((w) => w.code === 'NO_SEPARATOR')).toBe(true);
  });

  it('warns on missing student count', () => {
    const { warnings } = extractClasses(testEvents, knownStudios);
    expect(warnings.some((w) => w.code === 'MISSING_STUDENT_COUNT')).toBe(true);
  });

  it('parses multi-location events (2 slashes)', () => {
    const studios = new Map([
      ['zen yoga', 'Zen Yoga'],
      ['power house', 'Power House'],
      ['yfd', 'YFD'],
    ]);
    const { classes } = extractClasses(testEvents, studios);
    const yfdClasses = classes.filter((c) => c.studioName === 'YFD');
    expect(yfdClasses).toHaveLength(2);
    expect(yfdClasses[0].location).toBe('mitte');
    expect(yfdClasses[0].classType).toBe('Vinyasa');
    expect(yfdClasses[1].location).toBe('schoeneberg');
    expect(yfdClasses[1].classType).toBe('Hatha');
  });

  it('single-location events have no location field', () => {
    const { classes } = extractClasses(testEvents, knownStudios);
    const zenClasses = classes.filter((c) => c.studioName === 'Zen Yoga');
    expect(zenClasses.every((c) => c.location === undefined)).toBe(true);
  });
});
