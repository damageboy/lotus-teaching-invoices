import { browser, expect, $ } from '@wdio/globals';
import { createHash } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { editingConfigYaml, fakeGoogleControlUrl } from './helpers.js';

const CALENDAR_ID = 'teaching@example.test';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const PDF_BYTES = Buffer.from('%PDF-1.7\nLotus E2E manual invoice\n');
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
  ifMatch?: string;
  responseStatus?: number;
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
      (await driveListRequestCount()) > before &&
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
      (await driveListRequestCount()) >= before + 3 &&
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
  await browser.waitUntil(
    async () => await browser.execute(() => document.body.innerText.includes('Drive folder:')),
    { timeout: 15_000, timeoutMsg: 'Drive invoices did not render after Calendar refresh' }
  );
}

async function alertsContain(pattern: RegExp): Promise<boolean> {
  const text = await browser.execute(() =>
    [...document.querySelectorAll('[role="alert"]')]
      .map((alert) => alert.textContent ?? '')
      .join('\n')
  );
  return pattern.test(text);
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
      try {
        const invoices = await $('button=Invoices');
        if (await invoices.isExisting()) await invoices.click();
        const choose = await $('button=Choose Drive folder');
        const refresh = await $('button=Refresh Drive');
        const driveActionReady =
          (await choose.isExisting()) ||
          ((await refresh.isExisting()) && (await refresh.isEnabled()));
        const driveScanReady =
          expectation.driveRequestsBefore === undefined ||
          (await driveListRequestCount()) > expectation.driveRequestsBefore;
        return (
          driveActionReady &&
          driveScanReady &&
          (await browser.execute(() => document.body.innerText.includes('Drive folder:')))
        );
      } catch {
        // React may replace the button while the refreshed document settles; reacquire it.
      }
      return false;
    },
    {
      timeout: 45_000,
      interval: 250,
      timeoutMsg: 'cold page did not navigate to Drive invoices',
    }
  );
}

