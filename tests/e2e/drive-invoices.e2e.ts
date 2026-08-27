import { browser, expect, $ } from '@wdio/globals';
import { createHash } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { editingConfigYaml, fakeGoogleControlUrl } from './helpers.js';

const CALENDAR_ID = 'teaching@example.test';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const PDF_BYTES = Buffer.from('%PDF-1.7\nLotus E2E manual invoice\n');
const WELCOME_DIALOG =
  '//*[@role="dialog"][@aria-labelledby][.//*[normalize-space(.)="Welcome to Lotus"]]';
const DRIVE_FOLDER_DIALOG =
  '//*[@role="dialog"][@aria-labelledby][.//*[normalize-space(.)="Choose Drive invoice folder"]]';
const MANAGED_PROPERTY_KEYS = [
  'lotusCalendarHash',
  'lotusInvoiceNumber',
  'lotusMonth',
  'lotusOperationId',
  'lotusPdfSha256',
  'lotusSchema',
  'lotusSourceSha256',
  'lotusStudioSlug',
];

interface FakeFile {
  id: string;
  name: string;
  parents: string[];
  version: string;
  etag: string;
  properties: Record<string, string>;
  bodySha256: string;
  bytesBase64: string;
  capabilities: {
    canListChildren: boolean;
    canAddChildren: boolean;
    canEdit: boolean;
    canDownload: boolean;
  };
}

interface FakeState {
  files: FakeFile[];
  drafts: Array<{ id: string; rawSha256: string; attachmentSha256: string | null }>;
}

interface FakeRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  ifMatch?: string;
  responseStatus?: number;
}

