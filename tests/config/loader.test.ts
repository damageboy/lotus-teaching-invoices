import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { loadConfig } from '../../src/lib/config/loader.js';
import { validateConfig } from '../../src/lib/config/schema.js';

const fixturesDir = join(import.meta.dirname, '..', 'fixtures');

describe('loadConfig', () => {
  it('loads and validates the test fixture config', () => {
    const config = loadConfig(join(fixturesDir, 'config.yaml'));
    expect(config.calendarUrl).toBe('https://calendar.google.com/calendar/ical/example/basic.ics');
    expect(config.teacher.name).toBe('');
    expect(config.teacher.taxNumber).toBe('');
    expect(config.teacher.bankDetails.iban).toBe('');
    expect(config.outputDir).toBe('');
    expect(Object.keys(config.studios)).toEqual(['Zen Yoga', 'Power House']);
    expect(config.studios['Zen Yoga'].rateTiers).toHaveLength(3);
    expect(config.studios['Power House'].rateTiers).toHaveLength(3);
  });

  it('throws on missing file', () => {
    expect(() => loadConfig('/nonexistent/config.yaml')).toThrow('Cannot read config file');
  });
});

describe('validateConfig', () => {
  it('rejects non-object input', () => {
    expect(() => validateConfig(null)).toThrow('Config must be an object');
    expect(() => validateConfig('string')).toThrow('Config must be an object');
  });

  it('rejects missing calendarUrl', () => {
    expect(() => validateConfig({ studios: {} })).toThrow('Required');
  });

  it('rejects empty studios', () => {
    expect(() => validateConfig({ calendarUrl: 'http://x', studios: {} })).toThrow(
      'at least one studio'
    );
  });
});

describe('validateRateTiers (via validateConfig)', () => {
  it('accepts valid contiguous tiers', () => {
    expect(() =>
      validateConfig({
        calendarUrl: 'url',
        studios: {
          Test: {
            rateTiers: [
              { minStudents: 1, maxStudents: 5, rate: 80 },
              { minStudents: 6, maxStudents: null, rate: 100 },
            ],
          },
        },
      })
    ).not.toThrow();
  });

  it('rejects empty tiers', () => {
    expect(() =>
      validateConfig({
        calendarUrl: 'url',
        studios: {
          Test: {
            rateTiers: [],
          },
        },
      })
    ).toThrow('has no rate tiers');
  });

  it('rejects gap between tiers', () => {
    expect(() =>
      validateConfig({
        calendarUrl: 'url',
        studios: {
          Test: {
            rateTiers: [
              { minStudents: 1, maxStudents: 3, rate: 80 },
              { minStudents: 5, maxStudents: null, rate: 100 },
            ],
          },
        },
      })
    ).toThrow('gap or overlap');
  });

  it('rejects non-terminal unbounded tier', () => {
    expect(() =>
      validateConfig({
        calendarUrl: 'url',
        studios: {
          Test: {
            rateTiers: [
              { minStudents: 1, maxStudents: null, rate: 80 },
              { minStudents: 2, maxStudents: null, rate: 100 },
            ],
          },
        },
      })
    ).toThrow('unbounded tier');
  });

  it('rejects bounded last tier', () => {
    expect(() =>
      validateConfig({
        calendarUrl: 'url',
        studios: {
          Test: {
            rateTiers: [{ minStudents: 1, maxStudents: 5, rate: 80 }],
          },
        },
      })
    ).toThrow('last tier must be unbounded');
  });
});

describe('lastInvoice field', () => {
  it('defaults to empty string when absent', () => {
    const cfg = validateConfig({
      calendarUrl: 'https://example.com/cal.ics',
      studios: { Foo: { rateTiers: [{ minStudents: 1, maxStudents: null, rate: 80 }] } },
    });
    expect(cfg.lastInvoice).toBe('');
  });

  it('accepts a valid N/YYYY string', () => {
    const cfg = validateConfig({
      calendarUrl: 'https://example.com/cal.ics',
      lastInvoice: '7/2026',
      studios: { Foo: { rateTiers: [{ minStudents: 1, maxStudents: null, rate: 80 }] } },
    });
    expect(cfg.lastInvoice).toBe('7/2026');
  });

  it('rejects an invalid format', () => {
    expect(() =>
      validateConfig({
        calendarUrl: 'https://example.com/cal.ics',
        lastInvoice: 'bad',
        studios: { Foo: { rateTiers: [{ minStudents: 1, maxStudents: null, rate: 80 }] } },
      })
    ).toThrow(/lastInvoice/);
  });
});
