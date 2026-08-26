import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const GOOGLE_CLIENT_SECRET_PREFIX = Buffer.from(['GOCSPX', ''].join('-'));

function filesBelow(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) visit(path);
      else result.push(path);
    }
  };
  visit(root);
  return result;
}

describe('Android OAuth bundle boundary', () => {
  it('excludes Google OAuth client secrets from emitted assets and source maps', () => {
    const output = mkdtempSync(join(tmpdir(), 'lotus-android-oauth-bundle-'));
    try {
      const build = spawnSync(
        'bunx',
        ['vite', 'build', '--outDir', output, '--emptyOutDir', '--sourcemap'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            TAURI_ENV_PLATFORM: 'android',
            TAURI_ENV_DEBUG: '',
          },
        }
      );
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

      const files = filesBelow(output);
      expect(files.some((path) => path.endsWith('.js'))).toBe(true);
      expect(files.some((path) => path.endsWith('.map'))).toBe(true);
      const violations = files
        .filter((path) => readFileSync(path).includes(GOOGLE_CLIENT_SECRET_PREFIX))
        .map((path) => relative(output, path));
      expect(violations).toEqual([]);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  }, 30_000);
});