interface DriveConfigDocument {
  invoiceSequenceByYear: Record<string, number>;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function control(path: string, body?: unknown): Promise<Response> {
  return fetch(`${fakeGoogleControlUrl()}${path}`, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

async function state(): Promise<FakeState> {
  const response = await fetch(`${fakeGoogleControlUrl()}/state`);
  expect(response.status).toBe(200);
  return (await response.json()) as FakeState;
}

async function mutate(mutation: unknown): Promise<void> {
  expect((await control('/mutate', mutation)).status).toBe(204);
}

async function driveListRequestCount(): Promise<number> {
  return requestCount('GET', '/drive/v3/files');
}

async function calendarEventRequestCount(): Promise<number> {
  return requestCount('GET', '/calendar/v3/calendars/teaching@example.test/events');
}

async function requests(): Promise<FakeRequest[]> {
  const response = await fetch(`${fakeGoogleControlUrl()}/requests`);
  expect(response.status).toBe(200);
  return (await response.json()) as FakeRequest[];
}

async function requestCount(method: string, path: string): Promise<number> {
  return (await requests()).filter((request) => request.method === method && request.path === path)
    .length;
}

async function refreshDrive(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const refresh = await $('button=Refresh Drive');
      return (await refresh.isExisting()) && (await refresh.isEnabled());
    },
    {
      timeout: 30_000,
      timeoutMsg: 'Drive refresh did not become available',
    }
  );
  const before = await driveListRequestCount();
  await $('button=Refresh Drive').click();
  await browser.waitUntil(
    async () =>
      (await driveListRequestCount()) >= before + 3 &&
      (await $('button=Refresh Drive').isExisting()) &&
      (await $('button=Refresh Drive').isEnabled()),
    {
      timeout: 15_000,
      timeoutMsg: 'Drive refresh did not settle',
    }
  );
}

async function refreshDriveExpectingError(pattern: RegExp): Promise<void> {
  const before = await driveListRequestCount();
  const refresh = await $('button=Refresh Drive');
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await browser.waitUntil(
    async () =>
      (await driveListRequestCount()) >= before + 2 &&
      (await alertsContain(pattern)) &&
      (await $('button=Refresh Drive').isEnabled()),
    {
      timeout: 15_000,
      timeoutMsg: `Drive refresh error ${String(pattern)} was not displayed after its retries`,
    }
  );
}

async function refreshCalendarFromGoogle(): Promise<void> {
  const path = '/calendar/v3/calendars/teaching@example.test/events';
  const before = await requestCount('GET', path);
  await $('button=Calendar').click();
  const refresh = await $('button*=Refresh');
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await browser.waitUntil(
    async () =>
      (await requestCount('GET', path)) > before &&
      (await $('button*=Refresh').isExisting()) &&
      (await $('button*=Refresh').isEnabled()),
    {
      timeout: 15_000,
      timeoutMsg: 'Calendar refresh request did not settle',
    }
  );
  await $('button=Invoices').click();
  await expect($('table')).toBeDisplayed();
}

async function alertsContain(pattern: RegExp): Promise<boolean> {
  const text = await browser.execute(() =>
    [...document.querySelectorAll('[role="alert"]')]
      .map((alert) => (alert as HTMLElement).innerText)
      .join('\n')
  );
  return pattern.test(text);
}

async function expectAlert(pattern: RegExp, description: string): Promise<void> {
  try {
    await browser.waitUntil(() => alertsContain(pattern), {
      timeout: 15_000,
      timeoutMsg: `${description} alert was not displayed`,
    });
  } catch {
    const rendered = await browser.execute(() => ({
      alerts: [...document.querySelectorAll('[role="alert"]')].map(
        (alert) => (alert as HTMLElement).innerText
      ),
      body: document.body.innerText,
    }));
    const driveRequests = (await requests())
      .filter((request) => request.method === 'GET' && request.path === '/drive/v3/files')
      .slice(-10);
    throw new Error(
      `${description} alert was not displayed: ${JSON.stringify({ rendered, driveRequests })}`
    );
  }
}

async function invoiceRow(month: string) {
  return $(`//tr[.//td[contains(normalize-space(.), "${month}")]]`);
}

interface PostReloadExpectation {
  calendarRequestsBefore: number;
  driveRequestsBefore?: number;
}

async function navigateToDriveInvoicesAfterReload(
  expectation: PostReloadExpectation
): Promise<void> {
  await browser.waitUntil(
    async () => {
      const calendarRefresh = await $('button*=↺ Refresh');
      return (
        (await calendarEventRequestCount()) > expectation.calendarRequestsBefore &&
        (await calendarRefresh.isExisting()) &&
        (await calendarRefresh.isEnabled())
      );
    },
    {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: 'cold page Calendar bootstrap did not settle',
    }
  );
  await browser.waitUntil(
    async () => {
      const driveScanReady =
        expectation.driveRequestsBefore === undefined ||
        (await driveListRequestCount()) > expectation.driveRequestsBefore;
      return (
        driveScanReady &&
        (await $('button=Invoices').isEnabled()) &&
        (await browser.execute(() => document.body.innerText.includes('Welcome to Lotus'))) ===
          false
      );
    },
    {
      timeout: 45_000,
      interval: 250,
      timeoutMsg: 'required Google setup did not become ready',
    }
  );
  await $('button=Invoices').click();
  await expect($('table')).toBeDisplayed();
}

async function seedRuntime(options: { calendarConfigured?: boolean } = {}): Promise<void> {
  const config = parse(editingConfigYaml()) as Record<string, any>;
  if (options.calendarConfigured === false) {
    delete config.calendarId;
    delete config.calendarName;
    delete config.calendarAccessRole;
  }
  config.lastInvoice = '8/2026';
  config.studios['Test Studio'].invoiceEmail = 'invoices@example.test';
  const seed = {
    configYaml: stringify(config),
    calendarId: CALENDAR_ID,
    authorization: {
      accessToken: 'e2e-desktop-token',
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
        eventId: 'july-cached',
        recurringEventId: null,
        originalStartTime: null,
        etag: '"july-v1"',
        summary: 'Test Studio / July class',
        description: '5',
        start: '2026-07-15T09:00:00+02:00',
        end: '2026-07-15T10:00:00+02:00',
        updated: '2026-08-01T09:00:00.000Z',
        status: 'confirmed',
      },
      {
        eventId: 'lesson-single',
        recurringEventId: null,
        originalStartTime: null,
        etag: '"single-v1"',
        summary: 'Test Studio / August class',
        description: '6',
        start: '2026-08-18T09:00:00+02:00',
        end: '2026-08-18T10:00:00+02:00',
        updated: '2026-08-01T10:00:00.000Z',
        status: 'confirmed',
      },
    ],
    syncToken: 'sync-1',
    syncedAt: '2026-08-15T10:00:00.000Z',
  };
  const result = (await browser.executeAsync((value, done) => {
    window
      .__LOTUS_E2E__!.seedRuntime(value)
      .then(done)
      .catch((error) => done({ error: String(error) }));
  }, seed)) as { error?: string };
  expect(result.error).toBeUndefined();
}

async function configureFixtureRoot(): Promise<void> {
  const config = parse(editingConfigYaml()) as Record<string, unknown>;
  config.invoiceSequenceByYear = { '2026': 8 };
  await mutate({
    type: 'drivePatch',
    fileId: 'control-1',
    patch: { bytesBase64: Buffer.from(stringify(config)).toString('base64') },
  });
}

function activeDriveConfig(current: FakeState): {
  file: FakeFile;
  config: DriveConfigDocument;
} {
  const configs = current.files.filter(
    (file) =>
      file.name === 'lotus-invoices-config.yaml' && file.properties.lotusConfigSchema === '1'
  );
  expect(configs).toHaveLength(1);
  return {
    file: configs[0]!,
    config: parse(
      Buffer.from(configs[0]!.bytesBase64, 'base64').toString('utf8')
    ) as DriveConfigDocument,
  };
}

