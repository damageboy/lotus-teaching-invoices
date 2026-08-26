import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

type WorkflowStep = {
  env?: Record<string, string>;
  id?: string;
  if?: string;
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
    expect(workflow.permissions).toEqual({ contents: 'write' });
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

  it('publishes a stable Android asset to the shared tagged prerelease', () => {
    const androidPath = join(process.cwd(), '.github', 'workflows', 'build-android-release.yml');
    const android = parseYaml(readFileSync(androidPath, 'utf8'));
    const androidSteps = android.jobs.android.steps as WorkflowStep[];

    const prepare = androidSteps.find((step) => step.name === 'Prepare GitHub Release APK');
    expect(prepare?.if).toBe("startsWith(github.ref, 'refs/tags/')");
    expect(prepare?.run).toContain(
      'release-assets/Lotus.Teaching.Invoices_${VERSION}_android-arm64.apk'
    );

    const publish = androidSteps.find((step) => step.name === 'Publish GitHub prerelease');
    expect(publish?.if).toBe("startsWith(github.ref, 'refs/tags/')");
    expect(publish?.uses).toBe('softprops/action-gh-release@v3');
    expect(publish?.with).toMatchObject({
      name: '${{ github.ref_name }}',
      tag_name: '${{ github.ref_name }}',
      prerelease: true,
      files: 'release-assets/*.apk',
    });
    expect(publish?.with).not.toHaveProperty('generate_release_notes');

    const macPath = join(process.cwd(), '.github', 'workflows', 'build-macos.yml');
    const mac = parseYaml(readFileSync(macPath, 'utf8'));
    const macSteps = mac.jobs.build.steps as WorkflowStep[];
    const macPublish = macSteps.find((step) => step.name === 'Publish GitHub Release');
    expect(macPublish?.uses).toBe('softprops/action-gh-release@v3');
    expect(macPublish?.with?.prerelease).toBe(true);
    expect(macPublish?.with?.generate_release_notes).toBe(true);
  });
});
