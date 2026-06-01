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
