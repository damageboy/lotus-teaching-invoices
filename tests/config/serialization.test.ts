import { describe, it, expect } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { validateConfig } from '../../src/lib/config/schema.js';
import { AppConfig } from '../../src/lib/types.js';

const SAMPLE_CONFIG: AppConfig = {
  teacher: {
    name: 'Test Teacher',
    address: '123 Main St\nCity 12345',
    taxNumber: 'DE123456789',
    bankDetails: {
      accountOwner: 'Test Teacher',
      iban: 'DE89370400440532013000',
      bic: 'COBADEFFXXX',
    },
  },
  calendarUrl: 'https://calendar.google.com/calendar/ical/example%40group.calendar.google.com/basic.ics',
  outputDir: '/tmp/invoices',
  studios: {
    Yogibar: {
      fullName: 'Yogibar Yoga Studio GmbH',
      address: '456 Yoga Lane\nMunich',
      rateTiers: [
        { minStudents: 1,  maxStudents: 5,    rate: 80  },
        { minStudents: 6,  maxStudents: 10,   rate: 100 },
        { minStudents: 11, maxStudents: null, rate: 120 },
      ],
    },
  },
};

describe('config serialization', () => {
  it('stringifies a valid config without throwing', () => {
    expect(() => stringifyYaml(SAMPLE_CONFIG)).not.toThrow();
  });

  it('round-trips through yaml stringify→parse→validateConfig losslessly', () => {
    const yaml = stringifyYaml(SAMPLE_CONFIG);
    const reparsed = validateConfig(parseYaml(yaml));
    expect(reparsed.teacher.name).toBe(SAMPLE_CONFIG.teacher.name);
    expect(reparsed.teacher.bankDetails.iban).toBe(SAMPLE_CONFIG.teacher.bankDetails.iban);
    expect(reparsed.studios.Yogibar.fullName).toBe('Yogibar Yoga Studio GmbH');
    expect(reparsed.studios.Yogibar.address).toBe('456 Yoga Lane\nMunich');
    expect(reparsed.calendarUrl).toBe(SAMPLE_CONFIG.calendarUrl);
    expect(reparsed.outputDir).toBe(SAMPLE_CONFIG.outputDir);
    expect(Object.keys(reparsed.studios)).toEqual(Object.keys(SAMPLE_CONFIG.studios));
    expect(reparsed.studios.Yogibar.rateTiers).toHaveLength(3);
    expect(reparsed.studios.Yogibar.rateTiers[2].maxStudents).toBeNull();
  });

  it('preserves null maxStudents through round-trip', () => {
    const yaml = stringifyYaml(SAMPLE_CONFIG);
    expect(yaml).toContain('maxStudents: null');
    const reparsed = validateConfig(parseYaml(yaml));
    expect(reparsed.studios.Yogibar.rateTiers[2].maxStudents).toBeNull();
  });

  it('JSON sanitization strips no data from a clean config', () => {
    const sanitized: AppConfig = JSON.parse(JSON.stringify(SAMPLE_CONFIG));
    expect(sanitized).toEqual(SAMPLE_CONFIG);
    expect(() => stringifyYaml(sanitized)).not.toThrow();
  });

  it('multiple studios round-trip correctly', () => {
    const multi: AppConfig = {
      ...SAMPLE_CONFIG,
      studios: {
        ...SAMPLE_CONFIG.studios,
        MySenses: {
          fullName: '',
          address: '',
          rateTiers: [{ minStudents: 1, maxStudents: null, rate: 60 }],
        },
      },
    };
    const yaml = stringifyYaml(multi);
    const reparsed = validateConfig(parseYaml(yaml));
    expect(Object.keys(reparsed.studios)).toContain('MySenses');
  });
});
