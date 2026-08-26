import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';
import { parsedClass } from '../helpers/calendar-fixtures.js';
import type { ParsedClass, StudioConfig } from '../../src/lib/types.js';
import {
  initialMobileDate,
  lessonExpectedAmount,
} from '../../src/components/CalendarTab/mobile-calendar.js';
import { CalendarTab } from '../../src/components/CalendarTab/index.js';
import { UnconfiguredMarker } from '../../src/components/CalendarTab/UnconfiguredMarker.js';

const restoreEnvironment = installReactTestEnvironment();
Object.defineProperties(window.HTMLElement.prototype, {
  attachEvent: { configurable: true, value: () => {} },
  detachEvent: { configurable: true, value: () => {} },
});
const roots: Array<{ root: Root; container: HTMLElement }> = [];

function render(ui: ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ root, container });
  act(() => root.render(ui));
  return {
    rerender(nextUi: ReactNode) {
      act(() => root.render(nextUi));
    },
  };
}

function namedButton(name: string | RegExp): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((element) => {
    const accessibleName = element.getAttribute('aria-label') ?? element.textContent ?? '';
    return typeof name === 'string' ? accessibleName.trim() === name : name.test(accessibleName);
  });
  if (!button) throw new Error(`Missing button named ${String(name)}`);
  return button;
}

function namedElement(role: string, name: string | RegExp): HTMLElement {
  const element = [...document.querySelectorAll<HTMLElement>(`[role="${role}"],${role}`)].find(
    (candidate) => {
      const accessibleName = candidate.getAttribute('aria-label') ?? candidate.textContent ?? '';
      return typeof name === 'string' ? accessibleName.trim() === name : name.test(accessibleName);
    }
  );
  if (!element) throw new Error(`Missing ${role} named ${String(name)}`);
  return element;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

async function pressTab(shiftKey = false) {
  const event = new window.KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    document.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}

async function typeValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    const inputConstructor = input.ownerDocument.defaultView!.HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(inputConstructor.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new input.ownerDocument.defaultView!.Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

function setTestTime(now: Date) {
  vi.useRealTimers();
  vi.useFakeTimers({ now });
}

function studioWithRate(rate: number): StudioConfig {
  return {
    fullName: 'Studio',
    address: '',
    rateTiers: [{ minStudents: 1, maxStudents: null, rate }],
  };
}

afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
});
afterAll(() => restoreEnvironment());

describe('mobile calendar presentation helpers', () => {
  it('renders the shared unconfigured marker with optional date metadata', () => {
    render(<UnconfiguredMarker className="fixture-marker" dateMarker />);

    const marker = document.querySelector('svg');
    expect(marker?.getAttribute('aria-hidden')).toBe('true');
    expect(marker?.getAttribute('viewBox')).toBe('0 0 12 12');
    expect(marker?.getAttribute('data-unconfigured-marker')).toBe('true');
    expect(marker?.classList.contains('fixture-marker')).toBe(true);
    expect(marker?.querySelectorAll('circle')).toHaveLength(1);
    expect(marker?.querySelectorAll('path')).toHaveLength(1);
  });
});

describe('mobile calendar derivations', () => {
  it('selects today, then the first lesson, then the first day of the month', () => {
    const lessons = [parsedClass({ date: '2026-08-24' })];

    expect(initialMobileDate(2026, 7, lessons, new Date('2026-08-22T12:00:00+02:00'))).toBe(
      '2026-08-22'
    );
    expect(initialMobileDate(2026, 7, lessons, new Date('2026-09-01T12:00:00+02:00'))).toBe(
      '2026-08-24'
    );
    expect(initialMobileDate(2026, 7, [], new Date('2026-09-01T12:00:00+02:00'))).toBe(
      '2026-08-01'
    );
  });

  it('uses overrides and matching tiers, and leaves unavailable amounts blank', () => {
    expect(lessonExpectedAmount(parsedClass({ studentCount: 8 }), studioWithRate(55))).toBe(55);
    expect(
      lessonExpectedAmount(parsedClass({ studentCount: 8, rateOverride: 61.5 }), studioWithRate(55))
    ).toBe(61.5);
    expect(lessonExpectedAmount(parsedClass({ studentCount: 8, rateOverride: 61.5 }))).toBe(61.5);
    expect(lessonExpectedAmount(parsedClass({ studentCount: 0 }), studioWithRate(55))).toBeNull();
    expect(
      lessonExpectedAmount(parsedClass({ studentCount: 8 }), {
        fullName: 'Studio',
        address: '',
        rateTiers: [{ minStudents: 1, maxStudents: 7, rate: 55 }],
      })
    ).toBeNull();
  });
});

