import { browser, expect, $ } from '@wdio/globals';
import { readdirSync } from 'node:fs';
import { parse, stringify } from 'yaml';
import {
  editingConfigYaml,
  e2eConfigPath,
  e2eRunRoot,
  fakeGoogleControlUrl,
  readTmpConfig,
} from './helpers.js';

const CALENDAR_ID = 'teaching@example.test';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

async function configureFixtureDriveRoot(): Promise<void> {
  const response = await fetch(`${fakeGoogleControlUrl()}/mutate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'drivePatch',
      fileId: 'control-1',
      patch: {
        bytesBase64: Buffer.from(editingConfigWithSecondStudio()).toString('base64'),
      },
    }),
  });
  expect(response.status).toBe(204);
}

async function waitForLessonDetailsToClose(action: string): Promise<void> {
  await browser.waitUntil(
    async () => !(await $('[role="dialog"][aria-label="Lesson details"]').isExisting()),
    { timeout: 10_000, timeoutMsg: `${action} did not finish closing the lesson details` }
  );
}

function editingConfigWithSecondStudio(): string {
  const config = parse(editingConfigYaml()) as Record<string, any>;
  config.studios['New Studio'] = {
    fullName: 'New Studio GmbH',
    address: 'Second Street 2, Test City',
    rateTiers: [{ minStudents: 1, maxStudents: null, rate: 50 }],
  };
  return stringify(config);
}

const seed = {
  configYaml: editingConfigWithSecondStudio(),
  calendarId: CALENDAR_ID,
  driveConfigPointerRaw: JSON.stringify({ version: 1, configFileId: 'control-1' }),
  authorization: {
    accessToken: 'e2e-access-token',
    refreshToken: 'e2e-refresh-token',
    expiresAt: 4_102_444_800_000,
    authorizationVersion: 1,
    grantedScopes: [
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events',
      DRIVE_SCOPE,
    ],
  },
  events: [
    {
      eventId: 'seeded-before-sync',
      recurringEventId: null,
      originalStartTime: null,
      etag: '"seed-v1"',
      summary: 'Test Studio / Seeded',
      description: '5',
      start: '2026-08-16T09:00:00+02:00',
      end: '2026-08-16T10:00:00+02:00',
      updated: '2026-08-01T09:00:00.000Z',
      status: 'confirmed',
    },
  ],
  syncToken: 'sync-0',
  syncedAt: '2026-08-15T10:00:00.000Z',
};

const declineSeed = {
  ...seed,
  authorization: {
    ...seed.authorization,
    grantedScopes: [
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/calendar.readonly',
      DRIVE_SCOPE,
    ],
  },
  events: [
    {
      eventId: 'cached-decline-lesson',
      recurringEventId: null,
      originalStartTime: null,
      etag: '"cached-decline-v1"',
      summary: 'Test Studio / Cached decline lesson',
      description: '5',
      start: '2026-08-19T09:00:00+02:00',
      end: '2026-08-19T10:00:00+02:00',
      updated: '2026-08-01T09:00:00.000Z',
      status: 'confirmed',
    },
  ],
};

interface RuntimeStatus {
  dataRoot: string;
  configPath: string;
  authRecordPresent: boolean;
  cachedEventCount: number;
  syncStatePresent: boolean;
  writeCapable: boolean;
  pendingEditJournalPath: string;
}

describe('Calendar editing isolated bootstrap', () => {
  before(async () => {
    const reset = await fetch(`${fakeGoogleControlUrl()}/reset`, { method: 'POST' });
    expect(reset.status).toBe(204);
    await configureFixtureDriveRoot();
  });

  it('exposes the webdriver-only seed bridge', async () => {
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => typeof window.__LOTUS_E2E__?.seedRuntime)) === 'function',
      { timeout: 5_000, timeoutMsg: 'webdriver-only bridge was not installed' }
    );
  });

  it('seeds only the isolated root and syncs exclusively with fake Google', async () => {
    const seeded = (await browser.executeAsync((seedValue, done) => {
      window
        .__LOTUS_E2E__!.seedRuntime(seedValue)
        .then(done)
        .catch((error) => done({ error: String(error) }));
    }, seed)) as RuntimeStatus & { error?: string };
    expect(seeded.error).toBeUndefined();
    expect(seeded.dataRoot).toBe(`${e2eRunRoot()}/app-data`);
    expect(seeded.configPath).toBe(e2eConfigPath());
    expect(seeded.authRecordPresent).toBe(true);
    expect(seeded.cachedEventCount).toBe(1);
    expect(seeded.syncStatePresent).toBe(true);
    expect(seeded.writeCapable).toBe(true);
    expect(seeded.pendingEditJournalPath).toBe(
      `${seeded.dataRoot}/calendar-edit-operations.sqlite`
    );

    const config = readTmpConfig() as {
      calendarId: string;
      calendarName: string;
      calendarAccessRole: string;
    };
    expect(config.calendarId).toBe(CALENDAR_ID);
    expect(config.calendarName).toBe('Teaching Calendar');
    expect(config.calendarAccessRole).toBe('owner');
    expect(readdirSync(seeded.dataRoot).sort()).toEqual([
      '.drive-config-pointer.lock',
      '.google-tokens.lock',
      'calendar-cache.sqlite',
      'drive-config-pointer.json',
      'google-tokens.json',
    ]);

    await browser.refresh();
    await expect($('button=Calendar')).toBeDisplayed();
    await browser.waitUntil(
      async () => {
        const response = await fetch(`${fakeGoogleControlUrl()}/requests`);
        const requests = (await response.json()) as Array<{
          method: string;
          path: string;
          query: Record<string, string>;
        }>;
        return requests.some(
          (request) =>
            request.method === 'GET' &&
            request.path === '/calendar/v3/calendars/teaching@example.test/events' &&
            request.query.syncToken === 'sync-0'
        );
      },
      { timeout: 10_000, timeoutMsg: 'isolated app did not sync against fake Google' }
    );
    await expect($('span=Test Studio')).toBeDisplayed();

    const status = (await browser.executeAsync((calendarId, done) => {
      window
        .__LOTUS_E2E__!.runtimeStatus(calendarId)
        .then(done)
        .catch((error) => done({ error: String(error) }));
    }, CALENDAR_ID)) as RuntimeStatus & { error?: string };
    expect(status.error).toBeUndefined();
    expect(status.dataRoot).toBe(`${e2eRunRoot()}/app-data`);
    expect(status.cachedEventCount).toBe(4);
    expect(status.syncStatePresent).toBe(true);

    const requests = (await (await fetch(`${fakeGoogleControlUrl()}/requests`)).json()) as Array<
      Record<string, unknown>
    >;
    expect(requests.some((request) => 'authorization' in request)).toBe(false);
    const calendarRequests = requests.filter((request) =>
      String(request.path).startsWith('/calendar/v3/')
    );
    const configuredDriveDiscoveryPaths = new Set([
      '/drive/v3/files',
      '/drive/v3/files/control-1',
      '/drive/v2/files/control-1',
      '/drive/v3/files/my-drive-root',
      '/drive/v2/files/my-drive-root',
      '/drive/v3/files/final-my-drive',
      '/drive/v2/files/final-my-drive',
    ]);
    expect(calendarRequests.length).toBeGreaterThan(0);
    expect(
      requests.every(
        (request) =>
          calendarRequests.includes(request) ||
          (request.method === 'GET' && configuredDriveDiscoveryPaths.has(String(request.path)))
      )
    ).toBe(true);
  });

  it('reassigns one occurrence and refreshes the calendar chip', async () => {
    await $('button=Calendar').click();
    for (let attempts = 0; attempts < 24; attempts += 1) {
      const heading = await $('h2').getText();
      if (heading === 'August 2026') break;
      const [monthName, yearText] = heading.split(' ');
      const year = Number(yearText);
      const month = [
        'January',
        'February',
        'March',
        'April',
        'May',
        'June',
        'July',
        'August',
        'September',
        'October',
        'November',
        'December',
      ].indexOf(monthName!);
      await $(year < 2026 || (year === 2026 && month < 7) ? 'button=›' : 'button=‹').click();
    }
    await expect($('h2=August 2026')).toBeDisplayed();

    const lesson = await $('button[aria-label="Test Studio, Pilates, 09:00"]');
    await expect(lesson).toBeDisplayed();
    await lesson.click();
    const fixStudio = await $('button=Fix Studio');
    await expect(fixStudio).toBeEnabled();
    await fixStudio.click();
    await $('button=New Studio').click();

    await expect($('button[aria-label="New Studio, Pilates, 09:00"]')).toBeDisplayed();
    const requests = (await (await fetch(`${fakeGoogleControlUrl()}/requests`)).json()) as Array<{
      method: string;
      path: string;
      ifMatch?: string;
      body?: unknown;
    }>;
    expect(
      requests.some(
        (request) =>
          request.method === 'PATCH' &&
          request.path === '/calendar/v3/calendars/teaching@example.test/events/lesson-single' &&
          request.ifMatch === '"single-v1"' &&
          JSON.stringify(request.body) === JSON.stringify({ summary: 'New Studio / Pilates' })
      )
    ).toBe(true);
  });

  it('sets students, sets euros, and returns to the configured rate for one occurrence', async () => {
    const lessonSelector = 'button[aria-label="New Studio, Pilates, 09:00"]';
    await $(lessonSelector).click();
    await $('button=Set Students').click();
    const students = await $('#lesson-students');
    await students.setValue('12');
    await $('button=Save students').click();
    await waitForLessonDetailsToClose('Saving students');

    await $(lessonSelector).click();
    await expect($('p*=Students: 12')).toBeDisplayed();
    await expect($('button=Set Euros…')).toBeEnabled();
    await $('button=Set Euros…').click();
    await $('#lesson-euros').setValue('30.50');
    await $('button=Save euros').click();
    await waitForLessonDetailsToClose('Saving euros');

    await $(lessonSelector).click();
    await expect($('p*=Rate: €30.5')).toBeDisplayed();
    await $('button=Set Euros…').click();
    await $('button=Use configured rate').click();
    await waitForLessonDetailsToClose('Restoring the configured rate');

    await $(lessonSelector).click();
    await expect($('p*=Rate: configured')).toBeDisplayed();

    const requests = (await (await fetch(`${fakeGoogleControlUrl()}/requests`)).json()) as Array<{
      method: string;
      path: string;
      ifMatch?: string;
      body?: unknown;
    }>;
    const valuePatches = requests.filter(
      (request) =>
        request.method === 'PATCH' &&
        request.path === '/calendar/v3/calendars/teaching@example.test/events/lesson-single' &&
        typeof request.body === 'object' &&
        request.body !== null &&
        'description' in request.body
    );
    expect(valuePatches.map(({ ifMatch, body }) => ({ ifMatch, body }))).toEqual([
      { ifMatch: '"lesson-single-v2"', body: { description: '12' } },
      { ifMatch: '"lesson-single-v3"', body: { description: '12/30.5EUR' } },
      { ifMatch: '"lesson-single-v4"', body: { description: '12' } },
    ]);
  });

  it('reassigns an entire recurring series while preserving title exceptions', async () => {
    await $('button[aria-label="Test Studio, Yoga, 17:00"]').click();
    await $('button=Fix Studio').click();
    await $('button=New Studio').click();
    await expect($('[role="dialog"][aria-label="Reassign recurring lesson"]')).toBeDisplayed();
    await $('button=Entire series').click();
    const confirmation = await $('[role="dialog"][aria-label="Update entire series?"]');
    await expect(confirmation).toHaveText(/update 1 of 2 loaded lessons/);
    await expect(confirmation).toHaveText(/1 custom title exception/);
    await $('button=Update entire series').click();

    await expect($('button[aria-label="New Studio, Yoga, 17:00"]')).toBeDisplayed();
    await expect($('button[aria-label="Cover Studio, Yoga, 17:00"]')).toBeDisplayed();
    const requests = (await (await fetch(`${fakeGoogleControlUrl()}/requests`)).json()) as Array<{
      method: string;
      path: string;
      ifMatch?: string;
      body?: unknown;
    }>;
    expect(
      requests.some(
        (request) =>
          request.method === 'PATCH' &&
          request.path === '/calendar/v3/calendars/teaching@example.test/events/series-master' &&
          request.ifMatch === '"master-v1"' &&
          JSON.stringify(request.body) === JSON.stringify({ summary: 'New Studio / Yoga' })
      )
    ).toBe(true);
  });

  it('keeps cached lessons and read-only refresh after declining the one-time write grant', async () => {
    const reset = await fetch(`${fakeGoogleControlUrl()}/reset`, { method: 'POST' });
    expect(reset.status).toBe(204);
    await configureFixtureDriveRoot();
    const failSync = await fetch(`${fakeGoogleControlUrl()}/next-error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'GET',
        path: '/calendar/v3/calendars/teaching@example.test/events',
        status: 503,
        body: { error: { message: 'keep the seeded cache for the decline regression' } },
      }),
    });
    expect(failSync.status).toBe(204);

    const seeded = (await browser.executeAsync((seedValue, done) => {
      window
        .__LOTUS_E2E__!.seedRuntime(seedValue)
        .then(done)
        .catch((error) => done({ error: String(error) }));
    }, declineSeed)) as RuntimeStatus & { error?: string };
    expect(seeded.error).toBeUndefined();
    expect(seeded.cachedEventCount).toBe(1);
    expect(seeded.writeCapable).toBe(false);

    await browser.refresh();
    await expect($('button=Allow calendar editing to make changes')).toBeDisplayed();
    await expect($('button=Not now')).toBeDisplayed();
    await $('button=Not now').click();

    await expect($('button=Calendar')).toBeDisplayed();
    await $('button=Calendar').click();
    for (let attempts = 0; attempts < 24; attempts += 1) {
      const heading = await $('h2').getText();
      if (heading === 'August 2026') break;
      const [, yearText] = heading.split(' ');
      const year = Number(yearText);
      const monthNames = [
        'January',
        'February',
        'March',
        'April',
        'May',
        'June',
        'July',
        'August',
        'September',
        'October',
        'November',
        'December',
      ];
      const month = monthNames.indexOf(heading.split(' ')[0]!);
      const beforeTarget = year < 2026 || (year === 2026 && month < 7);
      await $(beforeTarget ? 'button=›' : 'button=‹').click();
    }
    await expect($('h2=August 2026')).toBeDisplayed();
    await expect($('button*=Cached decline lesson')).toBeDisplayed();

    const refresh = await $('button*=Refresh');
    await expect(refresh).toBeEnabled();
    await refresh.click();
    await browser.waitUntil(async () => !(await refresh.getText()).includes('Refreshing'), {
      timeout: 10_000,
      timeoutMsg: 'read-only refresh did not settle after declining calendar editing',
    });

    const requests = (await (await fetch(`${fakeGoogleControlUrl()}/requests`)).json()) as Array<{
      method: string;
    }>;
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.method === 'GET')).toBe(true);

    await browser.refresh();
    await expect($('button=Calendar')).toBeDisplayed();
    expect(await $('button=Allow calendar editing to make changes').isExisting()).toBe(false);
    await expect($('button*=Refresh')).toBeEnabled();
  });
});
