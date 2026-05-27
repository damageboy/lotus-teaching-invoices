import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CalendarTab } from '../../src/components/CalendarTab/index.js';
import { ParsedClass, StudioConfig } from '../../src/lib/types.js';

(globalThis as unknown as { React: typeof React }).React = React;

function visibleMonthPrefix(): string {
  const now = new Date();
  const defaultInPrevMonth = now.getDate() <= 15;
  const month = defaultInPrevMonth
    ? now.getMonth() === 0
      ? 11
      : now.getMonth() - 1
    : now.getMonth();
  const year =
    defaultInPrevMonth && now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

describe('CalendarTab', () => {
  it('renders when a visible class has no matching rate tier', () => {
    const studios: Record<string, StudioConfig> = {
      eddy: {
        fullName: 'eddy',
        address: '',
        rateTiers: [
          { minStudents: 2, maxStudents: 7, rate: 30 },
          { minStudents: 8, maxStudents: null, rate: 40 },
        ],
      },
    };
    const classes: ParsedClass[] = [
      {
        studioName: 'eddy',
        classType: 'prenatal',
        date: `${visibleMonthPrefix()}-26`,
        startTime: '18:00',
        endTime: '19:00',
        studentCount: 1,
      },
    ];

    expect(() =>
      renderToStaticMarkup(React.createElement(CalendarTab, { classes, studios }))
    ).not.toThrow();
  });
});
