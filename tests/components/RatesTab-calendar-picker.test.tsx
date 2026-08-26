import React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';
import type { AppConfig } from '../../src/lib/types.js';

const mocks = {
  listCalendars: vi.fn(),
};

vi.mock('../../src/lib/calendar/calendar-api.js', () => ({
  listCalendars: mocks.listCalendars,
  calendarErrorMessage: (error: unknown) => String(error),
}));

(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = 'test';
(globalThis as unknown as { __APP_IS_OFFICIAL__: boolean }).__APP_IS_OFFICIAL__ = false;
(globalThis as unknown as { React: typeof React }).React = React;

const restoreDom = installReactTestEnvironment();
afterAll(() => restoreDom());
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { RatesTab } = await import('../../src/components/RatesTab/index.js');

const config: AppConfig = {
  teacher: {
    name: 'Teacher',
    address: '',
    taxNumber: '',
    bankDetails: { accountOwner: '', iban: '', bic: '' },
  },
  studios: {},
};

beforeEach(() => {
  mocks.listCalendars.mockReset();
  mocks.listCalendars.mockResolvedValue([]);
});

afterEach(() => cleanup());

describe('RatesTab calendar picker authorization', () => {
  it('requests interactive Google authorization from an explicit Pick calendar tap', async () => {
    const view = render(
      <RatesTab
        layout="mobile"
        config={config}
        isDirty={false}
        saveError={null}
        onUpdate={vi.fn()}
        onSave={vi.fn(async () => undefined)}
      />
    );

    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Pick calendar' }));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(mocks.listCalendars).toHaveBeenCalledWith(undefined, { interactive: true })
    );
  });
});
