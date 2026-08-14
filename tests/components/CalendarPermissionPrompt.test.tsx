import React from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';

const restoreDom = installReactTestEnvironment();
afterAll(() => restoreDom());
const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react');
const userEvent = (await import('@testing-library/user-event')).default;
const { CalendarPermissionPrompt } =
  await import('../../src/components/CalendarPermissionPrompt.js');

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

afterEach(() => cleanup());
