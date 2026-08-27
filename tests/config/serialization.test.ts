import { describe, it, expect } from 'vitest';
import {
  parseConfigYaml,
  parseLegacyLocalConfigYaml,
  serializeConfigYaml,
} from '../../src/lib/config/schema.js';
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
  calendarId: 'example@group.calendar.google.com',
  calendarName: 'Teaching Schedule',
  calendarAccessRole: 'writer',
  studios: {
    Yogibar: {
      fullName: 'Yogibar Yoga Studio GmbH',
      address: '456 Yoga Lane\nMunich',
      rateTiers: [
        { minStudents: 1, maxStudents: 5, rate: 80 },
        { minStudents: 6, maxStudents: 10, rate: 100 },
        { minStudents: 11, maxStudents: null, rate: 120 },
      ],
    },
  },
  invoiceSequenceByYear: { '2026': 9 },
};

describe('config serialization', () => {
  it('stringifies a valid config without throwing', () => {
    expect(() => serializeConfigYaml(SAMPLE_CONFIG)).not.toThrow();
  });

  it('round-trips through yaml stringify→parse→validateConfig losslessly', () => {
    const yaml = serializeConfigYaml(SAMPLE_CONFIG);
    const reparsed = parseConfigYaml(yaml);
    expect(reparsed.teacher.name).toBe(SAMPLE_CONFIG.teacher.name);
    expect(reparsed.teacher.bankDetails.iban).toBe(SAMPLE_CONFIG.teacher.bankDetails.iban);
    expect(reparsed.studios.Yogibar.fullName).toBe('Yogibar Yoga Studio GmbH');
    expect(reparsed.studios.Yogibar.address).toBe('456 Yoga Lane\nMunich');
    expect(reparsed.calendarId).toBe(SAMPLE_CONFIG.calendarId);
    expect(reparsed.calendarName).toBe(SAMPLE_CONFIG.calendarName);
    expect(reparsed.calendarAccessRole).toBe(SAMPLE_CONFIG.calendarAccessRole);
    expect(reparsed.invoiceSequenceByYear).toEqual({ '2026': 9 });
    expect(reparsed).not.toHaveProperty('outputDir');
    expect(reparsed).not.toHaveProperty('lastInvoice');
    expect(Object.keys(reparsed.studios)).toEqual(Object.keys(SAMPLE_CONFIG.studios));
    expect(reparsed.studios.Yogibar.rateTiers).toHaveLength(3);
    expect(reparsed.studios.Yogibar.rateTiers[2].maxStudents).toBeNull();
  });

  it('preserves null maxStudents through round-trip', () => {
    const yaml = serializeConfigYaml(SAMPLE_CONFIG);
    expect(yaml).toContain('maxStudents: null');
    const reparsed = parseConfigYaml(yaml);
    expect(reparsed.studios.Yogibar.rateTiers[2].maxStudents).toBeNull();
  });

  it('removes legacy local storage fields only through the migration parser', () => {
    const migrated = parseLegacyLocalConfigYaml(
      `${serializeConfigYaml(SAMPLE_CONFIG)}\noutputDir: /legacy\nlastInvoice: '8/2026'\n`
    );

    expect(migrated.lastInvoice).toBe('8/2026');
    expect(migrated.config).not.toHaveProperty('outputDir');
    expect(migrated.config).not.toHaveProperty('lastInvoice');
    expect(migrated.config.invoiceSequenceByYear).toEqual({});
  });

  it('JSON sanitization strips no data from a clean config', () => {
    const sanitized: AppConfig = JSON.parse(JSON.stringify(SAMPLE_CONFIG));
    expect(sanitized).toEqual(SAMPLE_CONFIG);
    expect(() => serializeConfigYaml(sanitized)).not.toThrow();
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
    const yaml = serializeConfigYaml(multi);
    const reparsed = parseConfigYaml(yaml);
    expect(Object.keys(reparsed.studios)).toContain('MySenses');
  });

  it.each(['reservation', 'generation', 'root', 'finalFolderId', 'sequenceByYear'])(
    'rejects obsolete remote field %s',
    (field) => {
      expect(() =>
        parseConfigYaml(`${serializeConfigYaml(SAMPLE_CONFIG)}\n${field}: null\n`)
      ).toThrow(field);
    }
  );

  it.each([{ '26': 1 }, { '2026': -1 }, { '2026': 1.5 }, { '2026': Number.MAX_SAFE_INTEGER + 1 }])(
    'rejects invalid invoice sequence maps',
    (invoiceSequenceByYear) => {
      expect(() => serializeConfigYaml({ ...SAMPLE_CONFIG, invoiceSequenceByYear })).toThrow();
    }
  );
});
