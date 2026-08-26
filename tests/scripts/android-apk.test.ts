import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '../..');
const sourceScriptPath = join(projectRoot, 'scripts/android-apk.sh');

interface Fixture {
  root: string;
  projectRoot: string;
  scriptPath: string;
  binDir: string;
  logPath: string;
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'lotus-android-apk-'));
  const fixtureProjectRoot = join(root, 'project');
  const scriptsDir = join(fixtureProjectRoot, 'scripts');
  const binDir = join(root, 'bin');
  const fixtureScriptPath = join(scriptsDir, 'android-apk.sh');

  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  copyFileSync(sourceScriptPath, fixtureScriptPath);
  chmodSync(fixtureScriptPath, 0o755);

  return {
    root,
    projectRoot: fixtureProjectRoot,
    scriptPath: fixtureScriptPath,
    binDir,
    logPath: join(root, 'commands.log'),
  };
}

function fixtureEnv(fixture: Fixture, values: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${fixture.binDir}:${process.env.PATH}`,
    COMMAND_LOG: fixture.logPath,
    ...values,
  };
}

function writeBuildFake(fixture: Fixture): void {
  writeExecutable(
    join(fixture.binDir, 'bunx'),
    `#!/usr/bin/env bash
set -eu
printf 'bunx %s\\n' "$*" >> "$COMMAND_LOG"
mkdir -p "$(dirname "$FAKE_APK_PATH")"
: > "$FAKE_APK_PATH"
`
  );
}

function apkPath(fixture: Fixture, mode: 'debug' | 'release'): string {
  return join(
    fixture.projectRoot,
    `src-tauri/gen/android/app/build/outputs/apk/arm64/${mode}/app-arm64-${mode}.apk`
  );
}

describe('android-apk.sh', () => {
  it('builds, installs, and launches a fresh aarch64 debug APK on the only USB device', () => {
    const fixture = createFixture();
    const builtApk = apkPath(fixture, 'debug');
    const staleApk = join(
      fixture.projectRoot,
      'src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk'
    );

    writeBuildFake(fixture);
    mkdirSync(join(staleApk, '..'), { recursive: true });
    writeFileSync(staleApk, 'stale');
    writeExecutable(
      join(fixture.binDir, 'adb'),
      `#!/usr/bin/env bash
set -eu
printf 'adb %s\\n' "$*" >> "$COMMAND_LOG"
if [[ "$*" == "devices -l" ]]; then
  printf 'List of devices attached\\nusb-123 device product:pixel model:Pixel_8 device:husky transport_id:2\\n'
fi
`
    );

    try {
      execFileSync('bash', [fixture.scriptPath, 'debug', 'device'], {
        cwd: fixture.projectRoot,
        env: fixtureEnv(fixture, { FAKE_APK_PATH: builtApk }),
        stdio: 'pipe',
      });

      expect(existsSync(staleApk)).toBe(false);
      expect(readFileSync(fixture.logPath, 'utf8')).toBe(
        [
          'adb devices -l',
          'bunx tauri android build --apk --target aarch64 --debug',
          `adb -s usb-123 install -r ${builtApk}`,
          'adb -s usb-123 shell am start -n com.houmus.teaching_invoices/.MainActivity',
          '',
        ].join('\n')
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('builds and launches a release APK on an explicitly selected USB device', () => {
    const fixture = createFixture();
    const builtApk = apkPath(fixture, 'release');

    writeBuildFake(fixture);
    writeExecutable(
      join(fixture.binDir, 'adb'),
      `#!/usr/bin/env bash
set -eu
printf 'adb %s\\n' "$*" >> "$COMMAND_LOG"
if [[ "$*" == "devices -l" ]]; then
  printf 'List of devices attached\\nusb-123 device product:pixel model:Pixel_8 device:husky transport_id:2\\nusb-456 device product:pixel model:Pixel_9 device:tokay transport_id:3\\n'
fi
`
    );

    try {
      execFileSync('bash', [fixture.scriptPath, 'release', 'device', '--device', 'usb-456'], {
        cwd: fixture.projectRoot,
        env: fixtureEnv(fixture, { FAKE_APK_PATH: builtApk }),
        stdio: 'pipe',
      });

      expect(readFileSync(fixture.logPath, 'utf8')).toBe(
        [
          'adb devices -l',
          'bunx tauri android build --apk --target aarch64',
          `adb -s usb-456 install -r ${builtApk}`,
          'adb -s usb-456 shell am start -n com.houmus.teaching_invoices/.MainActivity',
          '',
        ].join('\n')
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('locally signs an unsigned release APK before installing it', () => {
    const fixture = createFixture();
    const unsignedApk = join(
      fixture.projectRoot,
      'src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk'
    );
    const signedApk = unsignedApk.replace('-unsigned.apk', '-local.apk');
    const debugKeystore = join(fixture.root, 'home/.android/debug.keystore');

    writeBuildFake(fixture);
    mkdirSync(join(debugKeystore, '..'), { recursive: true });
    writeFileSync(debugKeystore, 'debug key');
    writeExecutable(
      join(fixture.binDir, 'apksigner'),
      `#!/usr/bin/env bash
set -eu
printf 'apksigner %s\\n' "$*" >> "$COMMAND_LOG"
if [[ "$1" == "sign" ]]; then
  while [[ "$1" != "--out" ]]; do shift; done
  cp "\${FAKE_UNSIGNED_APK}" "$2"
fi
`
    );
    writeExecutable(
      join(fixture.binDir, 'adb'),
      `#!/usr/bin/env bash
set -eu
printf 'adb %s\\n' "$*" >> "$COMMAND_LOG"
if [[ "$*" == "devices -l" ]]; then
  printf 'List of devices attached\\nusb-123 device product:pixel model:Pixel_8 device:husky transport_id:2\\n'
fi
`
    );

    try {
      execFileSync('bash', [fixture.scriptPath, 'release', 'device'], {
        cwd: fixture.projectRoot,
        env: fixtureEnv(fixture, {
          HOME: join(fixture.root, 'home'),
          FAKE_APK_PATH: unsignedApk,
          FAKE_UNSIGNED_APK: unsignedApk,
        }),
        stdio: 'pipe',
      });

      const commands = readFileSync(fixture.logPath, 'utf8').trim().split('\n');
      expect(commands).toContain(
        `apksigner sign --ks ${debugKeystore} --ks-key-alias androiddebugkey --ks-pass pass:android --key-pass pass:android --out ${signedApk} ${unsignedApk}`
      );
      expect(commands).toContain(`apksigner verify ${signedApk}`);
      expect(commands).toContain(`adb -s usb-123 install -r ${signedApk}`);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('starts the only available AVD before building and launching the debug APK', () => {
    const fixture = createFixture();
    const builtApk = apkPath(fixture, 'debug');
    const bootMarker = join(fixture.root, 'emulator-started');

    writeBuildFake(fixture);
    writeExecutable(
      join(fixture.binDir, 'emulator'),
      `#!/usr/bin/env bash
set -eu
printf 'emulator %s\\n' "$*" >> "$COMMAND_LOG"
if [[ "$*" == "-list-avds" ]]; then
  printf 'Lotus_API_36\\n'
else
  : > "$EMULATOR_BOOT_MARKER"
fi
`
    );
    writeExecutable(
      join(fixture.binDir, 'adb'),
      `#!/usr/bin/env bash
set -eu
printf 'adb %s\\n' "$*" >> "$COMMAND_LOG"
if [[ "$*" == "devices -l" ]]; then
  printf 'List of devices attached\\n'
  if [[ -f "$EMULATOR_BOOT_MARKER" ]]; then
    printf 'emulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\\n'
  fi
elif [[ "$*" == "-s emulator-5554 shell getprop sys.boot_completed" ]]; then
  printf '1\\n'
fi
`
    );

    try {
      execFileSync('bash', [fixture.scriptPath, 'debug', 'emulator'], {
        cwd: fixture.projectRoot,
        env: fixtureEnv(fixture, {
          EMULATOR_BOOT_MARKER: bootMarker,
          FAKE_APK_PATH: builtApk,
        }),
        stdio: 'pipe',
      });

      const commands = readFileSync(fixture.logPath, 'utf8').trim().split('\n');
      expect(commands).toContain('emulator -list-avds');
      expect(commands).toContain('emulator -avd Lotus_API_36');
      expect(commands).toContain('adb -s emulator-5554 shell getprop sys.boot_completed');
      expect(commands).toContain('bunx tauri android build --apk --target aarch64 --debug');
      expect(commands).toContain(`adb -s emulator-5554 install -r ${builtApk}`);
      expect(commands.at(-1)).toBe(
        'adb -s emulator-5554 shell am start -n com.houmus.teaching_invoices/.MainActivity'
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('fails with a numbered list when multiple USB devices need selection', () => {
    const fixture = createFixture();

    writeBuildFake(fixture);
    writeExecutable(
      join(fixture.binDir, 'adb'),
      `#!/usr/bin/env bash
printf 'adb %s\\n' "$*" >> "$COMMAND_LOG"
if [[ "$*" == "devices -l" ]]; then
  printf 'List of devices attached\\nusb-123 device product:pixel model:Pixel_8 device:husky transport_id:2\\nusb-456 device product:pixel model:Pixel_9 device:tokay transport_id:3\\n'
fi
`
    );

    try {
      const result = spawnSync('bash', [fixture.scriptPath, 'debug', 'device'], {
        cwd: fixture.projectRoot,
        env: fixtureEnv(fixture),
        encoding: 'utf8',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('1) usb-123');
      expect(result.stderr).toContain('2) usb-456');
      expect(readFileSync(fixture.logPath, 'utf8')).toBe('adb devices -l\n');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    'android:debug:device',
    'android:release:device',
    'android:debug:emulator',
    'android:release:emulator',
  ])('exposes the %s package command', (command) => {
    const result = spawnSync('bun', ['run', command, '--', '--help'], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('android-apk.sh <debug|release> <device|emulator> [options]');
  });
});
