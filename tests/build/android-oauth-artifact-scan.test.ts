import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const DESKTOP_CLIENT_SECRET = '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';
const SCANNER = join(process.cwd(), 'scripts', 'scan-android-oauth-artifact.ts');

function artifact(root: string, name: string, contents: string): string {
  const source = join(root, `${name}-source`);
  mkdirSync(join(source, 'assets'), { recursive: true });
  writeFileSync(join(source, 'assets', 'index.js.map'), contents);
  const apk = join(root, `${name}.apk`);
  const zipped = spawnSync('zip', ['-qr', apk, '.'], { cwd: source, encoding: 'utf8' });
  expect(zipped.status, zipped.stderr).toBe(0);
  return apk;
}

describe('Android OAuth APK scanner', () => {
  it('accepts clean archives and rejects a secret in any decompressed asset', () => {
    const root = mkdtempSync(join(tmpdir(), 'lotus-android-oauth-scan-'));
    try {
      const clean = spawnSync('bun', [SCANNER, artifact(root, 'clean', 'clean source map')], {
        encoding: 'utf8',
      });
      expect(clean.status, `${clean.stdout}\n${clean.stderr}`).toBe(0);

      const contaminated = spawnSync(
        'bun',
        [SCANNER, artifact(root, 'contaminated', `prefix ${DESKTOP_CLIENT_SECRET} suffix`)],
        { encoding: 'utf8' }
      );
      expect(contaminated.status).toBe(1);
      expect(`${contaminated.stdout}\n${contaminated.stderr}`).toContain('assets/index.js.map');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
