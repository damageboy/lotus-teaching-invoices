import { expect, browser, $ } from '@wdio/globals';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { TMP_CONFIG_PATH } from './helpers.js';

function readTmpConfig() {
  return parse(readFileSync(TMP_CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
}

// ─── Boot ────────────────────────────────────────────────────────────────────

describe('Boot', () => {
  before(async () => {
    await browser.pause(2000);
  });

  it('renders the three tab buttons', async () => {
    await expect($('button=Calendar')).toBeDisplayed();
    await expect($('button=Invoices')).toBeDisplayed();
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
    await expect($('label=Name')).toBeDisplayed();
  });

  it('shows "Unsaved changes" after editing the Name field', async () => {
    const nameInput = await $('label=Name').$('input');
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
