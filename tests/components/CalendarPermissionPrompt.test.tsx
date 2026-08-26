import React from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';

const restoreDom = installReactTestEnvironment();
afterAll(() => restoreDom());
const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react');
const userEvent = (await import('@testing-library/user-event')).default;
const { CalendarPermissionPrompt } =
  await import('../../src/components/CalendarPermissionPrompt.js');
const { LogPanel } = await import('../../src/components/LogPanel/index.js');
const { clearLog, logInfo } = await import('../../src/lib/logger.js');

function renderScopePrompt(overrides: Record<string, unknown> = {}) {
  const onAllow = vi.fn();
  const onDismiss = vi.fn();
  const view = render(
    <CalendarPermissionPrompt
      open
      reason="scopeMissing"
      onAllow={onAllow}
      onDismiss={onDismiss}
      {...overrides}
    />
  );
  return { ...view, onAllow, onDismiss };
}

describe('CalendarPermissionPrompt', () => {
  it('stays scrollable within a 390-pixel dynamic viewport and wraps its actions', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    renderScopePrompt();

    const dialog = screen.getByRole('dialog');
    expect(dialog.classList.contains('max-h-[calc(100dvh-2rem)]')).toBe(true);
    expect(dialog.classList.contains('overflow-y-auto')).toBe(true);
    expect(screen.getByTestId('calendar-permission-actions').classList.contains('flex-wrap')).toBe(
      true
    );
    expect(
      [...dialog.querySelectorAll('button')].every((button) =>
        button.classList.contains('min-h-12')
      )
    ).toBe(true);
  });

  it('renders a labelled real modal and initially focuses the exact primary action', async () => {
    renderScopePrompt();

    const dialog = screen.getByRole('dialog');
    const primary = screen.getByRole('button', {
      name: 'Allow calendar editing to make changes',
    });

    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(primary));
  });

  it('starts the write upgrade only from the primary action', async () => {
    const { onAllow, onDismiss } = renderScopePrompt();

    fireEvent.click(screen.getByRole('button', { name: 'Allow calendar editing to make changes' }));

    expect(onAllow).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('keeps a retryable authorization error visible with an enabled retry action', () => {
    const { onAllow } = renderScopePrompt({
      error: 'Authorization response did not include all required scopes and tokens',
    });

    expect(
      screen.getByText('Authorization response did not include all required scopes and tokens')
    ).toBeTruthy();
    const retry = screen.getByRole('button', {
      name: 'Allow calendar editing to make changes',
    });
    expect(retry.hasAttribute('disabled')).toBe(false);

    fireEvent.click(retry);
    expect(onAllow).toHaveBeenCalledOnce();
  });

  it.each([
    ['Not now', () => fireEvent.click(screen.getByRole('button', { name: 'Not now' }))],
    ['close', () => fireEvent.click(screen.getByRole('button', { name: 'Close' }))],
    ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
  ])('dismisses without starting OAuth via %s', (_label, dismiss) => {
    const { onAllow, onDismiss } = renderScopePrompt();

    dismiss();

    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onAllow).not.toHaveBeenCalled();
  });

  it('returns focus to the action that opened it', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Edit lesson';
    document.body.append(opener);
    opener.focus();
    const view = renderScopePrompt();
    await waitFor(() => expect(document.activeElement).not.toBe(opener));

    view.rerender(
      <CalendarPermissionPrompt
        open={false}
        reason="scopeMissing"
        onAllow={view.onAllow}
        onDismiss={view.onDismiss}
      />
    );

    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('moves focus inside when authorizing starts and traps Tab in the enabled controls', async () => {
    const user = userEvent.setup({ document });
    const background = document.createElement('button');
    background.textContent = 'Background action';
    document.body.append(background);
    background.focus();
    const onAllow = vi.fn();
    const onDismiss = vi.fn();
    const view = render(
      <CalendarPermissionPrompt
        open={false}
        reason="scopeMissing"
        onAllow={onAllow}
        onDismiss={onDismiss}
      />
    );

    view.rerender(
      <CalendarPermissionPrompt
        open
        reason="scopeMissing"
        isAuthorizing
        onAllow={onAllow}
        onDismiss={onDismiss}
      />
    );

    const dialog = screen.getByRole('dialog');
    const close = screen.getByRole('button', { name: 'Close' });
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(close);

    view.rerender(
      <CalendarPermissionPrompt
        open={false}
        reason="scopeMissing"
        isAuthorizing
        onAllow={onAllow}
        onDismiss={onDismiss}
      />
    );
    expect(document.activeElement).toBe(background);
    background.remove();
  });

  it('explains fresh non-writable or unknown roles without offering OAuth', () => {
    render(
      <CalendarPermissionPrompt
        open
        reason="calendarReadOnly"
        onAllow={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    expect(screen.getByText('You only have read access to this calendar')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Allow calendar editing to make changes' })
    ).toBeNull();
  });
});

describe('mobile LogPanel', () => {
  it('opens the modal stateful sheet, contains focus, and restores it after Escape', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    logInfo('Focus containment test');
    render(<LogPanel layout="mobile" />);
    const opener = screen.getByRole('button', { name: 'Open logs' });
    opener.focus();

    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Application logs' });
    const clear = screen.getByRole('button', { name: 'Clear logs' });
    const close = screen.getByRole('button', { name: 'Close logs' });
    const backdrop = [...document.body.querySelectorAll<HTMLElement>('div')].find((element) =>
      element.classList.contains('bg-black/40')
    );
    expect(dialog).toBeTruthy();
    expect(clear).toBeTruthy();
    expect(close).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(clear));
    expect(opener.classList.contains('z-20')).toBe(true);
    expect(backdrop?.classList.contains('z-60')).toBe(true);
    expect(dialog.classList.contains('z-70')).toBe(true);
    expect(dialog.classList.contains('bottom-[var(--mobile-navigation-height)]')).toBe(true);

    const backwardTab = new window.KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(document, backwardTab);
    expect(backwardTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);

    const forwardTab = new window.KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    fireEvent(document, forwardTab);
    expect(forwardTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(clear);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Application logs' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(historyBack).toHaveBeenCalledOnce();
  });

  it('closes the stateful sheet from its backdrop and restores focus', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    render(<LogPanel layout="mobile" />);
    const opener = screen.getByRole('button', { name: 'Open logs' });
    opener.focus();

    fireEvent.click(opener);
    const backdrop = [...document.body.querySelectorAll<HTMLElement>('div')].find((element) =>
      element.classList.contains('bg-black/40')
    );
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);

    expect(screen.queryByRole('dialog', { name: 'Application logs' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(historyBack).toHaveBeenCalledOnce();
  });

  it('closes the stateful sheet and restores focus on Android Back popstate', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    render(<LogPanel layout="mobile" />);
    const opener = screen.getByRole('button', { name: 'Open logs' });
    opener.focus();

    fireEvent.click(opener);
    expect(screen.getByRole('dialog', { name: 'Application logs' })).toBeTruthy();
    fireEvent.popState(window);

    expect(screen.queryByRole('dialog', { name: 'Application logs' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});

afterEach(() => {
  cleanup();
  clearLog();
  vi.restoreAllMocks();
});