async function seedRuntime(): Promise<void> {
  const config = parse(editingConfigYaml()) as Record<string, any>;
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

async function createAndActivateRoot(name: string): Promise<void> {
  await $('button*=Drive folder').click();
  const dialog = await $('[role="dialog"]');
  await expect(dialog).toBeDisplayed();
  await dialog.$('button=My Drive').click();
  const input = await dialog.$('label*=New folder name').$('input');
  await input.setValue(name);
  await dialog.$('button=Create folder').click();
  await expect(dialog.$(`[aria-current="page"]=${name}`)).toBeDisplayed();
  await dialog.$('button=Use this folder').click();
  await expect(dialog.$(`h3=Review ${name}`)).toBeDisplayed();
  await dialog.$('button=Activate for all devices').click();
  await browser.waitUntil(async () => !(await dialog.isExisting()), {
    timeout: 15_000,
    timeoutMsg: `Drive root ${name} did not activate`,
  });
  await expect($('button=Refresh Drive')).toBeDisplayed();
  await expect($(`//*[normalize-space()="${name}"]`)).toBeDisplayed();
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
  it('seeds one Drive-authorized desktop client against an unconfigured account', async () => {
    expect((await control('/reset')).status).toBe(204);
    await mutate({ type: 'driveReset', unconfigured: true });
    await seedRuntime();
    const calendarRequestsBefore = await calendarEventRequestCount();
    await browser.refresh();
    await navigateToDriveInvoicesAfterReload({
      calendarRequestsBefore,
    });
    await expect($('button=Choose Drive folder')).toBeDisplayed();
  });

  it('browses My Drive, creates a root and Final child, scans, and activates it', async () => {
    await createAndActivateRoot('Lotus E2E Root');
    const current = await state();
    const controlFile = current.files.find((file) => file.properties.lotusConfigSchema === '1')!;
    const stored = JSON.parse(Buffer.from(controlFile.bytesBase64, 'base64').toString('utf8')) as {
      root: { folderId: string };
      finalFolderId: string;
    };
    firstRootId = stored.root.folderId;
    firstFinalId = stored.finalFolderId;
    expect(firstRootId).not.toBe('');
    expect(firstFinalId).not.toBe('');
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
    const uploadPath = `/upload/drive/v3/files/${augustPdfId}`;
    const beforeRequests = (await requests()).filter(
      (request) => request.method === 'PATCH' && request.path === uploadPath
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
      (request) => request.method === 'PATCH' && request.path === uploadPath
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
    const before = (await state()).files
      .filter((file) => file.parents.includes(firstFinalId))
      .map((file) => ({ id: file.id, parent: file.parents[0], checksum: file.bodySha256 }))
      .sort((left, right) => left.id.localeCompare(right.id));
    await createAndActivateRoot('Lotus E2E Second Root');
    const after = (await state()).files
      .filter((file) => before.some(({ id }) => id === file.id))
      .map((file) => ({ id: file.id, parent: file.parents[0], checksum: file.bodySha256 }))
      .sort((left, right) => left.id.localeCompare(right.id));
    expect(after).toEqual(before);
  });

  it('shows duplicate, malformed, corrupt, missing, permission, rate-limit, interruption, and recovery states', async () => {
    const current = await state();
    const controlFile = current.files.find((file) => file.properties.lotusConfigSchema === '1')!;
    const stored = JSON.parse(Buffer.from(controlFile.bytesBase64, 'base64').toString()) as {
      generation: number;
      finalFolderId: string;
      sequenceByYear: Record<string, number>;
      reservation: null | {
        operationId: string;
        invoiceNumber: string;
        fileId: string;
        sourceSha256: string;
      };
    };
    const finalId = stored.finalFolderId;
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
    await refreshDrive();
    await expect($('[role="alert"]*=Duplicate invoice')).toBeDisplayed();
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
    await expect($('[role="alert"]*=Malformed finalized invoice filename')).toBeDisplayed();
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
    await expect($('[role="alert"]*=checksum')).toBeDisplayed();
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
          times: 3,
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
          times: 3,
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
    expect((await control('/interrupt-next-upload')).status).toBe(204);
    const august = await invoiceRow('August 2026');
    await august.$('button=Finalize PDF').click();
    await browser.waitUntil(async () => (await august.getText()).includes('recover'), {
      timeout: 30_000,
      timeoutMsg: 'interrupted upload did not preserve a visible reservation',
    });
    const interruptedState = await state();
    const interruptedControlFile = interruptedState.files.find(
      (file) => file.properties.lotusConfigSchema === '1'
    )!;
    const interrupted = JSON.parse(
      Buffer.from(interruptedControlFile.bytesBase64, 'base64').toString()
    ) as typeof stored;
    expect(interrupted.reservation).not.toBeNull();
    const reservation = interrupted.reservation!;
    expect(interruptedState.files.some((file) => file.id === reservation.fileId)).toBe(false);
    const reservedSequence = Number(reservation.invoiceNumber.split('/')[0]);
    expect(reservedSequence).toBe((interrupted.sequenceByYear['2026'] ?? 0) + 1);
    const recover = await $('button=Recover invoice reservation');
    await expect(recover).toBeDisplayed();
    await recover.click();
    await browser.waitUntil(
      async () =>
        !(await $('button=Recover invoice reservation').isExisting()) &&
        (await (await invoiceRow('August 2026')).getText()).includes('Finalized'),
      {
        timeout: 30_000,
        timeoutMsg: 'app recovery did not commit the durable reservation',
      }
    );
    const recoveredState = await state();
    const recoveredControlFile = recoveredState.files.find(
      (file) => file.properties.lotusConfigSchema === '1'
    )!;
    const recovered = JSON.parse(
      Buffer.from(recoveredControlFile.bytesBase64, 'base64').toString()
    ) as typeof stored;
    expect(recovered.reservation).toBeNull();
    expect(recovered.sequenceByYear['2026']).toBe(reservedSequence);
    expect(recovered.generation).toBeGreaterThan(interrupted.generation);
    const recoveredPdf = recoveredState.files.find((file) => file.id === reservation.fileId)!;
    expect(recoveredPdf.id).toBe(reservation.fileId);
    expect(recoveredPdf.name).toBe(
      `${reservation.invoiceNumber.replace('/', '-')}-test-studio-2026-08.pdf`
    );
    expect(recoveredPdf.parents).toEqual([finalId]);
    expect(recoveredPdf.bytesBase64).not.toBe('');
    expect(sha256(Buffer.from(recoveredPdf.bytesBase64, 'base64'))).toBe(recoveredPdf.bodySha256);
    expectManagedProperties(recoveredPdf, {
      month: '2026-08',
      invoiceNumber: reservation.invoiceNumber,
    });
    expect(recoveredPdf.properties.lotusOperationId).toBe(reservation.operationId);
    expect(recoveredPdf.properties.lotusSourceSha256).toBe(reservation.sourceSha256);
  });
});
