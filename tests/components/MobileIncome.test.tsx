import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
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

describe('Mobile Income', () => {
  it('renders full monthly rows, totals, legend, and year-over-year labels without the desktop chart width', () => {
    const html = renderToStaticMarkup(
      React.createElement(IncomeTab, { classes, config, layout: 'mobile' })
    );

    expect(html).toContain('Income');
    expect(html).toContain('Annual total');
    expect(html).toContain('January');
    expect(html).toContain('December');
    expect(html).toContain('€150.00');
    expect(html).toContain('+50%');
    expect(html).toContain('Alpha');
    expect(html).toContain('Beta');
    expect(html).toContain('#059669');
    expect(html).toContain('width:30%');
    expect(html).toContain('width:66.66666666666666%');
    expect(html).toContain('width:33.33333333333333%');
    expect(html).not.toContain('min-w-[760px]');
  });

  it('keeps all twelve zero-total month rows visible', () => {
    const html = renderToStaticMarkup(
      React.createElement(IncomeTab, { classes: [], config, layout: 'mobile' })
    );

    const document = new JSDOM(html).window.document;
    for (const month of [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ]) {
      expect(html).toContain(month);
      const row = [...document.querySelectorAll('article')].find((article) =>
        article.textContent?.includes(month)
      );
      expect(row?.textContent).toContain('€0.00');
    }
    expect(html).toContain('Annual total');
    expect(html).toContain('€0.00');
    expect(html).toContain('data-empty="true"');
    expect(document.querySelector('select[aria-label="Income year"]')?.className).toContain(
      'text-base'
    );
  });
});
