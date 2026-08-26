import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const SCANNER = join(process.cwd(), 'scripts', 'scan-oauth-secrets.ts');

function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
}

function scan(root: string) {
  return spawnSync('bun', [SCANNER], { cwd: root, encoding: 'utf8' });
}

describe('tracked OAuth secret scanner', () => {
  it('accepts clean tracked files and identifies a leaked Google client secret', () => {
    const root = mkdtempSync(join(tmpdir(), 'lotus-oauth-source-scan-'));
    try {
      git(root, 'init', '-q');
      writeFileSync(join(root, 'clean.txt'), 'no credentials here');
      git(root, 'add', 'clean.txt');

      const clean = scan(root);
      expect(clean.status, `${clean.stdout}\n${clean.stderr}`).toBe(0);

      const canary = ['GOCSPX', 'not-a-real-oauth-client-secret'].join('-');
      writeFileSync(join(root, 'leaked.txt'), `prefix ${canary} suffix`);
      git(root, 'add', 'leaked.txt');

      const leaked = scan(root);
      expect(leaked.status).toBe(1);
      expect(`${leaked.stdout}\n${leaked.stderr}`).toContain('leaked.txt');
      expect(`${leaked.stdout}\n${leaked.stderr}`).not.toContain(canary);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
