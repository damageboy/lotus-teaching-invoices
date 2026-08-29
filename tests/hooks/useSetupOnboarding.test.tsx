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
  driveConfigured: true,
  firstIncompleteStep: 'calendar',
};
const driveMissing: SetupReadiness = {
  status: 'incomplete',
  calendarConfigured: false,
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

  it('advances from Drive to Calendar when the selected config still needs one', () => {
    const view = renderHook(({ readiness }) => useSetupOnboarding(readiness), {
      initialProps: { readiness: driveMissing },
    });
    view.rerender({ readiness: calendarMissing });
    expect(view.result.current).toMatchObject({ open: true, step: 'calendar' });
  });

  it('closes when setup becomes ready after the required Drive confirmation', () => {
    const view = renderHook(({ readiness }) => useSetupOnboarding(readiness), {
      initialProps: { readiness: driveMissing },
    });
    view.rerender({ readiness: ready });
    expect(view.result.current).toMatchObject({ open: false, step: 'drive' });
  });

  it('does not request acknowledgement for an already-configured cold start', () => {
    const { result } = renderHook(() => useSetupOnboarding(ready));

    expect(result.current).toMatchObject({ open: false });
  });
});
