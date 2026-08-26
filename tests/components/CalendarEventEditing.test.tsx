import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';
import { parsedClass } from '../helpers/calendar-fixtures.js';

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
}

function namedElement(role: string, name: string | RegExp): HTMLElement {
  const match = [...document.querySelectorAll<HTMLElement>(`[role="${role}"],${role}`)].find(
    (element) => {
      const accessibleName = element.getAttribute('aria-label') ?? element.textContent ?? '';
      return typeof name === 'string' ? accessibleName.trim() === name : name.test(accessibleName);
    }
  );
  if (!match) throw new Error(`Missing ${role} named ${String(name)}`);
  return match;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
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

afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});
afterAll(() => restoreEnvironment());

const { CalendarTab } = await import('../../src/components/CalendarTab/index.js');

function visibleDate(): string {
  const now = new Date();
  const usePrevious = now.getDate() <= 15;
  const date = new Date(now.getFullYear(), now.getMonth() - (usePrevious ? 1 : 0), 16);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-16`;
}

describe('calendar occurrence editing', () => {
  it('opens a lesson card and reassigns this occurrence to a configured studio', async () => {
    const lesson = parsedClass({
      date: visibleDate(),
      studioName: 'Old Studio',
      classType: 'Flow',
      sourceSummary: 'Old Studio / Flow',
      eventIdentity: {
        calendarId: 'calendar-1',
        eventId: 'event-1',
        etag: 'etag-1',
      },
    });
    const onReassignStudio = vi.fn(async () => {});
    render(
      <CalendarTab
        classes={[lesson]}
        studios={{
          'Old Studio': { fullName: 'Old Studio', address: '', rateTiers: [] },
          'New Studio': { fullName: 'New Studio', address: '', rateTiers: [] },
        }}
        canEdit
        onReassignStudio={onReassignStudio}
      />
    );

    await click(namedElement('button', /Old Studio.*Flow/i));
    expect(namedElement('dialog', 'Lesson details')).toBeTruthy();

    await click(namedElement('button', 'Fix Studio'));
    await click(namedElement('menuitem', 'New Studio'));

    expect(onReassignStudio).toHaveBeenCalledWith(lesson, 'New Studio');
    expect(document.querySelector('[role="dialog"][aria-label="Lesson details"]')).toBeNull();
  });

  it('keeps the lesson card open and shows a save conflict', async () => {
    const lesson = parsedClass({
      date: visibleDate(),
      studioName: 'Old Studio',
      classType: 'Flow',
    });
    render(
      <CalendarTab
        classes={[lesson]}
        studios={{
          'Old Studio': { fullName: 'Old Studio', address: '', rateTiers: [] },
          'New Studio': { fullName: 'New Studio', address: '', rateTiers: [] },
        }}
        canEdit
        onReassignStudio={async () => {
          throw { code: 'conflict', message: 'This lesson changed. Refresh and try again.' };
        }}
      />
    );
    await click(namedElement('button', /Old Studio.*Flow/i));
    await click(namedElement('button', 'Fix Studio'));
    await click(namedElement('menuitem', 'New Studio'));

    expect(namedElement('alert', /This lesson changed/).textContent).toContain(
      'This lesson changed. Refresh and try again.'
    );
    expect(namedElement('dialog', 'Lesson details')).toBeTruthy();
  });

  it('returns focus to the lesson when the details card closes', async () => {
    const lesson = parsedClass({
      date: visibleDate(),
      studioName: 'Old Studio',
      classType: 'Flow',
    });
    render(<CalendarTab classes={[lesson]} studios={{}} canEdit={false} />);
    const chip = namedElement('button', /Old Studio.*Flow/i);

    await click(chip);
    await click(namedElement('button', 'Close lesson details'));

    expect(document.activeElement).toBe(chip);
  });

  it('sets a positive student count and saves without warning for a supported description', async () => {
    const lesson = parsedClass({
      date: visibleDate(),
      studentCount: 5,
      sourceDescription: '5/30EUR',
    });
    const preflight = {
      identity: lesson.eventIdentity,
      currentDescription: '5/30EUR',
      proposedDescription: '12/30EUR',
      requiresConfirmation: false,
    };
    const onPrepareValueEdit = vi.fn(async () => preflight);
    const onSaveValueEdit = vi.fn(async () => {});
    render(
      <CalendarTab
        classes={[lesson]}
        studios={{}}
        canEdit
        onPrepareValueEdit={onPrepareValueEdit}
        onSaveValueEdit={onSaveValueEdit}
      />
    );

    await click(namedElement('button', /Studio.*Flow/i));
    await click(namedElement('button', 'Set Students'));
    const input = document.querySelector<HTMLInputElement>('#lesson-students')!;
    expect(document.activeElement).toBe(input);
    await typeValue(input, '12');
    await click(namedElement('button', 'Save students'));

    expect(onPrepareValueEdit).toHaveBeenCalledWith(lesson, {
      operation: 'setStudents',
      studentCount: 12,
    });
    expect(onSaveValueEdit).toHaveBeenCalledWith(preflight, false);
  });

  it('disables euros until students are valid', async () => {
    const lesson = parsedClass({ date: visibleDate(), studentCount: 0 });
    render(<CalendarTab classes={[lesson]} studios={{}} canEdit />);
    await click(namedElement('button', /Studio.*Flow/i));

    expect((namedElement('button', 'Set Euros…') as HTMLButtonElement).disabled).toBe(true);
  });

  it('validates the student input and returns focus when its modal closes', async () => {
    const lesson = parsedClass({ date: visibleDate(), studentCount: 5 });
    render(<CalendarTab classes={[lesson]} studios={{}} canEdit />);
    await click(namedElement('button', /Studio.*Flow/i));
    const opener = namedElement('button', 'Set Students');
    await click(opener);
    await typeValue(document.querySelector<HTMLInputElement>('#lesson-students')!, '0');

    expect((namedElement('button', 'Save students') as HTMLButtonElement).disabled).toBe(true);
    expect(namedElement('alert', 'Enter a positive whole number.')).toBeTruthy();
    await act(async () => {
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await Promise.resolve();
    });
    expect(document.querySelector('[role="dialog"][aria-label="Set students"]')).toBeNull();
    expect(namedElement('dialog', 'Lesson details')).toBeTruthy();
    expect(document.activeElement).toBe(opener);
  });

  it('keeps nested lesson editing dialogs within the dynamic viewport', async () => {
    const lesson = parsedClass({ date: visibleDate(), studentCount: 5 });
    render(<CalendarTab classes={[lesson]} studios={{}} canEdit />);

    await click(namedElement('button', /Studio.*Flow/i));
    await click(namedElement('button', 'Set Students'));

    const dialog = namedElement('dialog', 'Set students');
    expect(dialog.className).toContain('max-h-[calc(100dvh-2rem)]');
    expect(dialog.className).toContain('overflow-y-auto');
  });

  it('warns before replacing an unsupported description', async () => {
    const lesson = parsedClass({
      date: visibleDate(),
      studentCount: 5,
      sourceDescription: 'students: 5',
    });
    const preflight = {
      identity: lesson.eventIdentity,
      currentDescription: 'students: 5',
      proposedDescription: '9',
      requiresConfirmation: true,
    };
    const onSaveValueEdit = vi.fn(async () => {});
    render(
      <CalendarTab
        classes={[lesson]}
        studios={{}}
        canEdit
        onPrepareValueEdit={async () => preflight}
        onSaveValueEdit={onSaveValueEdit}
      />
    );
    await click(namedElement('button', /Studio.*Flow/i));
    await click(namedElement('button', 'Set Students'));
    await typeValue(document.querySelector<HTMLInputElement>('#lesson-students')!, '9');
    await click(namedElement('button', 'Save students'));

    expect(namedElement('dialog', 'Replace calendar description?').textContent).toContain(
      'students: 5'
    );
    expect(onSaveValueEdit).not.toHaveBeenCalled();
    await click(namedElement('button', 'Replace description'));
    expect(onSaveValueEdit).toHaveBeenCalledWith(preflight, true);
  });

  it('sets and clears the euro override for a lesson with students', async () => {
    const lesson = parsedClass({
      date: visibleDate(),
      studentCount: 9,
      sourceDescription: '9',
    });
    const euroPreflight = {
      identity: lesson.eventIdentity,
      currentDescription: '9',
      proposedDescription: '9/30.5EUR',
      requiresConfirmation: false,
    };
    const configuredPreflight = {
      ...euroPreflight,
      currentDescription: '9/30.5EUR',
      proposedDescription: '9',
    };
    const onPrepareValueEdit = vi
      .fn()
      .mockResolvedValueOnce(euroPreflight)
      .mockResolvedValueOnce(configuredPreflight);
    const onSaveValueEdit = vi.fn(async () => {});
    render(
      <CalendarTab
        classes={[lesson]}
        studios={{}}
        canEdit
        onPrepareValueEdit={onPrepareValueEdit}
        onSaveValueEdit={onSaveValueEdit}
      />
    );
    await click(namedElement('button', /Studio.*Flow/i));
    await click(namedElement('button', 'Set Euros…'));
    await typeValue(document.querySelector<HTMLInputElement>('#lesson-euros')!, '30.50');
    await click(namedElement('button', 'Save euros'));
    expect(onPrepareValueEdit).toHaveBeenCalledWith(lesson, {
      operation: 'setEuroOverride',
      studentCount: 9,
      euroOverride: '30.50',
    });

    // Render a fresh details card for the configured-rate action because a successful save closes it.
    render(
      <CalendarTab
        classes={[{ ...lesson, rateOverride: 30.5, sourceDescription: '9/30.5EUR' }]}
        studios={{}}
        canEdit
        onPrepareValueEdit={onPrepareValueEdit}
        onSaveValueEdit={onSaveValueEdit}
      />
    );
    const chips = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label*="Studio"]')];
    await click(chips[chips.length - 1]);
    await click(namedElement('button', 'Set Euros…'));
    await click(namedElement('button', 'Use configured rate'));
    expect(onPrepareValueEdit).toHaveBeenLastCalledWith(expect.anything(), {
      operation: 'useConfiguredRate',
      studentCount: 9,
    });
  });

  it('confirms the impact before reassigning an entire recurring series', async () => {
    const lesson = parsedClass({
      date: visibleDate(),
      studioName: 'Old Studio',
      eventIdentity: {
        calendarId: 'calendar-1',
        eventId: 'instance-1',
        recurringEventId: 'master-1',
        originalStartTime: '2026-08-16T09:00:00+02:00',
        etag: 'instance-etag',
      },
    });
    const preflight = {
      calendarId: 'calendar-1',
      selectedEventId: 'instance-1',
      masterEventId: 'master-1',
      masterEtag: 'master-etag',
      currentSummary: 'Old Studio / Flow',
      proposedSummary: 'New Studio / Flow',
      instanceCount: 4,
      titleExceptionCount: 1,
    };
    const onPrepareSeriesStudioEdit = vi.fn(async () => preflight);
    const onSaveSeriesStudioEdit = vi.fn(async () => false);
    render(
      <CalendarTab
        classes={[lesson]}
        studios={{
          'Old Studio': { fullName: 'Old', address: '', rateTiers: [] },
          'New Studio': { fullName: 'New', address: '', rateTiers: [] },
        }}
        canEdit
        onReassignStudio={async () => {}}
        onPrepareSeriesStudioEdit={onPrepareSeriesStudioEdit}
        onSaveSeriesStudioEdit={onSaveSeriesStudioEdit}
      />
    );
    await click(namedElement('button', /Old Studio.*Flow/i));
    await click(namedElement('button', 'Fix Studio'));
    await click(namedElement('menuitem', 'New Studio'));
    expect(namedElement('dialog', 'Reassign recurring lesson')).toBeTruthy();

    await click(namedElement('button', 'Entire series'));
    expect(onPrepareSeriesStudioEdit).toHaveBeenCalledWith(lesson, 'New Studio');
    expect(namedElement('dialog', 'Update entire series?').textContent).toContain(
      'update 3 of 4 loaded lessons'
    );
    expect(namedElement('dialog', 'Update entire series?').textContent).toContain(
      '1 custom title exception'
    );

    await click(namedElement('button', 'Update entire series'));
    expect(onSaveSeriesStudioEdit).toHaveBeenCalledWith(preflight);
  });

  it('can limit a recurring studio change to this event', async () => {
    const lesson = parsedClass({
      date: visibleDate(),
      studioName: 'Old Studio',
      eventIdentity: {
        calendarId: 'calendar-1',
        eventId: 'instance-1',
        recurringEventId: 'master-1',
        etag: 'instance-etag',
      },
    });
    const onReassignStudio = vi.fn(async () => {});
    render(
      <CalendarTab
        classes={[lesson]}
        studios={{
          'Old Studio': { fullName: 'Old', address: '', rateTiers: [] },
          'New Studio': { fullName: 'New', address: '', rateTiers: [] },
        }}
        canEdit
        onReassignStudio={onReassignStudio}
      />
    );
    await click(namedElement('button', /Old Studio.*Flow/i));
    await click(namedElement('button', 'Fix Studio'));
    await click(namedElement('menuitem', 'New Studio'));
    await click(namedElement('button', 'This event'));

    expect(onReassignStudio).toHaveBeenCalledWith(lesson, 'New Studio');
  });
});