function googleDriveConnectionRow() {
  return $(
    '//section[.//h3[normalize-space(.)="Connections"]]//p[normalize-space(.)="Google Drive"]/ancestor::div[button[normalize-space(.)="Change…"]][1]'
  );
}

async function getWelcomeAction(label: string) {
  const welcome = await $(WELCOME_DIALOG);
  await expect(welcome).toBeDisplayed();
  const buttons = await welcome.$$('button');
  const actions = [];
  for (const button of buttons) {
    if ((await button.isDisplayed()) && (await button.getText()).trim() === label) {
      actions.push(button);
    }
  }
  expect(actions).toHaveLength(1);
  return actions[0]!;
}

async function clickWelcomeAction(label: string): Promise<void> {
  await (await getWelcomeAction(label)).click();
}

async function createAndActivateRoot(
  name: string,
  options: { openInvoices?: boolean } = {}
): Promise<void> {
  const welcome = await $(WELCOME_DIALOG);
  const enteredFromWelcome = (await welcome.isExisting()) && (await welcome.isDisplayed());
  if (enteredFromWelcome) {
    await clickWelcomeAction('Pick Drive folder…');
  } else {
    await $('button=Rates & Config').click();
    const driveRow = await googleDriveConnectionRow();
    await driveRow.$('button=Change…').click();
  }
  const dialog = await $(DRIVE_FOLDER_DIALOG);
  await expect(dialog).toBeDisplayed();
  await dialog.$('button=Create / Select folder…').click();
  await dialog.$('button=My Drive').click();
  const input = await dialog.$('label*=New folder name').$('input');
  await input.setValue(name);
  await dialog.$('button=Create folder').click();
  await expect(dialog.$(`[aria-current="page"]=${name}`)).toBeDisplayed();
  await dialog.$('button=Use this folder').click();
  await expect(dialog.$(`h3=Review ${name}`)).toBeDisplayed();
  await dialog.$('button=Activate for all devices').click();
  await browser.waitUntil(async () => !(await $(DRIVE_FOLDER_DIALOG).isExisting()), {
    timeout: 15_000,
    timeoutMsg: `Drive root ${name} did not activate`,
  });
  if (enteredFromWelcome) {
    await browser.waitUntil(async () => await $('button=‹').isDisplayed(), {
      timeout: 45_000,
      timeoutMsg: 'Calendar did not become active after required Google setup',
    });
  }
  await browser.waitUntil(
    async () =>
      (await $('button=Invoices').isEnabled()) &&
      (await browser.execute(() => document.body.innerText.includes('Welcome to Lotus'))) === false,
    { timeout: 45_000, timeoutMsg: 'required Google setup did not become ready' }
  );
  if (options.openInvoices === false) return;
  await $('button=Invoices').click();
  await expect($('table')).toBeDisplayed();
  await expect($('button=Refresh Drive')).toBeDisplayed();
}

function managedProperties(
  fileBytes: Uint8Array,
  month: string,
  invoiceNumber: string,
  overrides: Record<string, string> = {}
): Record<string, string> {
  return {
    lotusSchema: '1',
    lotusCalendarHash: 'c'.repeat(64),
    lotusStudioSlug: 'test-studio',
    lotusMonth: month,
    lotusInvoiceNumber: invoiceNumber,
    lotusSourceSha256: 'd'.repeat(64),
    lotusPdfSha256: sha256(fileBytes),
    lotusOperationId: 'android-operation',
    ...overrides,
  };
}

