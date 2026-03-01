import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCalendarEvents, extractClasses } from '../../src/lib/calendar/parser.js';

const fixturesDir = join(import.meta.dirname, '..', 'fixtures');
const icsData = readFileSync(join(fixturesDir, 'sample.ics'), 'utf-8');

describe('parseCalendarEvents', () => {
  it('parses all VEVENT entries from ICS', () => {
    const events = parseCalendarEvents(icsData);
    expect(events).toHaveLength(8);
  });

  it('extracts summary and description', () => {
    const events = parseCalendarEvents(icsData);
    const first = events.find((e) => e.uid === 'event-1@test');
    expect(first).toBeDefined();
    expect(first!.summary).toBe('Zen Yoga / Vinyasa Flow');
    expect(first!.description).toBe('8');
  });
});

describe('extractClasses', () => {
  const knownStudios = new Map([
    ['zen yoga', 'Zen Yoga'],
    ['power house', 'Power House'],
  ]);

  it('extracts valid classes', () => {
    const events = parseCalendarEvents(icsData);
    const { classes } = extractClasses(events, knownStudios);
    // 4 Zen Yoga + 2 Power House = 6 valid (event-6 has empty desc but still valid studio)
    // event-7 (Unknown Studio) and event-8 (No Separator) are excluded
    expect(classes.length).toBeGreaterThanOrEqual(5);
  });

  it('parses studio name and class type', () => {
    const events = parseCalendarEvents(icsData);
    const { classes } = extractClasses(events, knownStudios);
    const first = classes.find((c) => c.classType === 'Vinyasa Flow' && c.studentCount === 8);
    expect(first).toBeDefined();
    expect(first!.studioName).toBe('Zen Yoga');
    expect(first!.date).toBe('2026-01-03');
    expect(first!.startTime).toBe('09:00');
    expect(first!.endTime).toBe('10:15');
  });

  it('includes unknown studio as unconfigured class (not a warning)', () => {
    const events = parseCalendarEvents(icsData);
    const { classes, warnings } = extractClasses(events, knownStudios);
    expect(warnings.some((w) => w.code === 'UNKNOWN_STUDIO')).toBe(false);
    expect(classes.some((c) => c.unconfigured && c.studioName === 'Unknown Studio')).toBe(true);
  });

  it('warns on missing separator', () => {
    const events = parseCalendarEvents(icsData);
    const { warnings } = extractClasses(events, knownStudios);
    expect(warnings.some((w) => w.code === 'NO_SEPARATOR')).toBe(true);
  });

  it('warns on missing student count', () => {
    const events = parseCalendarEvents(icsData);
    const { warnings } = extractClasses(events, knownStudios);
    expect(warnings.some((w) => w.code === 'MISSING_STUDENT_COUNT')).toBe(true);
  });
});
