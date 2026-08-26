import * as e2eHelpers from './helpers.js';

type WebdriverAppEnvironment = (
  inherited: NodeJS.ProcessEnv,
  runRoot: string,
  calendarApiBase: string
) => NodeJS.ProcessEnv;

describe('WDIO application environment', () => {
  it('supplies Calendar, Drive, and Gmail bases from the one fake Google origin', () => {
    const builder = Reflect.get(e2eHelpers, 'webdriverAppEnvironment') as
      | WebdriverAppEnvironment
      | undefined;
    expect(builder).toBeTypeOf('function');
    if (!builder) return;

    expect(
      builder(
        { PATH: '/usr/bin' },
        '/tmp/lotus-calendar-e2e-test',
        'http://127.0.0.1:43127/calendar/v3'
      )
    ).toMatchObject({
      PATH: '/usr/bin',
      LOTUS_E2E_RUN_ROOT: '/tmp/lotus-calendar-e2e-test',
      LOTUS_E2E_CALENDAR_API_BASE: 'http://127.0.0.1:43127/calendar/v3',
      LOTUS_E2E_DRIVE_API_BASE: 'http://127.0.0.1:43127/drive/v3',
      LOTUS_E2E_DRIVE_UPLOAD_BASE: 'http://127.0.0.1:43127/upload/drive/v3',
      LOTUS_E2E_GMAIL_API_BASE: 'http://127.0.0.1:43127/gmail/v1',
      LOTUS_E2E_SUPPRESS_OPEN_FILE: '1',
    });
  });
});
