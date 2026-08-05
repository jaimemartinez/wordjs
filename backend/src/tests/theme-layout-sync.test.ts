const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// themes.ts resolves ./themes when the module is loaded, so isolate both its filesystem and DB.
const ORIGINAL_CWD = process.cwd();
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-theme-layout-sync-'));
const THEMES_ROOT = path.join(TMP_ROOT, 'themes');
fs.mkdirSync(THEMES_ROOT, { recursive: true });
process.chdir(TMP_ROOT);

const ACTIVE_LAYOUT = {
  components: {
    Card: { root: { borderRadius: '18px' } },
    Grid: { root: { gap: '24px' } }
  },
  containerWidth: '1180px'
};

function writeTheme(slug: string, layout: Record<string, any>) {
  const dir = path.join(THEMES_ROOT, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({
    name: slug,
    version: '1.0.0',
    layout
  }));
}

// Put an unrelated alphabetically-first directory in the fixture. A missing active slug must not
// acquire this theme merely because scanThemes() happened to enumerate it first.
writeTheme('aaa-unrelated', { marker: 'must-never-be-used-as-fallback' });
writeTheme('active-theme', ACTIVE_LAYOUT);
writeTheme('default', { marker: 'default' });

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const { getOption, updateOption } = require('../core/options');
const { addAction, removeAction } = require('../core/hooks');
const { getActiveTheme, getActiveThemeSnapshot, syncActiveThemeLayout } = require('../core/themes');

async function countLayoutWrites(run: () => Promise<void>) {
  let writes = 0;
  const count = (name: string) => {
    if (name === 'active_theme_layout') writes += 1;
  };
  addAction('updated_option', count);
  try {
    await run();
  } finally {
    removeAction('updated_option', count);
  }
  return writes;
}

describe('active theme layout boot sync', { concurrency: false }, () => {
  before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
  });

  beforeEach(async () => {
    await updateOption('template', 'active-theme');
    await updateOption('active_theme_mods', '');
  });

  after(async () => {
    await database.closeDatabase();
    process.chdir(ORIGINAL_CWD);
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  });

  it('does not rewrite when getOption returns the same layout as an object', async () => {
    const serialized = JSON.stringify(ACTIVE_LAYOUT);
    await updateOption('active_theme_layout', serialized);
    assert.deepStrictEqual(await getOption('active_theme_layout'), ACTIVE_LAYOUT);

    const writes = await countLayoutWrites(async () => {
      assert.strictEqual(await syncActiveThemeLayout(), serialized);
      assert.strictEqual(await syncActiveThemeLayout(), serialized);
    });

    assert.strictEqual(writes, 0);
  });

  it('does not rewrite when getOption returns the same layout as a JSON string', async () => {
    const serialized = JSON.stringify(ACTIVE_LAYOUT);
    // One extra JSON layer makes getOption parse the DB value to a string, reproducing the alternate
    // representation accepted by the settings stack.
    await updateOption('active_theme_layout', JSON.stringify(serialized));
    assert.strictEqual(await getOption('active_theme_layout'), serialized);

    const writes = await countLayoutWrites(async () => {
      assert.strictEqual(await syncActiveThemeLayout(), serialized);
    });

    assert.strictEqual(writes, 0);
  });

  it('updates a stale layout once, then remains idempotent', async () => {
    await updateOption('active_theme_layout', JSON.stringify({ stale: true }));

    const writes = await countLayoutWrites(async () => {
      await syncActiveThemeLayout();
      await syncActiveThemeLayout();
    });

    assert.strictEqual(writes, 1);
    assert.deepStrictEqual(await getOption('active_theme_layout'), ACTIVE_LAYOUT);
  });

  it('does not use another installed theme when the persisted active slug is missing', async () => {
    await updateOption('template', 'missing-theme');
    await updateOption('active_theme_layout', JSON.stringify({ stale: true }));

    assert.strictEqual(await getActiveTheme(), null);
    const writes = await countLayoutWrites(async () => {
      assert.strictEqual(await syncActiveThemeLayout(), '');
      assert.strictEqual(await syncActiveThemeLayout(), '');
    });

    assert.strictEqual(writes, 1);
    assert.strictEqual(await getOption('active_theme_layout'), '');
  });

  it('returns slug, manifest layout and customizer mods as one runtime snapshot', async () => {
    const mods = { '--wjs-color-primary': '#b45309' };
    await updateOption('active_theme_mods', JSON.stringify(mods));

    assert.deepStrictEqual(await getActiveThemeSnapshot(), {
      slug: 'active-theme',
      layout: ACTIVE_LAYOUT,
      mods
    });
  });
});
