import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalendarTab } from '../../src/components/CalendarTab/index.js';
import { LogPanel } from '../../src/components/LogPanel/index.js';
import { MobileAppShell } from '../../src/components/mobile/MobileAppShell.js';
import {
  initialMobileTabState,
  selectMobileTab,
} from '../../src/components/mobile/mobile-tab-state.js';
import { calendarHistoryLevel } from '../../src/components/CalendarTab/mobile-calendar-history.js';
import type { ParsedClass, StudioConfig } from '../../src/lib/types.js';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';
import { parsedClass } from '../helpers/calendar-fixtures.js';

const restoreEnvironment = installReactTestEnvironment();
Object.defineProperties(window.HTMLElement.prototype, {
  attachEvent: { configurable: true, value: () => {} },
  detachEvent: { configurable: true, value: () => {} },
  scrollIntoView: { configurable: true, value: () => {} },
});

const roots: Array<{ root: Root; container: HTMLElement }> = [];
const baseState = { testBase: true };
let backSpy: ReturnType<typeof vi.spyOn>;
let goSpy: ReturnType<typeof vi.spyOn>;
let pushSpy: ReturnType<typeof vi.spyOn>;

const studios: Record<string, StudioConfig> = {
  Studio: {
    fullName: 'Studio',
    address: '',
    rateTiers: [{ minStudents: 1, maxStudents: null, rate: 55 }],
  },
};
const lessons: ParsedClass[] = [
  parsedClass({
    date: '2026-08-24',
    startTime: '17:00',
    studentCount: 8,
    eventIdentity: { calendarId: 'fixture-calendar', eventId: 'lesson-24' },
  }),
];
const lessonRowName = 'Open lesson details: Studio, Flow, 17:00, 8 students, €55.00 expected';

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

async function pressEscape() {
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await Promise.resolve();
  });
}

function ownerId(state: unknown): string {
  if (typeof state !== 'object' || state === null) throw new Error('Missing Calendar state');
  const calendar = (state as { lotusCalendar?: { ownerId?: unknown } }).lotusCalendar;
  if (typeof calendar?.ownerId !== 'string') throw new Error('Missing Calendar owner');
  return calendar.ownerId;
}

async function dispatchDestination(destination: unknown) {
  await act(async () => {
    window.history.replaceState(destination, '');
    window.dispatchEvent(new window.PopStateEvent('popstate', { state: destination }));
    await Promise.resolve();
  });
}

async function openAgenda(date = 'August 24, 2026') {
  await click(namedButton(date));
  return window.history.state;
}

async function openDetails() {
  await click(namedButton(lessonRowName));
  return window.history.state;
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-08-24T12:00:00+02:00') });
  window.history.replaceState(baseState, '');
  pushSpy = vi.spyOn(window.history, 'pushState');
  backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {});
  goSpy = vi.spyOn(window.history, 'go').mockImplementation(() => {});
});

afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  pushSpy.mockRestore();
  backSpy.mockRestore();
  goSpy.mockRestore();
  window.history.replaceState(baseState, '');
  vi.useRealTimers();
});

afterAll(() => restoreEnvironment());

describe('mobile Calendar forward navigation', () => {
  it('starts at Month without a toggle row and opens populated and empty days as tagged Agenda entries', async () => {
    render(<CalendarTab layout="mobile" classes={lessons} studios={studios} />);

    expect(document.querySelector('[aria-label="Month calendar"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Calendar view"]')).toBeNull();
    expect(document.querySelector('[aria-label="Agenda"]')).toBeNull();

    const populatedState = await openAgenda();
    const populatedOwner = ownerId(populatedState);
    expect(calendarHistoryLevel(populatedState, populatedOwner)).toBe('agenda');
    expect(document.body.textContent).toContain('Monday, August 24, 2026');
    expect(document.querySelector('[role="dialog"][aria-label="Lesson details"]')).toBeNull();

    await dispatchDestination(baseState);
    const emptyState = await openAgenda('August 23, 2026');
    expect(calendarHistoryLevel(emptyState, ownerId(emptyState))).toBe('agenda');
    expect(document.body.textContent).toContain('No lessons on this day');
    expect(pushSpy).toHaveBeenCalledTimes(2);
  });

  it('changes the Agenda strip date without another push and opens details only from a lesson row', async () => {
    render(<CalendarTab layout="mobile" classes={lessons} studios={studios} />);
    const agendaState = await openAgenda();
    const owner = ownerId(agendaState);

    await click(namedButton('August 23, 2026'));
    expect(document.body.textContent).toContain('No lessons on this day');
    expect(pushSpy).toHaveBeenCalledTimes(1);

    await click(namedButton('August 24, 2026'));
    const detailsState = await openDetails();
    expect(calendarHistoryLevel(detailsState, owner)).toBe('details');
    expect(namedElement('dialog', 'Lesson details')).toBeTruthy();
    expect(pushSpy).toHaveBeenCalledTimes(2);
  });
});

