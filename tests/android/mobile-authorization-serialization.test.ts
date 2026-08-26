import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pluginSourcePath = join(
  repositoryRoot,
  'src-tauri',
  'plugins',
  'lotus-mobile',
  'android',
  'src',
  'main',
  'java',
  'com',
  'houmus',
  'lotus_mobile',
  'LotusMobilePlugin.kt'
);

describe('Android Google authorization bridge', () => {
  it('serializes granted scopes as a JSON array', async () => {
    const source = await readFile(pluginSourcePath, 'utf8');

    expect(source).toContain('import app.tauri.plugin.JSArray');
    expect(source).toMatch(
      /\.put\(\s*"grantedScopes",\s*JSArray\.from\(result\.grantedScopes\.toTypedArray\(\)\),?\s*\)/
    );
    expect(source).not.toContain('.put("grantedScopes", result.grantedScopes)');
  });
});
