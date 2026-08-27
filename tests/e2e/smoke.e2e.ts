import { expect, browser, $, $$ } from '@wdio/globals';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { e2eConfigPath, fakeGoogleControlUrl } from './helpers.js';

const WELCOME_DIALOG =
  '//*[@role="dialog"][@aria-labelledby][.//*[normalize-space(.)="Welcome to Lotus"]]';

async function readDriveConfig(): Promise<Record<string, unknown>> {
  const response = await fetch(`${fakeGoogleControlUrl()}/state`);
  expect(response.status).toBe(200);
  const state = (await response.json()) as {
    files: Array<{ name: string; properties: Record<string, string>; bytesBase64: string }>;
  };
  const files = state.files.filter(
    (file) =>
      file.name === 'lotus-invoices-config.yaml' && file.properties.lotusConfigSchema === '1'
  );
  expect(files).toHaveLength(1);
  return parse(Buffer.from(files[0]!.bytesBase64, 'base64').toString('utf8')) as Record<
    string,
    unknown
  >;
}

describe('Boot', () => {
  before(async () => {
    const seeded = (await browser.executeAsync(
      (value, done) => {
        window
          .__LOTUS_E2E__!.seedRuntime(value)
          .then(done)
          .catch((error) => done({ error: String(error) }));
      },
      {
        configYaml: readFileSync(e2eConfigPath(), 'utf8'),
        calendarId: 'teaching@example.test',
        authorization: {
          accessToken: 'e2e-access-token',
          refreshToken: 'e2e-refresh-token',
          expiresAt: 4_102_444_800_000,
          authorizationVersion: 1,
          grantedScopes: [
            'https://www.googleapis.com/auth/gmail.compose',
            'https://www.googleapis.com/auth/calendar.readonly',
            'https://www.googleapis.com/auth/calendar.events',
            'https://www.googleapis.com/auth/drive',
          ],
        },
        events: [],
        syncToken: 'smoke-sync-1',
        syncedAt: '2026-08-15T10:00:00.000Z',
      }
    )) as { error?: string };
    expect(seeded.error).toBeUndefined();
    await browser.refresh();
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

  it('persists the name change to the Drive YAML after Save', async () => {
    await $('button=Save').click();
    await browser.pause(1000);
    const cfg = (await readDriveConfig()) as { teacher: { name: string } };
    expect(cfg.teacher.name).toBe('E2E Updated Teacher');
  });

  it('adds a new studio and saves it to the Drive YAML', async () => {
    const before = Object.keys(((await readDriveConfig()) as { studios: object }).studios).length;
    await $('button*=Add studio').click();
    await browser.pause(300);
    await $('button=Save').click();
    await browser.pause(1000);
    const after = Object.keys(((await readDriveConfig()) as { studios: object }).studios).length;
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