function expectManagedProperties(
  file: FakeFile,
  expected: { month: string; invoiceNumber: string }
): void {
  expect(Object.keys(file.properties).sort()).toEqual(MANAGED_PROPERTY_KEYS);
  expect(file.properties).toMatchObject({
    lotusSchema: '1',
    lotusStudioSlug: 'test-studio',
    lotusMonth: expected.month,
    lotusInvoiceNumber: expected.invoiceNumber,
    lotusPdfSha256: file.bodySha256,
  });
  expect(file.properties.lotusCalendarHash).toMatch(/^[a-f0-9]{64}$/);
  expect(file.properties.lotusSourceSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(file.properties.lotusOperationId).not.toBe('');
}

let firstRootId = '';
let firstFinalId = '';
let augustPdfId = '';
let augustFilename = '';
let augustChecksum = '';

describe('Drive invoices across desktop and Android clients', () => {
  it('starts on Calendar without Welcome when Calendar and Drive are configured', async () => {
    expect((await control('/reset')).status).toBe(204);
    await configureFixtureRoot();
    await seedRuntime();
    const calendarRequestsBefore = await calendarEventRequestCount();
    await browser.refresh();
    await browser.waitUntil(
      async () =>
        (await $('button=Invoices').isEnabled()) &&
        (await browser.execute(() => document.body.innerText.includes('Welcome to Lotus'))) ===
          false,
      { timeout: 45_000, timeoutMsg: 'configured Google setup did not become ready' }
    );
    await expect($(WELCOME_DIALOG)).not.toBeExisting();
    await expect($('button=‹')).toBeDisplayed();
    await navigateToDriveInvoicesAfterReload({
      calendarRequestsBefore,
    });
  });

  it('starts Welcome at Drive when Calendar is configured but no config file exists', async () => {
    await mutate({ type: 'driveReset', unconfigured: true });
    await seedRuntime();
    await browser.refresh();
    await expect($(WELCOME_DIALOG)).toBeDisplayed();
    await expect($('p=Step 2 of 2')).toBeDisplayed();
    await expect(await getWelcomeAction('Pick Drive folder…')).toBeDisplayed();
  });

  it('retries cold initial Drive unavailability and resolves discovery', async () => {
    expect(
      (
        await control('/next-error', {
          method: 'GET',
          path: '/drive/v3/files',
          status: 503,
          times: 6,
          body: { error: { code: 503, message: 'service unavailable' } },
        })
      ).status
    ).toBe(204);
    await browser.refresh();
    await expect($(WELCOME_DIALOG)).toBeDisplayed();
    await expect($('p=Step 2 of 2')).toBeDisplayed();
    await browser.waitUntil(
      async () =>
        (await browser.execute(() =>
          document.body.innerText.includes('Google Drive is temporarily unavailable')
        )) && (await $('button=Retry Google Drive').isDisplayed()),
      { timeout: 30_000, timeoutMsg: 'cold Drive discovery error was not displayed' }
    );

    expect((await control('/reset')).status).toBe(204);
    await mutate({ type: 'driveReset', unconfigured: true });
    await $('button=Retry Google Drive').click();
    await browser.waitUntil(
      async () =>
        (await (await getWelcomeAction('Pick Drive folder…')).isEnabled()) &&
        (await browser.execute(() =>
          document.body.innerText.includes('Google Drive is temporarily unavailable')
        )) === false,
      { timeout: 30_000, timeoutMsg: 'Drive discovery did not recover after Retry' }
    );
    await expect($('button=Retry Google Drive')).not.toBeExisting();
  });

  it('selects and durably configures Calendar from a truly unconfigured first launch', async () => {
    expect((await control('/reset')).status).toBe(204);
    await mutate({ type: 'driveReset', unconfigured: true });
    await seedRuntime({ calendarConfigured: false });
    await browser.refresh();
    await expect($(WELCOME_DIALOG)).toBeDisplayed();
    await expect($('p=Step 1 of 2')).toBeDisplayed();

    const calendarListsBefore = await requestCount('GET', '/calendar/v3/users/me/calendarList');
    await clickWelcomeAction('Pick calendar…');
    await clickWelcomeAction('Teaching Calendar');

    await browser.waitUntil(
      async () =>
        await browser.execute(() =>
          [...document.querySelectorAll('[role="dialog"][aria-labelledby]')].some(
            (dialog) =>
              dialog.textContent?.includes('Welcome to Lotus') &&
              dialog.textContent.includes('Step 2 of 2') &&
              [...dialog.querySelectorAll('button')].some(
                (button) => button.textContent?.trim() === 'Pick Drive folder…'
              )
          )
        ),
      { timeout: 15_000, timeoutMsg: 'Calendar selection did not advance Welcome to Drive' }
    );
    expect(await requestCount('GET', '/calendar/v3/users/me/calendarList')).toBeGreaterThan(
      calendarListsBefore
    );
  });

  it('activates Drive from Welcome, unlocks Calendar, and survives a configured reload', async () => {
    await createAndActivateRoot('Lotus E2E Root', { openInvoices: false });
    const current = await state();
    const stored = activeDriveConfig(current);
    firstRootId = stored.file.parents[0]!;
    firstFinalId = current.files.find(
      (file) => file.name === 'Final' && file.parents.includes(firstRootId)
    )!.id;
    expect(current.files.find((file) => file.id === firstRootId)?.name).toBe('Lotus E2E Root');
    expect(current.files.find((file) => file.id === firstFinalId)).toMatchObject({
      name: 'Final',
      parents: [firstRootId],
    });
    await expect($(WELCOME_DIALOG)).not.toBeExisting();
    for (const destination of ['Calendar', 'Invoices', 'Income', 'Rates & Config']) {
      await expect($(`button=${destination}`)).toBeEnabled();
    }
    await expect($('button=‹')).toBeDisplayed();

    const calendarRequestsBefore = await calendarEventRequestCount();
    const driveRequestsBefore = await driveListRequestCount();
    await browser.refresh();
    await browser.waitUntil(
      async () =>
        (await calendarEventRequestCount()) > calendarRequestsBefore &&
        (await driveListRequestCount()) > driveRequestsBefore &&
        (await $('button=Invoices').isEnabled()) &&
        (await $('button=‹').isDisplayed()) &&
        !(await $(WELCOME_DIALOG).isExisting()),
      { timeout: 45_000, timeoutMsg: 'configured first-run setup did not survive reload' }
    );
    expect(activeDriveConfig(await state()).file.parents).toEqual([firstRootId]);
    await $('button=Invoices').click();
    await expect($('table')).toBeDisplayed();
  });

  it('adopts a manually copied valid PDF after refresh', async () => {
    const original = {
      id: 'manual-july',
      name: '8-2026-test-studio-2026-07.pdf',
      parents: [firstFinalId],
      bytesBase64: PDF_BYTES.toString('base64'),
      bodySha256: sha256(PDF_BYTES),
    };
    await mutate({
      type: 'driveUpsert',
      file: {
        id: original.id,
        name: original.name,
        mimeType: 'application/pdf',
        parents: original.parents,
        driveId: null,
        ownedByMe: true,
        properties: {},
        bytesBase64: original.bytesBase64,
      },
    });
    await refreshDrive();
    const row = await invoiceRow('July 2026');
    await expect(row).toHaveText(/Finalized/);
    await expect(row).toHaveText(/8\/2026/);
    const adopted = (await state()).files.find((file) => file.id === original.id)!;
    expect({
      id: adopted.id,
      name: adopted.name,
      parents: adopted.parents,
      bytesBase64: adopted.bytesBase64,
      bodySha256: adopted.bodySha256,
    }).toEqual(original);
    expectManagedProperties(adopted, { month: '2026-07', invoiceNumber: '8/2026' });
  });

  it('finalizes August, verifies remote identity and survives a cold page reload', async () => {
    const row = await invoiceRow('August 2026');
    await row.$('button=Finalize PDF').click();
    await browser.waitUntil(async () => (await row.getText()).includes('Finalized'), {
      timeout: 30_000,
      timeoutMsg: 'August invoice did not finalize',
    });
    await expect(row).toHaveText(/9\/2026/);
    const current = await state();
    const pdf = current.files.find((file) => file.properties.lotusInvoiceNumber === '9/2026')!;
    augustPdfId = pdf.id;
    augustFilename = pdf.name;
    augustChecksum = pdf.bodySha256;
    expect(pdf.id).not.toBe('');
    expect(pdf.name).toBe('9-2026-test-studio-2026-08.pdf');
    expect(pdf.parents).toEqual([firstFinalId]);
    expect(pdf.bytesBase64).not.toBe('');
    expect(sha256(Buffer.from(pdf.bytesBase64, 'base64'))).toBe(pdf.bodySha256);
    expectManagedProperties(pdf, { month: '2026-08', invoiceNumber: '9/2026' });

    const calendarRequestsBefore = await calendarEventRequestCount();
    const driveRequestsBefore = await driveListRequestCount();
    const reloadMarker = `lotus-reload-${Date.now()}`;
    await browser.execute((marker) => {
      document.documentElement.dataset.lotusReloadMarker = marker;
    }, reloadMarker);
    await browser.refresh();
    await browser.waitUntil(
      async () => {
        try {
          return await browser.execute(
            (marker) =>
              document.documentElement.dataset.lotusReloadMarker !== marker &&
              window.__LOTUS_E2E__ !== undefined &&
              [...document.querySelectorAll('button')].some(
                (button) => button.textContent?.trim() === 'Invoices'
              ),
            reloadMarker
          );
        } catch {
          return false;
        }
      },
      { timeout: 15_000, timeoutMsg: 'cold page did not finish booting' }
    );
    await navigateToDriveInvoicesAfterReload({
      calendarRequestsBefore,
      driveRequestsBefore,
    });
    await browser.waitUntil(
      async () =>
        await browser.execute(() =>
          [...document.querySelectorAll('tr')].some((row) =>
            /August 2026.*Finalized.*9\/2026/s.test(row.textContent ?? '')
          )
        ),
      {
        timeout: 30_000,
        timeoutMsg: 'cold reload did not restore the finalized August invoice',
      }
    );
  });

  it('observes a PDF written with the Android token on the next refresh', async () => {
    const bytes = Buffer.from('%PDF-1.7\nAndroid historical invoice\n');
    await mutate({
      type: 'driveUpsert',
      file: {
        id: 'android-history',
        name: '7-2026-test-studio-2026-05.pdf',
        mimeType: 'application/pdf',
        parents: [firstFinalId],
        driveId: null,
        ownedByMe: true,
        properties: managedProperties(bytes, '2026-05', '7/2026'),
        bytesBase64: bytes.toString('base64'),
      },
    });
    await refreshDrive();
    await expect(await invoiceRow('May 2026')).toHaveText(/Finalized.*7\/2026/s);
  });

  it('surfaces a stale desktop 412 and never overwrites the externally changed PDF', async () => {
    await mutate({ type: 'patch', eventId: 'lesson-single', patch: { description: '7' } });
    await refreshCalendarFromGoogle();
    await refreshDrive();
    const row = await invoiceRow('August 2026');
    await expect(row).toHaveText(/Out of date/);
    const before = (await state()).files.find((file) => file.id === augustPdfId)!;
    const externalBytes = Buffer.from('%PDF-1.7\nAndroid concurrent mutation\n');
    const externalChecksum = sha256(externalBytes);
    const uploadPath = `/upload/drive/v2/files/${augustPdfId}`;
    const beforeRequests = (await requests()).filter(
      (request) => request.method === 'PUT' && request.path === uploadPath
    ).length;
    expect(
      (
        await control('/mutate-before-upload-patch', {
          fileId: augustPdfId,
          patch: {
            properties: { androidWriter: '1', lotusPdfSha256: externalChecksum },
            bytesBase64: externalBytes.toString('base64'),
          },
        })
      ).status
    ).toBe(204);
    // Do not refresh: the desktop must submit the ETag captured before the external mutation.
    await row.$('button=Re-finalize PDF').click();
    await browser.waitUntil(() => alertsContain(/changed|conflict/i), {
      timeout: 20_000,
      timeoutMsg: 'stale 412 was not shown in the invoice row',
    });
    const after = (await state()).files.find((file) => file.id === augustPdfId)!;
    expect(Number(after.version)).toBe(Number(before.version) + 1);
    expect(after.etag).not.toBe(before.etag);
    expect(after.bodySha256).toBe(externalChecksum);
    expect(after.bytesBase64).toBe(externalBytes.toString('base64'));
    expect(after.properties).toEqual({
      ...before.properties,
      androidWriter: '1',
      lotusPdfSha256: externalChecksum,
    });
    const uploadRequests = (await requests()).filter(
      (request) => request.method === 'PUT' && request.path === uploadPath
    );
    expect(uploadRequests).toHaveLength(beforeRequests + 1);
    expect(uploadRequests.at(-1)).toMatchObject({
      ifMatch: before.etag,
      responseStatus: 412,
    });
  });

  it('shows Calendar source changes as stale and re-finalizes the same ID and number', async () => {
    await mutate({ type: 'patch', eventId: 'lesson-single', patch: { description: '9' } });
    await refreshCalendarFromGoogle();
    await refreshDrive();
    const row = await invoiceRow('August 2026');
    await expect(row).toHaveText(/Out of date/);
    await row.$('button=Re-finalize PDF').click();
    await browser.waitUntil(async () => (await row.getText()).includes('Finalized'), {
      timeout: 30_000,
      timeoutMsg: 'Calendar-stale invoice did not re-finalize',
    });
    const pdf = (await state()).files.find((file) => file.id === augustPdfId)!;
    expect(pdf.id).toBe(augustPdfId);
    expect(pdf.name).toBe(augustFilename);
    expect(pdf.properties.lotusInvoiceNumber).toBe('9/2026');
    augustChecksum = pdf.bodySha256;
  });

  it('opens authoritative bytes through the suppressed viewer cache', async () => {
    await refreshDrive();
    const row = await invoiceRow('August 2026');
    await row.$('button=Open PDF').click();
    await browser.waitUntil(async () => !(await row.$('button=Opening…').isExisting()), {
      timeout: 15_000,
      timeoutMsg: 'suppressed PDF viewer operation did not settle',
    });
    const bytes = (await browser.executeAsync((filename, done) => {
      window
        .__LOTUS_E2E__!.readCachedPdf(filename)
        .then(done)
        .catch((error) => done({ error: String(error) }));
    }, augustFilename)) as number[] | { error: string };
    expect(Array.isArray(bytes)).toBe(true);
    expect(sha256(Uint8Array.from(bytes as number[]))).toBe(augustChecksum);
  });

  it('drafts Gmail with the exact authoritative Drive attachment bytes', async () => {
    const row = await invoiceRow('August 2026');
    await row.$('button=Draft Email').click();
    await browser.waitUntil(async () => (await state()).drafts.length === 1, {
      timeout: 15_000,
      timeoutMsg: 'fake Gmail did not capture the draft',
    });
    expect((await state()).drafts[0]?.attachmentSha256).toBe(augustChecksum);
  });

  it('switches roots without moving or changing old files', async () => {
    const beforeState = await state();
    const beforeConfig = activeDriveConfig(beforeState);
    const before = beforeState.files
      .filter((file) => file.parents.includes(firstFinalId))
      .map((file) => ({ id: file.id, parent: file.parents[0], checksum: file.bodySha256 }))
      .sort((left, right) => left.id.localeCompare(right.id));
    await createAndActivateRoot('Lotus E2E Second Root');
    const afterState = await state();
    const afterConfig = activeDriveConfig(afterState);
    const secondRoots = afterState.files.filter((file) => file.name === 'Lotus E2E Second Root');
    expect(secondRoots).toHaveLength(1);
    const secondRoot = secondRoots[0]!;
    const secondFinals = afterState.files.filter(
      (file) => file.name === 'Final' && file.parents.includes(secondRoot.id)
    );
    expect(secondFinals).toHaveLength(1);
    const secondFinal = secondFinals[0]!;
    expect(afterConfig.file.id).toBe(beforeConfig.file.id);
    expect(afterConfig.file.parents).toEqual([secondRoot.id]);
    expect(afterConfig.config).toEqual(beforeConfig.config);
    expect(secondRoot.name).toBe('Lotus E2E Second Root');
    expect(secondFinal).toMatchObject({ name: 'Final', parents: [secondRoot.id] });
    const after = afterState.files
      .filter((file) => before.some(({ id }) => id === file.id))
      .map((file) => ({ id: file.id, parent: file.parents[0], checksum: file.bodySha256 }))
      .sort((left, right) => left.id.localeCompare(right.id));
    expect(after).toEqual(before);
    await $('button=Rates & Config').click();
    await expect(await googleDriveConnectionRow()).toHaveText(/Lotus E2E Second Root/);
    await $('button=Invoices').click();
  });

  it('shows duplicate, malformed, corrupt, missing, permission, rate-limit, and allocation-gap states', async () => {
    await refreshDrive();
    const current = await state();
    const configRootId = activeDriveConfig(current).file.parents[0]!;
    const finalId = current.files.find(
      (file) => file.name === 'Final' && file.parents.includes(configRootId)
    )!.id;
    const faultBytes = Buffer.from('%PDF-1.7\nfault fixture\n');
    for (const id of ['duplicate-a', 'duplicate-b']) {
      await mutate({
        type: 'driveUpsert',
        file: {
          id,
          name: `${id === 'duplicate-a' ? '6' : '5'}-2026-test-studio-2026-04.pdf`,
          mimeType: 'application/pdf',
          parents: [finalId],
          driveId: null,
          ownedByMe: true,
          properties: managedProperties(
            faultBytes,
            '2026-04',
            id === 'duplicate-a' ? '6/2026' : '5/2026'
          ),
          bytesBase64: faultBytes.toString('base64'),
        },
      });
    }
    expect(
      (await state()).files
        .filter((file) => file.id === 'duplicate-a' || file.id === 'duplicate-b')
        .map((file) => file.parents)
    ).toEqual([[finalId], [finalId]]);
    await refreshDrive();
    await $('button=Invoices').click();
    await expectAlert(/Duplicate invoice/, 'Duplicate invoice');
    for (const id of ['duplicate-a', 'duplicate-b']) {
      await mutate({ type: 'drivePatch', fileId: id, patch: { trashed: true } });
    }

    await mutate({
      type: 'driveUpsert',
      file: {
        id: 'malformed',
        name: 'bad.pdf',
        mimeType: 'application/pdf',
        parents: [finalId],
        driveId: null,
        ownedByMe: true,
        properties: {},
        bytesBase64: faultBytes.toString('base64'),
      },
    });
    await refreshDrive();
    await $('button=Invoices').click();
    await expectAlert(/Malformed finalized invoice filename/, 'Malformed invoice');
    await mutate({ type: 'drivePatch', fileId: 'malformed', patch: { trashed: true } });

    await mutate({
      type: 'driveUpsert',
      file: {
        id: 'corrupt',
        name: '6-2026-test-studio-2026-03.pdf',
        mimeType: 'application/pdf',
        parents: [finalId],
        driveId: null,
        ownedByMe: true,
        properties: managedProperties(faultBytes, '2026-03', '6/2026', {
          lotusPdfSha256: '0'.repeat(64),
        }),
        bytesBase64: faultBytes.toString('base64'),
      },
    });
    await refreshDrive();
    await $('button=Invoices').click();
    await expectAlert(/checksum/, 'Checksum');
    await mutate({ type: 'drivePatch', fileId: 'corrupt', patch: { trashed: true } });

    await mutate({
      type: 'driveUpsert',
      file: {
        id: 'missing-after-scan',
        name: '4-2026-test-studio-2026-02.pdf',
        mimeType: 'application/pdf',
        parents: [finalId],
        driveId: null,
        ownedByMe: true,
        properties: managedProperties(faultBytes, '2026-02', '4/2026'),
        bytesBase64: faultBytes.toString('base64'),
      },
    });
    await refreshDrive();
    const missingRow = await invoiceRow('February 2026');
    await mutate({ type: 'drivePatch', fileId: 'missing-after-scan', patch: { trashed: true } });
    await missingRow.$('button=Open PDF').click();
    await expect($('[role="alert"]*=Selected Drive invoice changed')).toBeDisplayed();

    await mutate({
      type: 'driveUpsert',
      file: {
        id: 'permission-loss',
        name: '3-2026-test-studio-2026-01.pdf',
        mimeType: 'application/pdf',
        parents: [finalId],
        driveId: null,
        ownedByMe: true,
        properties: managedProperties(faultBytes, '2026-01', '3/2026'),
        capabilities: { canDownload: false, canEdit: true },
        bytesBase64: faultBytes.toString('base64'),
      },
    });
    await refreshDrive();
    await expect($('[role="alert"]*=download')).toBeDisplayed();
    await mutate({ type: 'drivePatch', fileId: 'permission-loss', patch: { trashed: true } });

    expect(
      (
        await control('/next-error', {
          method: 'GET',
          path: '/drive/v3/files',
          status: 429,
          times: 6,
          body: { error: { code: 429, message: 'rate limited' } },
        })
      ).status
    ).toBe(204);
    await refreshDriveExpectingError(/temporarily unavailable/i);

    expect(
      (
        await control('/next-error', {
          method: 'GET',
          path: '/drive/v3/files',
          status: 503,
          times: 6,
          body: { error: { code: 503, message: 'service unavailable' } },
        })
      ).status
    ).toBe(204);
    await refreshDriveExpectingError(/temporarily unavailable/i);

    expect(
      (
        await control('/next-error', {
          method: 'GET',
          path: '/__e2e_never__',
          status: 500,
          body: { error: { code: 500, message: 'disarmed' } },
        })
      ).status
    ).toBe(204);
    await refreshDrive();
    await browser.waitUntil(
      async () => await (await invoiceRow('August 2026')).$('button=Finalize PDF').isEnabled(),
      { timeout: 15_000, timeoutMsg: 'Drive did not recover before the allocation-gap test' }
    );
    const sequenceBefore =
      activeDriveConfig(await state()).config.invoiceSequenceByYear['2026'] ?? 0;
    expect(
      (
        await control('/next-error', {
          method: 'POST',
          path: '/upload/drive/v3/files',
          status: 503,
          times: 3,
          body: { error: { code: 503, message: 'upload interrupted' } },
        })
      ).status
    ).toBe(204);
    const august = await invoiceRow('August 2026');
    await august.$('button=Finalize PDF').click();
    await browser.waitUntil(
      async () => {
        const refresh = await $('button=Refresh Drive');
        return (await refresh.isEnabled()) && (await alertsContain(/temporarily unavailable/i));
      },
      {
        timeout: 30_000,
        timeoutMsg: 'interrupted upload did not settle without recovery state',
      }
    );
    const interruptedState = await state();
    const interruptedSequence =
      activeDriveConfig(interruptedState).config.invoiceSequenceByYear['2026'] ?? 0;
    expect(interruptedSequence).toBe(sequenceBefore + 1);
    expect(await $('button=Recover invoice reservation').isExisting()).toBe(false);
    await refreshDrive();
    await (await invoiceRow('August 2026')).$('button=Finalize PDF').click();
    await browser.waitUntil(
      async () => (await (await invoiceRow('August 2026')).getText()).includes('Finalized'),
      {
        timeout: 30_000,
        timeoutMsg: 'retry after an allocation gap did not finalize',
      }
    );
    const retriedState = await state();
    const retriedSequence =
      activeDriveConfig(retriedState).config.invoiceSequenceByYear['2026'] ?? 0;
    expect(retriedSequence).toBe(interruptedSequence + 1);
    const retriedPdf = retriedState.files.find(
      (file) => file.properties.lotusMonth === '2026-08' && file.parents.includes(finalId)
    )!;
    expect(retriedPdf.parents).toEqual([finalId]);
    expectManagedProperties(retriedPdf, {
      month: '2026-08',
      invoiceNumber: `${retriedSequence}/2026`,
    });
  });
});
