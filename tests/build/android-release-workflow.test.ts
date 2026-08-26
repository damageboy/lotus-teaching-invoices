import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

type WorkflowStep = {
  env?: Record<string, string>;
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};

describe('Android release build workflow', () => {
  it('signs, verifies, scans, and uploads an ARM64 release APK', () => {
    const path = join(process.cwd(), '.github', 'workflows', 'build-android-release.yml');
    const workflow = parseYaml(readFileSync(path, 'utf8'));
    const job = workflow.jobs.android;
    const steps = job.steps as WorkflowStep[];

    expect(job['runs-on']).toBe('ubuntu-24.04');
    expect(workflow.on.push.tags).toEqual(['v*']);

    const rust = steps.find((step) => step.uses?.startsWith('dtolnay/rust-toolchain@'));
    expect(rust?.with?.targets).toBe('aarch64-linux-android');

    const signing = steps.find((step) => step.name === 'Configure Android signing');
    expect(signing?.env).toEqual({
      ANDROID_KEY_ALIAS: '${{ secrets.ANDROID_KEY_ALIAS }}',
      ANDROID_KEY_BASE64: '${{ secrets.ANDROID_KEY_BASE64 }}',
      ANDROID_KEY_PASSWORD: '${{ secrets.ANDROID_KEY_PASSWORD }}',
    });
    expect(signing?.run).toContain('src-tauri/gen/android/keystore.properties');

    const build = steps.find((step) => step.run?.includes('tauri android build'));
    expect(build?.run).toBe(
      'NDK_HOME="$ANDROID_NDK_HOME" bunx tauri android build --apk --target aarch64'
    );

    const verify = steps.find((step) => step.name === 'Verify release APK');
    expect(verify?.id).toBe('release');
    expect(verify?.run).toContain('apksigner');
    expect(verify?.run).toContain('verify:android-oauth-artifact');

    const upload = steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.with?.name).toBe('lotus-android-arm64-release');
    expect(upload?.with?.path).toBe('${{ steps.release.outputs.apk }}');
    expect(upload?.with?.['if-no-files-found']).toBe('error');
  });
});
