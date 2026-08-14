import { describe, expect, it, vi } from 'vitest';
import { AppConfig } from '../../src/lib/types.js';

(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = 'test';
(globalThis as unknown as { __APP_IS_OFFICIAL__: boolean }).__APP_IS_OFFICIAL__ = false;

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
  it('formats a structured Tauri Calendar error for stable display', async () => {
    const { calendarPickerErrorMessage } = await import('../../src/components/RatesTab/index.js');
    const message = calendarPickerErrorMessage({
      code: 'rateLimited',
      message: 'Calendar quota exceeded',
    });

    expect(message).toBe('Calendar quota exceeded (rateLimited)');
    expect(message).not.toBe('[object Object]');
  });
});
