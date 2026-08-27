import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';

const restoreDom = installReactTestEnvironment();
const roots: Array<{ root: Root; container: HTMLElement }> = [];

function render(ui: ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ root, container });
  act(() => root.render(ui));
}

function namedButton(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => (element.getAttribute('aria-label') ?? element.textContent ?? '').trim() === name
  );
  if (!button) throw new Error(`Missing button named ${name}`);
  return button;
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});
afterAll(() => restoreDom());

const { MobileNavigation } = await import('../../src/components/mobile/MobileNavigation.js');
const { MobileAppShell } = await import('../../src/components/mobile/MobileAppShell.js');
const { initialMobileTabState, selectMobileTab } =
  await import('../../src/components/mobile/mobile-tab-state.js');

describe('mobile tab state', () => {
  it('increments activation for every Calendar selection and no other destination', () => {
    expect(initialMobileTabState).toEqual({ activeTab: 'calendar', calendarActivation: 0 });

    const firstCalendar = selectMobileTab(initialMobileTabState, 'calendar');
    const secondCalendar = selectMobileTab(firstCalendar, 'calendar');
    const invoices = selectMobileTab(secondCalendar, 'invoices');
    const income = selectMobileTab(invoices, 'income');
    const rates = selectMobileTab(income, 'rates');

    expect(firstCalendar).toEqual({ activeTab: 'calendar', calendarActivation: 1 });
    expect(secondCalendar).toEqual({ activeTab: 'calendar', calendarActivation: 2 });
    expect(invoices).toEqual({ activeTab: 'invoices', calendarActivation: 2 });
    expect(income).toEqual({ activeTab: 'income', calendarActivation: 2 });
    expect(rates).toEqual({ activeTab: 'rates', calendarActivation: 2 });
  });
});

describe('MobileNavigation', () => {
  it('selects all four mobile destinations, including the active Calendar', async () => {
    const onSelect = vi.fn();
    render(<MobileNavigation activeTab="calendar" onSelect={onSelect} />);

    await click(namedButton('Calendar'));
    await click(namedButton('Invoices'));
    await click(namedButton('Income'));
    await click(namedButton('Settings'));

    expect(onSelect.mock.calls.map(([tab]) => tab)).toEqual([
      'calendar',
      'invoices',
      'income',
      'rates',
    ]);
    expect(namedButton('Calendar').getAttribute('aria-current')).toBe('page');
    expect(namedButton('Invoices').getAttribute('aria-current')).toBeNull();
    expect(namedButton('Calendar').classList.contains('font-semibold')).toBe(true);
    expect(namedButton('Invoices').classList.contains('font-semibold')).toBe(false);
    expect(document.querySelector('nav')?.getAttribute('aria-label')).toBe('Mobile navigation');
  });

  it('cannot select disabled destinations and exposes native disabled semantics', async () => {
    const onSelect = vi.fn();
    render(
      <MobileNavigation
        activeTab="rates"
        onSelect={onSelect}
        disabledTabs={['calendar', 'invoices', 'income']}
      />
    );
    for (const name of ['Calendar', 'Invoices', 'Income']) {
      const destination = namedButton(name);
      expect(destination.disabled).toBe(true);
      expect(destination.querySelector('[data-lock]')).toBeTruthy();
      await click(destination);
    }
    expect(namedButton('Settings').disabled).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('MobileAppShell', () => {
  it('retries a calendar error', async () => {
    const onRefresh = vi.fn();
    render(
      <MobileAppShell
        activeTab="calendar"
        onSelectTab={vi.fn()}
        calendarLoading={false}
        calendarError="Calendar quota exceeded"
        onRefresh={onRefresh}
      >
        <div>Calendar</div>
      </MobileAppShell>
    );

    await click(namedButton('Retry calendar sync'));

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('suppresses Calendar refresh and Calendar errors while setup is blocked', () => {
    render(
      <MobileAppShell
        activeTab="rates"
        onSelectTab={vi.fn()}
        disabledTabs={['calendar', 'invoices', 'income']}
        calendarActionsEnabled={false}
        calendarLoading={false}
        calendarError="No calendar configured"
        onRefresh={vi.fn()}
      >
        <div>Settings</div>
      </MobileAppShell>
    );
    expect(document.body.textContent).not.toContain('No calendar configured');
    expect(namedButton('Refresh calendar').disabled).toBe(true);
  });

  it('reports syncing while keeping the active destination', () => {
    render(
      <MobileAppShell
        activeTab="invoices"
        onSelectTab={vi.fn()}
        calendarLoading
        calendarError={null}
        onRefresh={vi.fn()}
      >
        <div>Invoices</div>
      </MobileAppShell>
    );

    expect(namedButton('Syncing').disabled).toBe(true);
    expect(namedButton('Invoices').getAttribute('aria-current')).toBe('page');
    expect(
      document.querySelector('svg.animate-spin')?.classList.contains('motion-reduce:animate-none')
    ).toBe(true);
  });

  it('defines one navigation height for content clearance and the persistent z-50 navigation', () => {
    render(
      <MobileAppShell
        activeTab="calendar"
        onSelectTab={vi.fn()}
        calendarLoading={false}
        calendarError={null}
        onRefresh={vi.fn()}
      >
        <div>Calendar content</div>
      </MobileAppShell>
    );

    const shell = document.querySelector<HTMLElement>('[data-layout="mobile"]')!;
    const content = shell.querySelector<HTMLElement>('main')!;
    const navigation = shell.querySelector<HTMLElement>('nav[aria-label="Mobile navigation"]')!;
    expect(document.documentElement.style.getPropertyValue('--mobile-navigation-height')).toBe(
      'calc(3rem + max(env(safe-area-inset-bottom), 1.5rem))'
    );
    expect(content.style.paddingBottom).toBe('var(--mobile-navigation-height)');
    expect(navigation.parentElement?.classList.contains('z-50')).toBe(true);
    expect(navigation.parentElement?.style.paddingBottom).toBe(
      'max(env(safe-area-inset-bottom), 1.5rem)'
    );
  });

  it('returns the content scroller to the top when changing destinations', () => {
    const shell = (activeTab: 'calendar' | 'invoices') => (
      <MobileAppShell
        activeTab={activeTab}
        onSelectTab={vi.fn()}
        calendarLoading={false}
        calendarError={null}
        onRefresh={vi.fn()}
      >
        <div>{activeTab}</div>
      </MobileAppShell>
    );

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push({ root, container });
    act(() => root.render(shell('calendar')));
    const content = container.querySelector('main')!;
    content.scrollTop = 240;

    act(() => root.render(shell('invoices')));

    expect(content.scrollTop).toBe(0);
  });
});
