import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CalendarTab } from '../../src/components/CalendarTab/index.js';
import { CalendarGrid } from '../../src/components/CalendarTab/CalendarGrid.js';
import { ParsedClass, StudioConfig } from '../../src/lib/types.js';
import { parsedClass } from '../helpers/calendar-fixtures.js';

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

function markerCount(markup: string): number {
  return markup.match(/data-unconfigured-marker="true"/g)?.length ?? 0;
}

const studios: Record<string, StudioConfig> = {
  Studio: {
    fullName: 'Studio',
    address: '',
    rateTiers: [{ minStudents: 2, maxStudents: null, rate: 40 }],
  },
};

function renderGrid(classes: ParsedClass[]): string {
  return renderToStaticMarkup(
    <CalendarGrid year={2026} month={7} classes={classes} studios={studios} colorMap={{}} />
  );
}

describe('CalendarTab', () => {
  afterEach(() => vi.useRealTimers());

  it('marks each past desktop day containing an unconfigured or valueless class', () => {
    vi.useFakeTimers({ now: new Date('2026-08-24T12:00:00+02:00') });
    const classes = [
      parsedClass({ date: '2026-08-06', studentCount: 1, rateOverride: 55 }),
      parsedClass({ date: '2026-08-10', studentCount: 0 }),
      parsedClass({ date: '2026-08-11', studentCount: 1 }),
      parsedClass({
        date: '2026-08-12',
        studentCount: 8,
        eventIdentity: { calendarId: 'fixture-calendar', eventId: 'configured-mixed' },
      }),
      parsedClass({
        date: '2026-08-12',
        studioName: 'Unknown Studio',
        studentCount: 8,
        rateOverride: 55,
        unconfigured: true,
        eventIdentity: { calendarId: 'fixture-calendar', eventId: 'unconfigured-mixed' },
      }),
    ];

    expect(markerCount(renderGrid(classes))).toBe(3);
  });

  it('does not mark incomplete desktop days today or in the future', () => {
    vi.useFakeTimers({ now: new Date('2026-08-24T12:00:00+02:00') });
    const classes = [
      parsedClass({ date: '2026-08-24', studentCount: 0 }),
      parsedClass({ date: '2026-08-25', studentCount: 0 }),
    ];

    expect(markerCount(renderGrid(classes))).toBe(0);
  });

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
      parsedClass({
        studioName: 'eddy',
        classType: 'prenatal',
        date: `${visibleMonthPrefix()}-26`,
        startTime: '18:00',
        endTime: '19:00',
        studentCount: 1,
      }),
    ];

    expect(() =>
      renderToStaticMarkup(React.createElement(CalendarTab, { classes, studios }))
    ).not.toThrow();
  });
});