describe('CalendarTab mobile presentation', () => {
  const studios = { Studio: studioWithRate(55) };
  const classes: ParsedClass[] = [
    parsedClass({ date: '2026-08-24', studentCount: 8, startTime: '17:00' }),
    parsedClass({ date: '2026-08-18', studentCount: 6, startTime: '09:00' }),
  ];

  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-08-24T12:00:00+02:00') }));

  it('starts in Month without the former view-toggle row', () => {
    render(<CalendarTab layout="mobile" classes={classes} studios={studios} />);

    expect(document.querySelector('[aria-label="Month calendar"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Calendar view"]')).toBeNull();
    expect(document.querySelector('[aria-label="Agenda"]')).toBeNull();
  });

  it('selects the first loaded lesson when an initially empty past month receives cache data', () => {
    setTestTime(new Date('2026-09-01T12:00:00+02:00'));
    const view = render(<CalendarTab layout="mobile" classes={[]} studios={studios} />);
    expect(namedButton('August 1, 2026').getAttribute('aria-pressed')).toBe('true');

    view.rerender(<CalendarTab layout="mobile" classes={classes} studios={studios} />);

    expect(namedButton('August 18, 2026').getAttribute('aria-pressed')).toBe('true');
  });

  it('does not replace a date the user selected before cache data arrives', async () => {
    setTestTime(new Date('2026-09-01T12:00:00+02:00'));
    const view = render(<CalendarTab layout="mobile" classes={[]} studios={studios} />);
    await click(namedButton('August 3, 2026'));

    view.rerender(<CalendarTab layout="mobile" classes={classes} studios={studios} />);

    expect(document.body.textContent).toContain('Monday, August 3, 2026');
  });

  it('distinguishes the selected today date by shape in the month grid', () => {
    render(<CalendarTab layout="mobile" classes={classes} studios={studios} />);

    const today = namedButton('August 24, 2026');
    expect(today.className).toContain('ring-slate-900');
    expect(today.className).toContain('underline');
  });

  it('names agenda lessons with their complete teaching and income context', async () => {
    render(<CalendarTab layout="mobile" classes={classes} studios={studios} />);
    await click(namedButton('August 24, 2026'));

    const lesson = namedButton(
      'Open lesson details: Studio, Flow, 17:00, 8 students, €55.00 expected'
    );
    expect(lesson.textContent).toContain('Open');
  });

  it('presents lesson editing as a sheet and keeps the shared student edit callback', async () => {
    const lesson = classes[0];
    const preflight = {
      identity: lesson.eventIdentity,
      currentDescription: lesson.sourceDescription,
      proposedDescription: '12',
      requiresConfirmation: false,
    };
    const onPrepareValueEdit = vi.fn(async () => preflight);
    const onSaveValueEdit = vi.fn(async () => {});
    render(
      <CalendarTab
        layout="mobile"
        classes={classes}
        studios={studios}
        canEdit
        onPrepareValueEdit={onPrepareValueEdit}
        onSaveValueEdit={onSaveValueEdit}
      />
    );

    await click(namedButton('August 24, 2026'));
    await click(
      namedButton('Open lesson details: Studio, Flow, 17:00, 8 students, €55.00 expected')
    );
    const details = namedElement('dialog', 'Lesson details');
    const backdrop = namedButton('Dismiss lesson details');
    const inertCalendar = document.querySelector<HTMLElement>('[inert]');
    expect(details.getAttribute('data-presentation')).toBe('sheet');
    expect(details.getAttribute('aria-modal')).toBeNull();
    expect(details.classList.contains('z-40')).toBe(true);
    expect(details.classList.contains('bottom-[var(--mobile-navigation-height)]')).toBe(true);
    expect(details.className).not.toContain('safe-area-inset-bottom');
    expect(backdrop.classList.contains('z-30')).toBe(true);
    expect(backdrop.classList.contains('bottom-[var(--mobile-navigation-height)]')).toBe(true);
    expect(inertCalendar?.contains(document.querySelector('[aria-label="Agenda"]'))).toBe(true);
    expect(inertCalendar?.contains(details)).toBe(false);
    expect(
      [...details.querySelectorAll<HTMLButtonElement>('button')].every((button) =>
        button.classList.contains('min-h-12')
      )
    ).toBe(true);

    await click(namedButton('Set Students'));
    const studentDialog = namedElement('dialog', 'Set students');
    expect(
      [...studentDialog.querySelectorAll<HTMLButtonElement>('button')].every((button) =>
        button.className.includes('min-h-12')
      )
    ).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#lesson-students')?.className).toContain(
      'text-base'
    );
    expect(document.querySelector<HTMLInputElement>('#lesson-students')?.className).toContain(
      'min-h-12'
    );
    await typeValue(document.querySelector<HTMLInputElement>('#lesson-students')!, '12');
    await click(namedButton('Save students'));

    expect(onPrepareValueEdit).toHaveBeenCalledWith(lesson, {
      operation: 'setStudents',
      studentCount: 12,
    });
    expect(onSaveValueEdit).toHaveBeenCalledWith(preflight, false);
  });

  it('opens a month day as Agenda before its lesson can open as a bottom sheet', async () => {
    render(<CalendarTab layout="mobile" classes={classes} studios={studios} />);

    await click(namedButton('August 24, 2026'));
    expect(document.querySelector('[role="dialog"][aria-label="Lesson details"]')).toBeNull();
    await click(
      namedButton('Open lesson details: Studio, Flow, 17:00, 8 students, €55.00 expected')
    );

    const details = namedElement('dialog', 'Lesson details');
    expect(details.getAttribute('data-presentation')).toBe('sheet');
    expect(document.activeElement).toBe(details);
  });

  it('initially focuses the non-modal lesson sheet without trapping Tab', async () => {
    render(<CalendarTab layout="mobile" classes={classes} studios={studios} canEdit />);
    await click(namedButton('August 24, 2026'));
    await click(
      namedButton('Open lesson details: Studio, Flow, 17:00, 8 students, €55.00 expected')
    );
    const details = namedElement('dialog', 'Lesson details');
    expect(document.activeElement).toBe(details);

    const backwardTab = await pressTab(true);
    expect(backwardTab.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(details);

    namedButton('Set Euros…').focus();
    const forwardTab = await pressTab();
    expect(forwardTab.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(namedButton('Set Euros…'));
  });

  it('shows the empty selected-day state while retaining month navigation', async () => {
    render(<CalendarTab layout="mobile" classes={classes} studios={studios} />);

    await click(namedButton('August 23, 2026'));
    expect(document.body.textContent).toContain('No lessons on this day');
    expect(namedButton('Previous month')).toBeTruthy();
    expect(namedButton('Next month')).toBeTruthy();
  });

  it('gives month-day buttons 48-pixel minimum touch-target utilities', () => {
    render(<CalendarTab layout="mobile" classes={classes} studios={studios} />);

    const day = namedButton('August 24, 2026');
    expect(day.className).toContain('min-h-12');
    expect(day.className).toContain('min-w-12');
  });

  it('marks unconfigured month dates without treating them as configured studios', async () => {
    const configured = parsedClass({
      date: '2026-08-06',
      eventIdentity: { calendarId: 'fixture-calendar', eventId: 'configured-6' },
    });
    const unconfiguredClasses = [
      parsedClass({
        date: '2026-08-12',
        studioName: 'Unknown One',
        unconfigured: true,
        eventIdentity: { calendarId: 'fixture-calendar', eventId: 'unconfigured-12-a' },
      }),
      parsedClass({
        date: '2026-08-12',
        studioName: 'Unknown Two',
        unconfigured: true,
        eventIdentity: { calendarId: 'fixture-calendar', eventId: 'unconfigured-12-b' },
      }),
    ];
    const mixed = [
      parsedClass({
        date: '2026-08-21',
        eventIdentity: { calendarId: 'fixture-calendar', eventId: 'configured-21' },
      }),
      parsedClass({
        date: '2026-08-21',
        studioName: 'Unknown Three',
        unconfigured: true,
        eventIdentity: { calendarId: 'fixture-calendar', eventId: 'unconfigured-21' },
      }),
    ];
    const view = render(
      <CalendarTab
        layout="mobile"
        classes={[configured, ...unconfiguredClasses, ...mixed]}
        studios={studios}
      />
    );

    const configuredDay = namedButton('August 6, 2026');
    const unconfiguredDay = namedButton('August 12, 2026, 2 incomplete classes');
    const mixedDay = namedButton('August 21, 2026, 1 incomplete class');
    expect(configuredDay.querySelectorAll('[style]')).toHaveLength(1);
    expect(configuredDay.querySelector('[data-unconfigured-marker="true"]')).toBeNull();
    expect(unconfiguredDay.querySelectorAll('[style]')).toHaveLength(0);
    expect(unconfiguredDay.querySelectorAll('[data-unconfigured-marker="true"]')).toHaveLength(1);
    expect(mixedDay.querySelectorAll('[style]')).toHaveLength(1);
    expect(mixedDay.querySelectorAll('[data-unconfigured-marker="true"]')).toHaveLength(1);

    const monthCalendar = document.querySelector('[aria-label="Month calendar"]');
    const markers = monthCalendar?.querySelectorAll<SVGSVGElement>(
      '[data-unconfigured-marker="true"]'
    );
    expect(markers).toHaveLength(2);
    for (const marker of markers ?? []) {
      expect(marker.tagName.toLowerCase()).toBe('svg');
      expect(marker.getAttribute('aria-hidden')).toBe('true');
      expect(marker.getAttribute('viewBox')).toBe('0 0 12 12');
      expect(marker.classList.contains('h-3')).toBe(true);
      expect(marker.classList.contains('w-3')).toBe(true);
      expect(marker.classList.contains('top-[3px]')).toBe(true);
      expect(marker.classList.contains('right-[3px]')).toBe(true);
      const circle = marker.querySelectorAll('circle');
      const cross = marker.querySelectorAll('path');
      expect(circle).toHaveLength(1);
      expect(circle[0].getAttribute('cx')).toBe('6');
      expect(circle[0].getAttribute('cy')).toBe('6');
      expect(circle[0].getAttribute('r')).toBe('6');
      expect(circle[0].getAttribute('fill')).toBe('#dc2626');
      expect(cross).toHaveLength(1);
      expect(cross[0].getAttribute('fill')).toBe('white');
      expect(cross[0].getAttribute('d')).toBe(
        'M3.88 2.82 6 4.94 8.12 2.82 9.18 3.88 7.06 6 9.18 8.12 8.12 9.18 6 7.06 3.88 9.18 2.82 8.12 4.94 6 2.82 3.88Z'
      );
    }

    const legend = document.querySelector('[aria-label="Studio legend"]');
    expect(legend?.textContent).toContain('Studio');
    expect(legend?.textContent).toContain('Unconfigured');
    expect(legend?.textContent).not.toContain('Unknown');
    expect(legend?.querySelectorAll('[data-unconfigured-marker="true"]')).toHaveLength(0);
    expect(
      [...(legend?.querySelectorAll('span') ?? [])].filter(
        (entry) => entry.textContent?.trim() === 'Unconfigured'
      )
    ).toHaveLength(1);

    view.rerender(<CalendarTab layout="mobile" classes={[configured]} studios={studios} />);
    expect(namedButton('August 6, 2026')).toBeTruthy();
    expect(document.querySelector('[aria-label="Studio legend"]')?.textContent).not.toContain(
      'Unconfigured'
    );
  });

  it('marks past dates whose configured classes have no calculable EUR value', () => {
    const incompleteClasses = [
      parsedClass({
        date: '2026-08-08',
        studentCount: 1,
        rateOverride: 55,
        eventIdentity: { calendarId: 'fixture-calendar', eventId: 'configured-override' },
      }),
      parsedClass({
        date: '2026-08-09',
        studentCount: 0,
        eventIdentity: { calendarId: 'fixture-calendar', eventId: 'missing-students' },
      }),
      parsedClass({
        date: '2026-08-10',
        studentCount: 8,
        ambiguousStudentCount: true,
        eventIdentity: { calendarId: 'fixture-calendar', eventId: 'ambiguous-students' },
      }),
      parsedClass({
        date: '2026-08-11',
        studentCount: 1,
        eventIdentity: { calendarId: 'fixture-calendar', eventId: 'missing-rate-tier' },
      }),
    ];
    const limitedStudios = {
      Studio: {
        ...studios.Studio,
        rateTiers: [{ minStudents: 2, maxStudents: null, rate: 55 }],
      },
    };

    render(<CalendarTab layout="mobile" classes={incompleteClasses} studios={limitedStudios} />);

    expect(
      namedButton('August 8, 2026').querySelector('[data-unconfigured-marker="true"]')
    ).toBeNull();
    for (const label of [
      'August 9, 2026, 1 incomplete class',
      'August 10, 2026, 1 incomplete class',
      'August 11, 2026, 1 incomplete class',
    ]) {
      expect(namedButton(label).querySelectorAll('[data-unconfigured-marker="true"]')).toHaveLength(
        1
      );
    }
  });

  it('shows incomplete markers only for dates before today', () => {
    const incompleteClasses = [
      parsedClass({
        date: '2026-08-23',
        unconfigured: true,
        rateOverride: 55,
        eventIdentity: { calendarId: 'fixture-calendar', eventId: 'unconfigured-past' },
      }),
      parsedClass({
        date: '2026-08-24',
        studentCount: 0,
        eventIdentity: { calendarId: 'fixture-calendar', eventId: 'missing-today' },
      }),
      parsedClass({
        date: '2026-08-25',
        studentCount: 0,
        eventIdentity: { calendarId: 'fixture-calendar', eventId: 'missing-future' },
      }),
    ];

    render(<CalendarTab layout="mobile" classes={incompleteClasses} studios={studios} />);

    expect(
      namedButton('August 23, 2026, 1 incomplete class').querySelectorAll(
        '[data-unconfigured-marker="true"]'
      )
    ).toHaveLength(1);
    expect(
      namedButton('August 24, 2026, 1 incomplete class').querySelectorAll(
        '[data-unconfigured-marker="true"]'
      )
    ).toHaveLength(0);
    expect(
      namedButton('August 25, 2026, 1 incomplete class').querySelectorAll(
        '[data-unconfigured-marker="true"]'
      )
    ).toHaveLength(0);
  });

  it('keeps the agenda strip inside the displayed month at its end', async () => {
    setTestTime(new Date('2026-08-31T12:00:00+02:00'));
    render(<CalendarTab layout="mobile" classes={classes} studios={studios} />);
    await click(namedButton('August 31, 2026'));

    const labels = [...document.querySelectorAll('[aria-label="Date selector"] button')].map(
      (button) => button.getAttribute('aria-label')
    );
    expect(labels).toEqual([
      'August 25, 2026',
      'August 26, 2026',
      'August 27, 2026',
      'August 28, 2026',
      'August 29, 2026',
      'August 30, 2026',
      'August 31, 2026',
    ]);
  });

  it('preserves a valid day when month navigation reaches a shorter month', async () => {
    setTestTime(new Date('2026-08-31T12:00:00+02:00'));
    render(<CalendarTab layout="mobile" classes={classes} studios={studios} />);

    await click(namedButton('Next month'));
    expect(document.body.textContent).toContain('September 2026');
    expect(namedButton('September 30, 2026').getAttribute('aria-pressed')).toBe('true');
  });
});
