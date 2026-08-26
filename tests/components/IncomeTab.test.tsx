import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IncomeTab } from '../../src/components/IncomeTab/index.js';
import { AppConfig, ParsedClass } from '../../src/lib/types.js';
import { parsedClass } from '../helpers/calendar-fixtures.js';

(globalThis as unknown as { React: typeof React }).React = React;

const currentYear = new Date().getFullYear();
const previousYear = currentYear - 1;

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
  parsedClass({
    studioName: 'Alpha',
    classType: 'Flow',
    date: `${previousYear}-01-10`,
    startTime: '09:00',
    endTime: '10:00',
    studentCount: 5,
  }),
  parsedClass({
    studioName: 'Alpha',
    classType: 'Flow',
    date: `${currentYear}-01-10`,
    startTime: '09:00',
    endTime: '10:00',
    studentCount: 5,
  }),
  parsedClass({
    studioName: 'Beta',
    classType: 'Yin',
    date: `${currentYear}-01-11`,
    startTime: '09:00',
    endTime: '10:00',
    studentCount: 3,
  }),
];

describe('IncomeTab', () => {
  it('renders monthly income chart labels, year selector, legend, and YoY badge', () => {
    const html = renderToStaticMarkup(
      React.createElement(IncomeTab, { classes, config, layout: 'desktop' })
    );

    expect(html).toContain('Monthly Income');
    expect(html).toContain(`<option value="${currentYear}" selected="">${currentYear}</option>`);
    expect(html).toContain(`<option value="${previousYear}">${previousYear}</option>`);
    expect(html).toContain('Jan');
    expect(html).toContain('Dec');
    expect(html).toContain('Alpha');
    expect(html).toContain('Beta');
    expect(html).toContain('€150.00');
    expect(html).toContain('+50%');
    expect(html).toContain('min-w-[760px]');
  });

  it('uses years with historical data for the selector and excludes future recurring years', () => {
    const html = renderToStaticMarkup(
      React.createElement(IncomeTab, {
        classes: [
          ...classes,
          parsedClass({
            studioName: 'Alpha',
            classType: 'Future recurring',
            date: `${currentYear + 1}-01-10`,
            startTime: '09:00',
            endTime: '10:00',
            studentCount: 5,
          }),
          parsedClass({
            studioName: 'Alpha',
            classType: 'Old class',
            date: `${currentYear - 3}-01-10`,
            startTime: '09:00',
            endTime: '10:00',
            studentCount: 5,
          }),
        ],
        config,
      })
    );

    expect(html).toContain(`<option value="${currentYear - 3}">${currentYear - 3}</option>`);
    expect(html).not.toContain(`<option value="${currentYear + 1}">${currentYear + 1}</option>`);
  });
});
