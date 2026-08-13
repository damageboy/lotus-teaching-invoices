// @vitest-environment jsdom

import { JSDOM } from 'jsdom';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppConfig } from '../../src/lib/types.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = 'test';
(globalThis as unknown as { __APP_IS_OFFICIAL__: boolean }).__APP_IS_OFFICIAL__ = false;

const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperties(globalThis, {
  window: { value: dom.window, configurable: true },
  document: { value: dom.window.document, configurable: true },
  navigator: { value: dom.window.navigator, configurable: true },
});

const { cleanup, fireEvent, render } = await import('@testing-library/react');

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
    Studio: {
      fullName: 'Studio',
      address: '',
      invoiceEmail: '',
      rateTiers: [{ minStudents: 1, maxStudents: null, rate: 50 }],
    },
  },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderRatesTab(testConfig: AppConfig = config) {
  const { RatesTab } = await import('../../src/components/RatesTab/index.js');
  const onUpdate = vi.fn();
  const onSave = vi.fn(async () => undefined);

  const view = render(
    React.createElement(RatesTab, {
      config: testConfig,
      isDirty: false,
      saveError: null,
      onUpdate,
      onSave,
    })
  );
  fireEvent.click(view.getByText('Studio'));

  return {
    ...view,
    input: view.getByLabelText('Studio name: Studio') as HTMLInputElement,
    onUpdate,
  };
}

describe('selectCalendar', () => {
  it('updates and persists the selected calendar config', async () => {
    const onUpdate = vi.fn();
    const onSave = vi.fn(async () => undefined);
    const closeCalendarList = vi.fn();
    const { selectCalendar } = await import('../../src/components/RatesTab/index.js');

    await selectCalendar(
      config,
      'calendar-1',
      'Teaching Calendar',
      onUpdate,
      onSave,
      closeCalendarList
    );

    const expected = {
      ...config,
      calendarId: 'calendar-1',
      calendarName: 'Teaching Calendar',
    };

    expect(onUpdate).toHaveBeenCalledWith(expected);
    expect(onSave).toHaveBeenCalledWith(expected);
    expect(closeCalendarList).toHaveBeenCalledWith(null);
  });
});

describe('studio name input', () => {
  it('shows an inline error and does not update config for an empty normalized name', async () => {
    const { input, onUpdate, getByText } = await renderRatesTab();

    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);

    expect(getByText('Studio name cannot be empty.')).toBeTruthy();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('shows an inline error and does not update config for a duplicate normalized name', async () => {
    const duplicateConfig: AppConfig = {
      ...config,
      studios: {
        ...config.studios,
        Other: { ...config.studios.Studio, fullName: 'Other' },
      },
    };
    const { input, onUpdate, getByText } = await renderRatesTab(duplicateConfig);

    fireEvent.change(input, { target: { value: ' Other ' } });
    fireEvent.blur(input);

    expect(getByText('A studio named "Other" already exists.')).toBeTruthy();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('normalizes the current name as a valid no-op', async () => {
    const { input, onUpdate, queryByText } = await renderRatesTab();

    fireEvent.change(input, { target: { value: '  Studio  ' } });
    fireEvent.blur(input);

    expect(input.value).toBe('Studio');
    expect(onUpdate).not.toHaveBeenCalled();
    expect(queryByText(/Studio name cannot|already exists/)).toBeNull();
  });

  it('clears a stale error and updates config with a normalized valid name', async () => {
    const { input, onUpdate, getByText, queryByText } = await renderRatesTab();

    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);
    expect(getByText('Studio name cannot be empty.')).toBeTruthy();

    fireEvent.change(input, { target: { value: '  New Studio  ' } });
    fireEvent.blur(input);

    expect(input.value).toBe('New Studio');
    expect(queryByText('Studio name cannot be empty.')).toBeNull();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith({
      ...config,
      studios: { 'New Studio': config.studios.Studio },
    });
  });
});