describe('mobile Calendar reset and responsive cleanup', () => {
  it('keeps the persistent Calendar destination focusable above details and resets from it', async () => {
    function CalendarShell() {
      const [tabState, setTabState] = useState(initialMobileTabState);
      return (
        <MobileAppShell
          activeTab={tabState.activeTab}
          onSelectTab={(tab) => setTabState((current) => selectMobileTab(current, tab))}
          calendarLoading={false}
          calendarError={null}
          onRefresh={vi.fn()}
        >
          <CalendarTab
            layout="mobile"
            mobileActivation={tabState.calendarActivation}
            classes={lessons}
            studios={studios}
          />
        </MobileAppShell>
      );
    }

    render(<CalendarShell />);
    await openAgenda();
    await openDetails();

    const calendarDestination = namedButton('Calendar');
    expect(calendarDestination.closest('[inert]')).toBeNull();
    calendarDestination.focus();
    expect(document.activeElement).toBe(calendarDestination);
    await click(calendarDestination);

    expect(document.querySelector('[aria-label="Month calendar"]')).not.toBeNull();
    expect(document.querySelector('[role="dialog"][aria-label="Lesson details"]')).toBeNull();
    expect(document.activeElement).toBe(calendarDestination);
    expect(goSpy).toHaveBeenCalledWith(-2);
  });

  it('resets Agenda to Month and traverses its one proven owned entry', async () => {
    const view = render(
      <CalendarTab layout="mobile" mobileActivation={0} classes={lessons} studios={studios} />
    );
    await openAgenda();

    view.rerender(
      <CalendarTab layout="mobile" mobileActivation={1} classes={lessons} studios={studios} />
    );

    expect(document.querySelector('[aria-label="Month calendar"]')).not.toBeNull();
    expect(goSpy).toHaveBeenCalledWith(-1);
    expect(backSpy).not.toHaveBeenCalled();
  });

  it('resets Details to Month and traverses its two proven contiguous owned entries', async () => {
    const view = render(
      <CalendarTab layout="mobile" mobileActivation={0} classes={lessons} studios={studios} />
    );
    await openAgenda();
    await openDetails();

    view.rerender(
      <CalendarTab layout="mobile" mobileActivation={1} classes={lessons} studios={studios} />
    );

    expect(document.querySelector('[aria-label="Month calendar"]')).not.toBeNull();
    expect(document.querySelector('[role="dialog"][aria-label="Lesson details"]')).toBeNull();
    expect(goSpy).toHaveBeenCalledWith(-2);
  });

  it('resets visibly without traversing a foreign current entry', async () => {
    const view = render(
      <CalendarTab layout="mobile" mobileActivation={0} classes={lessons} studios={studios} />
    );
    await openAgenda();
    window.history.replaceState({ foreignSentinel: true }, '');

    view.rerender(
      <CalendarTab layout="mobile" mobileActivation={1} classes={lessons} studios={studios} />
    );

    expect(document.querySelector('[aria-label="Month calendar"]')).not.toBeNull();
    expect(goSpy).not.toHaveBeenCalled();
  });

  it('ignores a cleanup destination and rejects the expired owner after same-mount reset', async () => {
    const view = render(
      <CalendarTab layout="mobile" mobileActivation={0} classes={lessons} studios={studios} />
    );
    const oldAgendaState = await openAgenda();
    const oldOwner = ownerId(oldAgendaState);

    view.rerender(
      <CalendarTab layout="mobile" mobileActivation={1} classes={lessons} studios={studios} />
    );
    const newAgendaState = await openAgenda();
    expect(ownerId(newAgendaState)).not.toBe(oldOwner);

    await dispatchDestination(baseState);
    expect(document.querySelector('[aria-label="Agenda"]')).not.toBeNull();

    await dispatchDestination(oldAgendaState);
    expect(document.querySelector('[aria-label="Month calendar"]')).not.toBeNull();
  });

  it('safely cleans owned history when leaving the mounted Calendar', async () => {
    const view = render(
      <CalendarTab layout="mobile" mobileActivation={0} classes={lessons} studios={studios} />
    );
    await openAgenda();

    view.rerender(<div>Invoices</div>);

    expect(goSpy).toHaveBeenCalledWith(-1);
  });

  it('invalidates and closes mobile navigation on desktop while preserving the displayed month', async () => {
    const septemberLessons = lessons.map((lesson) => ({ ...lesson, date: '2026-09-24' }));
    const view = render(
      <CalendarTab
        layout="mobile"
        mobileActivation={0}
        classes={septemberLessons}
        studios={studios}
      />
    );
    await click(namedButton('Next month'));
    await openAgenda('September 24, 2026');
    await openDetails();

    view.rerender(
      <CalendarTab
        layout="desktop"
        mobileActivation={0}
        classes={septemberLessons}
        studios={studios}
      />
    );

    expect(document.body.textContent).toContain('September 2026');
    expect(document.querySelector('[aria-label="Agenda"]')).toBeNull();
    expect(document.querySelector('[role="dialog"][aria-label="Lesson details"]')).toBeNull();
    expect(goSpy).toHaveBeenCalledWith(-2);

    const pushesBeforeDesktopSelection = pushSpy.mock.calls.length;
    await click(namedButton(/Studio, Flow/));
    expect(pushSpy).toHaveBeenCalledTimes(pushesBeforeDesktopSelection);
  });

  it('clears desktop lesson details across a mobile responsive round trip', async () => {
    const view = render(<CalendarTab layout="desktop" classes={lessons} studios={studios} />);

    await click(namedButton(/Studio, Flow/));
    expect(document.querySelector('[role="dialog"][aria-label="Lesson details"]')).not.toBeNull();

    view.rerender(<CalendarTab layout="mobile" classes={lessons} studios={studios} />);
    view.rerender(<CalendarTab layout="desktop" classes={lessons} studios={studios} />);

    expect(document.querySelector('[role="dialog"][aria-label="Lesson details"]')).toBeNull();
  });

  it('ignores delayed responsive cleanup after re-enable and a fresh Agenda', async () => {
    const view = render(
      <CalendarTab layout="mobile" mobileActivation={0} classes={lessons} studios={studios} />
    );
    await openAgenda();

    view.rerender(
      <CalendarTab layout="desktop" mobileActivation={0} classes={lessons} studios={studios} />
    );
    view.rerender(
      <CalendarTab layout="mobile" mobileActivation={0} classes={lessons} studios={studios} />
    );
    await openAgenda();

    await dispatchDestination(baseState);

    expect(document.querySelector('[aria-label="Agenda"]')).not.toBeNull();
  });

  it('consumes responsive cleanup while disabled instead of suppressing later Back', async () => {
    const view = render(
      <CalendarTab layout="mobile" mobileActivation={0} classes={lessons} studios={studios} />
    );
    await openAgenda();

    view.rerender(
      <CalendarTab layout="desktop" mobileActivation={0} classes={lessons} studios={studios} />
    );
    await dispatchDestination(baseState);
    view.rerender(
      <CalendarTab layout="mobile" mobileActivation={0} classes={lessons} studios={studios} />
    );
    await openAgenda();

    await dispatchDestination(baseState);

    expect(document.querySelector('[aria-label="Month calendar"]')).not.toBeNull();
  });

  it('returns from desktop to a Month view with a fresh owner', async () => {
    const view = render(
      <CalendarTab layout="mobile" mobileActivation={0} classes={lessons} studios={studios} />
    );
    const oldOwner = ownerId(await openAgenda());

    view.rerender(
      <CalendarTab layout="desktop" mobileActivation={0} classes={lessons} studios={studios} />
    );
    expect(goSpy).toHaveBeenCalledWith(-1);

    view.rerender(
      <CalendarTab layout="mobile" mobileActivation={0} classes={lessons} studios={studios} />
    );
    expect(document.querySelector('[aria-label="Month calendar"]')).not.toBeNull();

    expect(ownerId(await openAgenda())).not.toBe(oldOwner);
  });
});

