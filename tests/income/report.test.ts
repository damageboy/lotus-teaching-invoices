import { describe, it, expect } from 'vitest';
import { buildIncomeReport, buildIncomeYears } from '../../src/lib/income/report.js';
import { AppConfig, ParsedClass } from '../../src/lib/types.js';

const config: AppConfig = {
  teacher: {
    name: 'Teacher',
    address: '',
    taxNumber: '',
    bankDetails: { accountOwner: '', iban: '', bic: '' },
  },
  outputDir: '',
  lastInvoice: '',
  studios: {
    Alpha: {
      fullName: 'Alpha',
      address: '',
      rateTiers: [{ minStudents: 1, maxStudents: null, rate: 100 }],
      color: '#059669',
    },
    Beta: {
      fullName: 'Beta',
      address: '',
      rateTiers: [{ minStudents: 1, maxStudents: null, rate: 50 }],
      color: '#0284c7',
    },
  },
};

const classes: ParsedClass[] = [
  {
    studioName: 'Alpha',
    classType: 'Flow',
    date: '2025-01-10',
    startTime: '09:00',
    endTime: '10:00',
    studentCount: 5,
  },
  {
    studioName: 'Alpha',
    classType: 'Flow',
    date: '2026-01-10',
    startTime: '09:00',
    endTime: '10:00',
    studentCount: 5,
  },
  {
    studioName: 'Beta',
    classType: 'Yin',
    date: '2026-01-11',
    startTime: '09:00',
    endTime: '10:00',
    studentCount: 3,
  },
  {
    studioName: 'Beta',
    classType: 'Yin',
    date: '2026-02-11',
    startTime: '09:00',
    endTime: '10:00',
    studentCount: 3,
  },
];

describe('buildIncomeReport', () => {
  it('builds monthly stacked totals by studio', () => {
    const report = buildIncomeReport(classes, config, 2026);

    expect(report.months[0].monthName).toBe('Jan');
    expect(report.months[0].total).toBe(150);
    expect(report.months[0].studios).toEqual([
      { studioName: 'Alpha', total: 100, color: '#059669' },
      { studioName: 'Beta', total: 50, color: '#0284c7' },
    ]);
    expect(report.yearTotal).toBe(200);
  });

  it('computes current-year YoY only when previous-year total exists', () => {
    const report = buildIncomeReport(classes, config, 2026);

    expect(report.months[0].yoyPercent).toBe(50);
    expect(report.months[0].yoyLabel).toBe('+50%');
    expect(report.months[1].yoyPercent).toBeNull();
    expect(report.months[1].yoyLabel).toBe('n/a');
  });

  it('does not compute YoY for previous-year view', () => {
    const report = buildIncomeReport(classes, config, 2025);

    expect(report.months[0].total).toBe(100);
    expect(report.months[0].yoyPercent).toBeNull();
    expect(report.months[0].yoyLabel).toBe('n/a');
  });
});

describe('buildIncomeYears', () => {
  it('returns years with historical data and excludes future recurring classes', () => {
    const years = buildIncomeYears(
      [
        ...classes,
        {
          studioName: 'Alpha',
          classType: 'Future current year',
          date: '2026-07-10',
          startTime: '09:00',
          endTime: '10:00',
          studentCount: 5,
        },
        {
          studioName: 'Alpha',
          classType: 'Future next year',
          date: '2027-01-10',
          startTime: '09:00',
          endTime: '10:00',
          studentCount: 5,
        },
        {
          studioName: 'Alpha',
          classType: 'Old class',
          date: '2024-05-10',
          startTime: '09:00',
          endTime: '10:00',
          studentCount: 5,
        },
      ],
      '2026-06-01'
    );

    expect(years).toEqual([2026, 2025, 2024]);
  });
});
