import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AppConfig } from '../../src/lib/types.js';

(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = 'test';
(globalThis as unknown as { __APP_IS_OFFICIAL__: boolean }).__APP_IS_OFFICIAL__ = false;
(globalThis as unknown as { React: typeof React }).React = React;

const config: AppConfig = {
  teacher: {
    name: 'Teacher',
    address: '',
    taxNumber: '',
    bankDetails: { accountOwner: '', iban: '', bic: '' },
  },
  studios: {
    Studio: {
      fullName: 'Studio',
      address: '',
      invoiceEmail: '',
      rateTiers: [{ minStudents: 1, maxStudents: null, rate: 50 }],
    },
  },
};

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
      'writer',
      onUpdate,
      onSave,
      closeCalendarList
    );

    const expected = {
      ...config,
      calendarId: 'calendar-1',
      calendarName: 'Teaching Calendar',
      calendarAccessRole: 'writer',
    };

    expect(onUpdate).toHaveBeenCalledWith(expected);
    expect(onSave).toHaveBeenCalledWith(expected);
    expect(closeCalendarList).toHaveBeenCalledWith(null);
  });

  it('omits an unvalidated role so the selected calendar remains serializable', async () => {
    const onUpdate = vi.fn();
    const onSave = vi.fn(async () => undefined);
    const closeCalendarList = vi.fn();
    const { selectCalendar } = await import('../../src/components/RatesTab/index.js');

    await selectCalendar(
      { ...config, calendarAccessRole: 'owner' },
      'calendar-1',
      'Future Calendar',
      undefined,
      onUpdate,
      onSave,
      closeCalendarList
    );

    const selected = onSave.mock.calls[0][0];
    expect(selected).not.toHaveProperty('calendarAccessRole');
    expect(JSON.parse(JSON.stringify(selected))).not.toHaveProperty('calendarAccessRole');
  });
});

describe('RatesTab calendar picker', () => {
  it('uses the matching calendar name for a legacy config without exposing its opaque ID', async () => {
    const opaqueCalendarId = 'afba7cedbe03060b5a536c3637d379c891f93c3afa7b8b';
    const { selectedCalendarDisplayName } = await import('../../src/components/RatesTab/index.js');

    const displayName = selectedCalendarDisplayName(
      { calendarId: opaqueCalendarId },
      [{ id: opaqueCalendarId, summary: 'Classes', accessRole: 'owner' }],
      false
    );

    expect(displayName).toBe('Classes');
    expect(displayName).not.toContain(opaqueCalendarId);
    expect(selectedCalendarDisplayName({ calendarId: opaqueCalendarId }, null, false)).toBe(
      'Selected calendar'
    );
  });

  it('formats a structured Tauri Calendar error for stable display', async () => {
    const { calendarPickerErrorMessage } = await import('../../src/components/RatesTab/index.js');
    const message = calendarPickerErrorMessage({
      code: 'rateLimited',
      message: 'Calendar quota exceeded',
    });

    expect(message).toBe('Calendar quota exceeded (rateLimited)');
    expect(message).not.toBe('[object Object]');
  });

  it('loads the human calendar name into mobile Settings without rendering the legacy ID', async () => {
    const opaqueCalendarId = 'afba7cedbe03060b5a536c3637d379c891f93c3afa7b8b';
    const calendarListResponse = [
      { id: opaqueCalendarId, summary: 'Classes', accessRole: 'owner' },
    ] as const;
    const { RatesTab, selectedCalendarDisplayName } =
      await import('../../src/components/RatesTab/index.js');
    const calendarName = selectedCalendarDisplayName(
      { calendarId: opaqueCalendarId },
      calendarListResponse,
      false
    );

    const html = renderToStaticMarkup(
      React.createElement(RatesTab, {
        layout: 'mobile',
        config: { ...config, calendarId: opaqueCalendarId, calendarName },
        isDirty: true,
        saveError: null,
        onUpdate: vi.fn(),
        onSave: vi.fn(async () => undefined),
      })
    );

    expect(html).toContain('Classes');
    expect(html).not.toContain(opaqueCalendarId);
    expect(html).toContain('aria-label="Save settings"');
    expect(html).not.toContain('Last invoice number');
    expect(html).not.toContain('output folder');
  });
});