describe('mobile Calendar destination-state Back handling', () => {
  it('moves Details to Agenda one level and restores the lesson row focus', async () => {
    render(<CalendarTab layout="mobile" classes={lessons} studios={studios} />);
    const agendaState = await openAgenda();
    await openDetails();
    const row = namedButton(lessonRowName);

    await dispatchDestination(agendaState);

    expect(document.querySelector('[role="dialog"][aria-label="Lesson details"]')).toBeNull();
    expect(document.querySelector('[aria-label="Agenda"]')).not.toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it('falls back to the Agenda heading when refreshed data removed the lesson row', async () => {
    const view = render(<CalendarTab layout="mobile" classes={lessons} studios={studios} />);
    const agendaState = await openAgenda();
    await openDetails();

    view.rerender(<CalendarTab layout="mobile" classes={[]} studios={studios} />);
    await dispatchDestination(agendaState);

    const heading = document.querySelector<HTMLHeadingElement>('[aria-label="Agenda"] h2');
    expect(heading).not.toBeNull();
    expect(document.activeElement).toBe(heading);
  });

  it('moves Agenda to base Month and restores the selected day focus', async () => {
    render(<CalendarTab layout="mobile" classes={lessons} studios={studios} />);
    await openAgenda();

    await dispatchDestination(baseState);

    const selectedDay = namedButton('August 24, 2026');
    expect(document.querySelector('[aria-label="Month calendar"]')).not.toBeNull();
    expect(document.activeElement).toBe(selectedDay);
  });

  it('ignores destination events while already at Month', async () => {
    render(<CalendarTab layout="mobile" classes={lessons} studios={studios} />);

    await dispatchDestination(baseState);

    expect(document.querySelector('[aria-label="Month calendar"]')).not.toBeNull();
    expect(backSpy).not.toHaveBeenCalled();
    expect(goSpy).not.toHaveBeenCalled();
  });

  it.each(['close', 'backdrop', 'Escape'] as const)(
    'waits for one Back destination after explicit %s dismissal',
    async (dismissal) => {
      render(<CalendarTab layout="mobile" classes={lessons} studios={studios} />);
      const agendaState = await openAgenda();
      await openDetails();

      if (dismissal === 'close') await click(namedButton('Close lesson details'));
      else if (dismissal === 'backdrop') await click(namedButton('Dismiss lesson details'));
      else await pressEscape();

      expect(backSpy).toHaveBeenCalledTimes(1);
      expect(namedElement('dialog', 'Lesson details')).toBeTruthy();

      await dispatchDestination(agendaState);
      expect(document.querySelector('[role="dialog"][aria-label="Lesson details"]')).toBeNull();
    }
  );

  it('bridges a foreign top before reopened details can traverse back to Agenda', async () => {
    render(<CalendarTab layout="mobile" classes={lessons} studios={studios} />);
    const originalAgendaState = await openAgenda();
    const owner = ownerId(originalAgendaState);
    await openDetails();
    window.history.replaceState({ foreignTop: true }, '');

    await click(namedButton('Close lesson details'));

    expect(backSpy).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"][aria-label="Lesson details"]')).toBeNull();
    expect(document.querySelector('[aria-label="Agenda"]')).not.toBeNull();

    await openDetails();
    expect(pushSpy).toHaveBeenCalledTimes(4);
    const agendaBridge = pushSpy.mock.calls[2][0];
    expect(calendarHistoryLevel(agendaBridge, owner)).toBe('agenda');
    expect(calendarHistoryLevel(window.history.state, owner)).toBe('details');

    await click(namedButton('Close lesson details'));
    expect(backSpy).toHaveBeenCalledTimes(1);
    await dispatchDestination(agendaBridge);

    expect(document.querySelector('[role="dialog"][aria-label="Lesson details"]')).toBeNull();
    expect(document.querySelector('[aria-label="Agenda"]')).not.toBeNull();
    expect(document.activeElement).toBe(namedButton(lessonRowName));
  });

  it('coalesces repeated details dismissal into one Back request', async () => {
    render(<CalendarTab layout="mobile" classes={lessons} studios={studios} />);
    const agendaState = await openAgenda();
    await openDetails();

    await click(namedButton('Close lesson details'));
    await click(namedButton('Dismiss lesson details'));

    expect(backSpy).toHaveBeenCalledTimes(1);
    await dispatchDestination(agendaState);
  });

  it('lets Logs consume its Agenda destination before Calendar returns to base Month', async () => {
    render(
      <>
        <CalendarTab layout="mobile" classes={lessons} studios={studios} />
        <LogPanel layout="mobile" />
      </>
    );
    const agendaState = await openAgenda();
    await click(namedButton('Open logs'));
    expect(namedElement('dialog', 'Application logs')).toBeTruthy();

    await dispatchDestination(agendaState);
    expect(document.querySelector('[role="dialog"][aria-label="Application logs"]')).toBeNull();
    expect(document.querySelector('[aria-label="Agenda"]')).not.toBeNull();

    await dispatchDestination(baseState);
    expect(document.querySelector('[aria-label="Month calendar"]')).not.toBeNull();
  });
});
