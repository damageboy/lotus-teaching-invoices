import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/lib/types.js';

(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = 'test';
(globalThis as unknown as { __APP_IS_OFFICIAL__: boolean }).__APP_IS_OFFICIAL__ = false;
(globalThis as unknown as { React: typeof React }).React = React;

const { MobileRateTiers, MobileSettings, StudioCard } =
  await import('../../src/components/RatesTab/MobileSettings.js');
const { VersionBadge } = await import('../../src/components/VersionBadge.js');

const config: AppConfig = {
  teacher: {
    name: 'Teacher',
    address: 'Street 1',
    taxNumber: '12/345/67890',
    bankDetails: { accountOwner: 'Teacher', iban: 'DE123', bic: 'ABCDEF' },
  },
  calendarId: 'opaque-calendar-id',
  studios: {
    Studio: {
      fullName: 'Studio GmbH',
      address: 'Studio Street 2',
      invoiceEmail: 'studio@example.com',
      rateTiers: [{ minStudents: 1, maxStudents: null, rate: 50 }],
    },
  },
};

function mobileSettingsProps() {
  return {
    config,
    isDirty: true,
    saveError: null,
    connections: React.createElement('section', null, 'Connections'),
    onSave: vi.fn(async () => undefined),
    onUpdateTeacher: vi.fn(),
    onUpdateBank: vi.fn(),
    onRenameStudio: vi.fn(),
    onDeleteStudio: vi.fn(),
    onUpdateTier: vi.fn(),
    onAddTier: vi.fn(),
    onRemoveTier: vi.fn(),
    onUpdateStudioField: vi.fn(),
    onUpdateStudioColor: vi.fn(),
    onAddStudio: vi.fn(),
  };
}

describe('VersionBadge', () => {
  it('shows the shared version and development status', () => {
    const html = renderToStaticMarkup(React.createElement(VersionBadge));
    const document = new JSDOM(html).window.document;

    expect(document.querySelector('[data-testid="version-badge"]')?.textContent).toContain('vtest');
    expect(document.body.textContent).toContain('dev');
    expect(document.body.textContent).not.toContain('dirty');
  });
});

describe('MobileSettings', () => {
  it('keeps every existing section in one column with touch-safe controls and actions', () => {
    const html = renderToStaticMarkup(React.createElement(MobileSettings, mobileSettingsProps()));
    const document = new JSDOM(html).window.document;

    for (const section of ['Connections', 'Teacher', 'Bank details', 'Studios and rates']) {
      expect(document.body.textContent).toContain(section);
    }
    expect(html.indexOf('Connections')).toBeLessThan(html.indexOf('Teacher'));
    expect(document.body.textContent).not.toContain('Last invoice number');
    expect(document.body.textContent).not.toContain('output folder');

    const save = document.querySelector<HTMLButtonElement>('button[aria-label="Save settings"]');
    expect(save).toBeTruthy();
    expect(save?.classList.contains('min-h-12')).toBe(true);
    expect(
      [...document.querySelectorAll('input, textarea, select')].every((control) =>
        control.classList.contains('text-base')
      )
    ).toBe(true);
    expect(
      document
        .querySelector('[data-testid="mobile-settings-save-bar"]')
        ?.classList.contains('sticky')
    ).toBe(true);
  });

  it('stacks tier fields without a forced width or horizontal scroller', () => {
    const html = renderToStaticMarkup(
      React.createElement(MobileRateTiers, {
        studioName: 'Studio',
        tiers: [
          { minStudents: 1, maxStudents: 4, rate: 40 },
          { minStudents: 5, maxStudents: null, rate: 50 },
        ],
        onUpdateTier: vi.fn(),
        onRemoveTier: vi.fn(),
      })
    );
    const document = new JSDOM(html).window.document;
    const tiers = document.querySelector('[data-testid="mobile-rate-tiers"]');

    expect(tiers).toBeTruthy();
    expect(tiers?.classList.contains('overflow-x-auto')).toBe(false);
    expect(html).not.toContain('min-w-[21rem]');
    expect(document.body.textContent).toContain('Min students');
    expect(document.body.textContent).toContain('Max students');
    expect(document.body.textContent).toContain('Rate (€)');
    expect(
      document.querySelector<HTMLInputElement>('[aria-label="Tier 1 minimum students"]')?.disabled
    ).toBe(true);
    expect(
      document.querySelector<HTMLInputElement>('[aria-label="Tier 2 maximum students"]')?.disabled
    ).toBe(true);
    expect(
      [...document.querySelectorAll('input')].every((input) =>
        input.classList.contains('text-base')
      )
    ).toBe(true);
    expect(
      [...document.querySelectorAll('button')].every((button) =>
        button.classList.contains('min-h-12')
      )
    ).toBe(true);
  });

  it('uses a semantic studio disclosure with contextual destructive naming', () => {
    const html = renderToStaticMarkup(
      React.createElement(StudioCard, {
        layout: 'mobile',
        studioName: 'Studio',
        studio: mobileSettingsProps().config.studios.Studio,
        onRename: vi.fn(),
        onDelete: vi.fn(),
        onUpdateTier: vi.fn(),
        onAddTier: vi.fn(),
        onRemoveTier: vi.fn(),
        onUpdateColor: vi.fn(),
        onUpdateField: vi.fn(),
      })
    );
    const document = new JSDOM(html).window.document;
    const disclosure = document.querySelector<HTMLButtonElement>(
      'button[aria-controls="studio-settings-studio"]'
    );

    expect(disclosure).toBeTruthy();
    expect(disclosure?.getAttribute('aria-expanded')).toBe('false');
    expect(disclosure?.className).toContain('min-h-12');
    expect(document.querySelector('button[aria-label="Delete Studio"]')).toBeTruthy();
  });
});
