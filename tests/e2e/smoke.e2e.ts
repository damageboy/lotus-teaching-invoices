import { expect, browser, $, $$ } from '@wdio/globals';
import { readTmpConfig } from './helpers.js';

const WELCOME_DIALOG =
  '//*[@role="dialog"][@aria-labelledby][.//*[normalize-space(.)="Welcome to Lotus"]]';

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

  it('keeps the desktop shell at the 800-pixel E2E viewport', async () => {
    await expect($('[data-layout="desktop"]')).toBeDisplayed();
    await expect($('[aria-label="Mobile navigation"]')).not.toBeExisting();
  });

  it('opens required setup on Calendar without exposing invoice errors', async () => {
    const welcome = await $(WELCOME_DIALOG);
    await expect(welcome).toBeDisplayed();
    await expect(welcome.$('button=Pick calendar…')).toBeDisplayed();
    await expect($('button=Invoices')).toBeDisabled();
    expect(
      await browser.execute(() =>
        document.body.innerText.includes('invoice input contains unbillable classes')
      )
    ).toBe(false);
  });
});

describe('Rates & Config tab', () => {
  before(async () => {
    const welcome = await $(WELCOME_DIALOG);
    await welcome.$('button=Set up later').click();
    await browser.pause(500);
  });

  it('dismisses only to Rates & Config and keeps other destinations locked', async () => {
    await expect($('h2=Rates & Config')).toBeDisplayed();
    await expect($('button=Calendar')).toBeDisabled();
    await expect($('button=Invoices')).toBeDisabled();
    await expect($('button=Income')).toBeDisabled();
    await expect($('button=Rates & Config')).toBeEnabled();
    const headings = await $$('h3');
    expect(await headings[0]!.getText()).toBe('Connections');
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

  it('shows the version badge', async () => {
    const badge = await $('[data-testid="version-badge"]');
    await expect(badge).toBeDisplayed();
    const text = await badge.getText();
    expect(text).toMatch(/^v\S/);
  });
});

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

describe('Incomplete restart', () => {
  it('opens required setup again after a dismissed incomplete restart', async () => {
    await browser.refresh();
    const welcome = await $(WELCOME_DIALOG);
    await expect(welcome).toBeDisplayed();
    await expect(welcome.$('button=Pick calendar…')).toBeDisplayed();
  });
});
