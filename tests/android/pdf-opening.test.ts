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

describe('Android cached PDF opening contract', () => {
  it('launches an ACTION_VIEW PDF and handles no viewer without package-visibility preflight', async () => {
    const source = await readFile(pluginSourcePath, 'utf8');

    expect(source).toMatch(/Intent\(Intent\.ACTION_VIEW\)/);
    expect(source).toMatch(/\.setDataAndType\(uri, "application\/pdf"\)/);
    expect(source).toMatch(/\.addFlags\(Intent\.FLAG_GRANT_READ_URI_PERMISSION\)/);
    expect(source).toMatch(/activity\.startActivity\(intent\)/);
    expect(source).toMatch(/catch \(error: ActivityNotFoundException\)/);
    expect(source).toMatch(/invoke\.reject\("No PDF viewer is installed"\)/);
    expect(source).not.toContain('resolveActivity');
  });
});
