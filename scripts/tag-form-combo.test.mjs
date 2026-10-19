import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

for (const lang of ['en', 'ru']) {
  test(`combo option labels (${lang})`, async (t) => {
    const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true, value: { getItem: () => lang },
    });
    const document = Object.getOwnPropertyDescriptor(globalThis, 'document');
    // The unrelated colour fields fall back to white when no canvas context is available.
    Object.defineProperty(globalThis, 'document', {
      configurable: true, value: { documentElement: {}, createElement: () => ({ getContext: () => null }) },
    });
    let vite;
    try {
      vite = await createServer({
        configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom',
      });
      const { renderTagForm, renderValueCombo } = await vite.ssrLoadModule('/src/edit/tag-form.ts');
      const feature = { key: 'way/1', tags: { building: 'yes', 'roof:shape': 'flat' } };
      const session = { get: () => feature, originalTags: () => feature.tags, isChanged: () => false };
      const html = renderTagForm(feature.key, session);
      // The roof combo follows its input and contains the roof icons.
      const roof = html.match(/<input[^>]*data-tag="roof:shape"[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/)?.[1];
      assert.ok(roof, 'roof-shape list is present');
      const flat = roof.match(/<li data-value="flat"[^>]*>([\s\S]*?)<\/li>/)?.[1];
      assert.ok(flat);

      await t.test('roof names are not repeated, while translations retain the OSM value', () => {
        assert.match(flat, /class="combo-icon"/);
        if (lang === 'en') {
          assert.match(flat, /<b>Flat<\/b>/);
          assert.doesNotMatch(flat, /<span>flat<\/span>/);
        } else {
          assert.match(flat, /<b>Плоская<\/b>/);
          assert.match(flat, /<span>flat<\/span>/);
        }
        assert.match(html, /data-tag="roof:shape"[^>]*value="flat"/);
        assert.match(roof, /<li data-value="flat" class="current">/);
      });

      await t.test('identical labels are shown only once, ignoring case', () => {
        const same = renderValueCombo(['flat'], '', '', '', { flat: 'FLAT' });
        assert.match(same, /<b>FLAT<\/b>/);
        assert.doesNotMatch(same, /<span>flat<\/span>/);
        const untranslated = renderValueCombo(['custom_roof'], '', 'custom_roof', '');
        assert.match(untranslated, /data-value="custom_roof" class="current"/);
        assert.match(untranslated, /<b>custom_roof<\/b>/);
        assert.doesNotMatch(untranslated, /<span>custom_roof<\/span>/);
      });

      await t.test('distinct descriptions and custom values stay escaped and selectable', () => {
        const distinct = renderValueCombo(['flat'], '', '', '', { flat: 'A & B <roof>' });
        assert.match(distinct, /<b>A &#38; B &#60;roof&#62;<\/b><span>flat<\/span>/);
        const custom = renderValueCombo(['flat'], '', 'odd"<roof>', '');
        assert.match(custom, /data-value="odd&#34;&#60;roof&#62;" class="current"/);
        assert.match(custom, /<b>odd&#34;&#60;roof&#62;<\/b>/);
        assert.doesNotMatch(custom, /<span>odd&#34;&#60;roof&#62;<\/span>/);
        assert.equal((custom.match(/data-value=/g) ?? []).length, 2);
      });
    } finally {
      await vite?.close();
      if (storage) Object.defineProperty(globalThis, 'localStorage', storage);
      else delete globalThis.localStorage;
      if (document) Object.defineProperty(globalThis, 'document', document);
      else delete globalThis.document;
    }
  });
}
