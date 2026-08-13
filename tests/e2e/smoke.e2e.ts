import { expect, browser, $ } from '@wdio/globals';
import { TMP_CONFIG_PATH, readTmpConfig } from './helpers.js';

// ─── Boot ────────────────────────────────────────────────────────────────────

describe('Boot', () => {
  before(async () => {
    await browser.pause(2000);
  });

  it('renders the tab buttons', async () => {
    await expect($('button=Calendar')).toBeDisplayed();
    await expect($('button=Invoices')).toBeDisplayed();
    await expect($('button=Income')).toBeDisplayed();
    await expect($('button=Rates & Config')).toBeDisplayed();
  });
});

// ─── Calendar tab ────────────────────────────────────────────────────────────

describe('Calendar tab', () => {
  before(async () => {
    await $('button=Calendar').click();
    await browser.pause(300);
  });

  it('shows a month heading', async () => {
    const heading = await $('h2');
    const text = await heading.getText();
    // Matches e.g. "February 2026"
    expect(text).toMatch(/^[A-Z][a-z]+ \d{4}$/);
  });

  it('navigates to the previous month on ‹ click', async () => {
    const heading = await $('h2');
    const before = await heading.getText();
    await $('button=‹').click();
    const after = await heading.getText();
    expect(after).not.toBe(before);
  });

  it('navigates to the next month on › click', async () => {
    const heading = await $('h2');
    const before = await heading.getText();
    await $('button=›').click();
    const after = await heading.getText();
    expect(after).not.toBe(before);
  });

  it('shows the Refresh button', async () => {
    await expect($('button*=Refresh')).toBeDisplayed();
  });
});

// ─── Invoices tab ────────────────────────────────────────────────────────────

describe('Invoices tab', () => {
  before(async () => {
    await $('button=Invoices').click();
    await browser.pause(300);
  });

  it('shows "No classes loaded" when calendar is empty', async () => {
    await expect($('td=No classes loaded')).toBeDisplayed();
  });

  it('shows "not set" for the output folder', async () => {
    await expect($('span=not set')).toBeDisplayed();
  });

  it('has a "Change folder…" button', async () => {
    await expect($('button=Change folder\u2026')).toBeDisplayed();
  });
});

// ─── Rates & Config tab ──────────────────────────────────────────────────────

describe('Rates & Config tab', () => {
  before(async () => {
    await $('button=Rates & Config').click();
    await browser.pause(500);
  });

  it('renders the Name label', async () => {
    await expect($('label*=Name')).toBeDisplayed();
  });

  it('shows "Unsaved changes" after editing the Name field', async () => {
    const nameInput = await $('label*=Name').$('input');
    await nameInput.clearValue();
    await nameInput.setValue('E2E Updated Teacher');
    await expect($('span=Unsaved changes')).toBeDisplayed();
  });

  it('persists the name change to the YAML file after Save', async () => {
    await $('button=Save').click();
    await browser.pause(1000);
    const cfg = readTmpConfig() as { teacher: { name: string } };
    expect(cfg.teacher.name).toBe('E2E Updated Teacher');
  });

  it('adds a new studio and saves it to the YAML file', async () => {
    const before = Object.keys((readTmpConfig() as { studios: object }).studios).length;
    await $('button*=Add studio').click();
    await browser.pause(300);
    await $('button=Save').click();
    await browser.pause(1000);
    const after = Object.keys((readTmpConfig() as { studios: object }).studios).length;
    expect(after).toBe(before + 1);
  });

  it('validates, trims, and persists a renamed studio', async () => {
    const saved = readTmpConfig() as { studios: Record<string, unknown> };
    const generatedName = Object.keys(saved.studios).find((name) => name !== 'Test Studio');
    expect(generatedName).toBeDefined();

    await $(`span=${generatedName}`).click();
    let input = await $(`input[aria-label="Studio name: ${generatedName}"]`);

    await input.click();
    await input.setValue('   ');
    await $('input[placeholder="e.g. Yogibar Yoga Studio GmbH"]').click();
    await expect($('span=Studio name cannot be empty.')).toBeDisplayed();
    await expect($(`input[aria-label="Studio name: ${generatedName}"]`)).toBeDisplayed();

    input = await $(`input[aria-label="Studio name: ${generatedName}"]`);
    await input.click();
    await input.setValue(' Test Studio ');
    await $('input[placeholder="e.g. Yogibar Yoga Studio GmbH"]').click();
    await expect($('.text-red-500')).toHaveText('A studio named "Test Studio" already exists.');
    await expect($(`input[aria-label="Studio name: ${generatedName}"]`)).toBeDisplayed();

    input = await $(`input[aria-label="Studio name: ${generatedName}"]`);
    await input.click();
    await input.setValue('  Trimmed Studio  ');
    await $('input[placeholder="e.g. Yogibar Yoga Studio GmbH"]').click();
    const normalizedInput = await $('input[aria-label="Studio name: Trimmed Studio"]');
    await expect(normalizedInput).toHaveValue('Trimmed Studio');
    await expect($('span=Studio name cannot be empty.')).not.toBeDisplayed();
    await expect($('.text-red-500')).not.toBeDisplayed();
    await expect($('span=Unsaved changes')).toBeDisplayed();

    await $('button=Save').click();
    await browser.pause(1000);
    const persisted = readTmpConfig() as { studios: Record<string, unknown> };
    expect(Object.keys(persisted.studios)).toContain('Trimmed Studio');
    expect(Object.keys(persisted.studios)).not.toContain('  Trimmed Studio  ');
    expect(Object.keys(persisted.studios)).not.toContain(generatedName);
  });

  it('shows the version badge', async () => {
    const badge = await $('[data-testid="version-badge"]');
    await expect(badge).toBeDisplayed();
    const text = await badge.getText();
    // Should start with 'v' followed by non-whitespace (semver, commit hash, or 'unknown')
    expect(text).toMatch(/^v\S/);
  });
});

// ─── Log panel ───────────────────────────────────────────────────────────────

describe('Log panel', () => {
  it('opens the log drawer on click', async () => {
    await $('button*=▲').click();
    await expect($('.bg-gray-950')).toBeDisplayed();
  });

  it('closes the log drawer on a second click', async () => {
    await $('button*=▼').click();
    await expect($('.bg-gray-950')).not.toBeDisplayed();
  });
});
