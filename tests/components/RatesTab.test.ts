import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CalendarPickerController } from '../../src/hooks/useCalendarPicker.js';
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

describe('RatesTab calendar picker', () => {
  it('renders the controller display name without exposing the opaque Calendar ID', async () => {
    const opaqueCalendarId = 'afba7cedbe03060b5a536c3637d379c891f93c3afa7b8b';
    const { RatesTab } = await import('../../src/components/RatesTab/index.js');
    const calendarPicker: CalendarPickerController = {
      calendars: [{ id: opaqueCalendarId, summary: 'Classes', accessRole: 'owner' }],
      listOpen: false,
      loading: false,
      saving: false,
      error: null,
      selectedName: 'Classes',
      openList: vi.fn(async () => undefined),
      select: vi.fn(async () => undefined),
      closeList: vi.fn(),
    };

    const html = renderToStaticMarkup(
      React.createElement(RatesTab, {
        layout: 'mobile',
        config: { ...config, calendarId: opaqueCalendarId },
        calendarPicker,
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
