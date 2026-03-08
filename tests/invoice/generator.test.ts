import { describe, it, expect } from 'vitest';
import { generateInvoice } from '../../src/lib/invoice/generator.js';
import { ParsedClass, StudioConfig } from '../../src/lib/types.js';

const studioConfig: StudioConfig = {
  rateTiers: [
    { minStudents: 1, maxStudents: 5, rate: 80 },
    { minStudents: 6, maxStudents: 10, rate: 100 },
    { minStudents: 11, maxStudents: null, rate: 120 },
  ],
};

const classes: ParsedClass[] = [
  {
    studioName: 'Zen Yoga',
    classType: 'Vinyasa Flow',
    date: '2026-01-03',
    startTime: '09:00',
    endTime: '10:15',
    studentCount: 8,
  },
  {
    studioName: 'Zen Yoga',
    classType: 'Yin Yoga',
    date: '2026-01-05',
    startTime: '18:00',
    endTime: '19:15',
    studentCount: 3,
  },
  {
    studioName: 'Zen Yoga',
    classType: 'Vinyasa Flow',
    date: '2026-01-10',
    startTime: '09:00',
    endTime: '10:15',
    studentCount: 12,
  },
];

describe('generateInvoice', () => {
  it('creates an invoice with correct structure', () => {
    const { invoice } = generateInvoice('Zen Yoga', classes, studioConfig, {
      from: '2026-01-01',
      to: '2026-01-31',
    });

    expect(invoice.studioName).toBe('Zen Yoga');
    expect(invoice.invoicePeriod).toEqual({ from: '2026-01-01', to: '2026-01-31' });
    expect(invoice.totalClasses).toBe(3);
    expect(invoice.classes).toHaveLength(3);
    expect(invoice.generatedAt).toBeDefined();
  });

  it('applies correct rates based on student count', () => {
    const { invoice } = generateInvoice('Zen Yoga', classes, studioConfig, {
      from: '2026-01-01',
      to: '2026-01-31',
    });

    // 8 students → 100, 3 students → 80, 12 students → 120
    expect(invoice.classes[0].rateApplied).toBe(100);
    expect(invoice.classes[1].rateApplied).toBe(80);
    expect(invoice.classes[2].rateApplied).toBe(120);
  });

  it('calculates correct total amount', () => {
    const { invoice } = generateInvoice('Zen Yoga', classes, studioConfig, {
      from: '2026-01-01',
      to: '2026-01-31',
    });

    // 100 + 80 + 120 = 300
    expect(invoice.totalAmount).toBe(300);
  });

  it('handles empty classes array', () => {
    const { invoice } = generateInvoice('Zen Yoga', [], studioConfig, {
      from: '2026-01-01',
      to: '2026-01-31',
    });

    expect(invoice.totalClasses).toBe(0);
    expect(invoice.totalAmount).toBe(0);
    expect(invoice.classes).toHaveLength(0);
  });

  it('skips classes with 0 students and warns', () => {
    const classesWithZero: ParsedClass[] = [
      {
        studioName: 'Zen Yoga',
        classType: 'Vinyasa',
        date: '2026-01-03',
        startTime: '09:00',
        endTime: '10:15',
        studentCount: 8,
      },
      {
        studioName: 'Zen Yoga',
        classType: 'Hatha',
        date: '2026-01-05',
        startTime: '09:00',
        endTime: '10:15',
        studentCount: 0,
      },
    ];

    const { invoice, warnings } = generateInvoice('Zen Yoga', classesWithZero, studioConfig, {
      from: '2026-01-01',
      to: '2026-01-31',
    });

    expect(invoice.totalClasses).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('ZERO_STUDENTS');
  });

  it('preserves location in invoice line items', () => {
    const classesWithLocation: ParsedClass[] = [
      {
        studioName: 'YFD',
        classType: 'Vinyasa',
        location: 'mitte',
        date: '2026-01-08',
        startTime: '17:00',
        endTime: '18:15',
        studentCount: 7,
      },
      {
        studioName: 'YFD',
        classType: 'Hatha',
        location: 'schoeneberg',
        date: '2026-01-14',
        startTime: '17:00',
        endTime: '18:15',
        studentCount: 4,
      },
    ];

    const { invoice } = generateInvoice('YFD', classesWithLocation, studioConfig, {
      from: '2026-01-01',
      to: '2026-01-31',
    });

    expect(invoice.classes[0].location).toBe('mitte');
    expect(invoice.classes[0].classType).toBe('Vinyasa');
    expect(invoice.classes[1].location).toBe('schoeneberg');
    expect(invoice.classes[1].classType).toBe('Hatha');
  });

  it('omits location for single-location classes', () => {
    const { invoice } = generateInvoice('Zen Yoga', classes, studioConfig, {
      from: '2026-01-01',
      to: '2026-01-31',
    });

    expect(invoice.classes.every((c) => c.location === undefined)).toBe(true);
  });
});
