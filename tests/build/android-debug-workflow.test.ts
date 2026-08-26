import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

type WorkflowStep = {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};

describe('Android debug build workflow', () => {
  it('cross-compiles and uploads an ARM64 debug APK on the stable Ubuntu runner', () => {
    const path = join(process.cwd(), '.github', 'workflows', 'build-android-debug.yml');
    const workflow = parseYaml(readFileSync(path, 'utf8'));
    const job = workflow.jobs.android;
    const steps = job.steps as WorkflowStep[];

    expect(job['runs-on']).toBe('ubuntu-24.04');

    const rust = steps.find((step) => step.uses?.startsWith('dtolnay/rust-toolchain@'));
    expect(rust?.with?.targets).toBe('aarch64-linux-android');

    const install = steps.find((step) => step.run?.startsWith('bun install'));
    expect(install?.run).toBe('bun install --frozen-lockfile --ignore-scripts');

    const build = steps.find((step) => step.run?.includes('tauri android build'));
    expect(build?.run).toBe(
      'NDK_HOME="$ANDROID_NDK_HOME" bunx tauri android build --apk --target aarch64 --debug'
    );

    const upload = steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.with?.['if-no-files-found']).toBe('error');
    expect(upload?.with?.path).toContain('src-tauri/gen/android/app/build/outputs/apk/**/*.apk');
  });
});
