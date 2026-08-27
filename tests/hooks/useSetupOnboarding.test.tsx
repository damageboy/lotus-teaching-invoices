import { afterAll, describe, expect, it } from 'vitest';
import type { SetupReadiness } from '../../src/lib/setup/readiness.js';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';

const restoreDom = installReactTestEnvironment();
afterAll(() => restoreDom());
const { act, renderHook } = await import('@testing-library/react');
const { useSetupOnboarding } = await import('../../src/hooks/useSetupOnboarding.js');

const calendarMissing: SetupReadiness = {
  status: 'incomplete',
  calendarConfigured: false,
  driveConfigured: false,
  firstIncompleteStep: 'calendar',
};
const driveMissing: SetupReadiness = {
  status: 'incomplete',
  calendarConfigured: true,
  driveConfigured: false,
  firstIncompleteStep: 'drive',
};
const ready: SetupReadiness = {
  status: 'ready',
  calendarConfigured: true,
  driveConfigured: true,
  firstIncompleteStep: null,
};

describe('useSetupOnboarding', () => {
  it('opens at the first incomplete step and dismisses only for the mounted session', () => {
    const { result, unmount } = renderHook(() => useSetupOnboarding(calendarMissing));
    expect(result.current).toMatchObject({ open: true, step: 'calendar', dismissed: false });
    act(() => result.current.dismiss());
    expect(result.current).toMatchObject({ open: false, dismissed: true });
    unmount();

    const fresh = renderHook(() => useSetupOnboarding(calendarMissing));
    expect(fresh.result.current.open).toBe(true);
  });

  it('advances from Calendar to Drive when readiness changes', () => {
    const view = renderHook(({ readiness }) => useSetupOnboarding(readiness), {
      initialProps: { readiness: calendarMissing },
    });
    view.rerender({ readiness: driveMissing });
    expect(view.result.current).toMatchObject({ open: true, step: 'drive' });
  });

  it('closes synchronously when setup becomes ready', () => {
    const view = renderHook(({ readiness }) => useSetupOnboarding(readiness), {
      initialProps: { readiness: driveMissing },
    });
    view.rerender({ readiness: ready });
    expect(view.result.current.open).toBe(false);
  });
});
