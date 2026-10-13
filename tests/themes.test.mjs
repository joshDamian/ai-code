// Every theme in web/themes.css has to be readable, and the picker has to offer exactly
// the themes the stylesheet defines. Contrast is computed, not judged: the WCAG ratio of
// each ink against every surface it can be drawn on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { THEMES } from '../web/theme.mjs';

const css = fs.readFileSync(new URL('../web/themes.css', import.meta.url), 'utf8');

/** @returns {Map<string, Record<string, string>>} */
function parse(text) {
  const out = new Map();
  for (const m of text.matchAll(/:root\[data-theme="([a-z-]+)"\]\{([^}]*)\}/g)) {
    out.set(m[1], Object.fromEntries([...m[2].matchAll(/(--[\w-]+|color-scheme):\s*([^;]+);/g)].map((d) => [d[1], d[2].trim()])));
  }
  return out;
}

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (hex) => {
  const [r, g, b] = rgb(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const themes = parse(css);
const SURFACES = ['--bg', '--surface-rail', '--surface-0', '--surface-1', '--surface-2', '--surface-3'];

test('the stylesheet defines the ten themes', () => {
  assert.equal(themes.size, 10);
});

for (const [id, t] of themes) {
  test(`${id} is readable on every surface`, () => {
    const worst = (ink) => Math.min(...SURFACES.map((s) => ratio(t[ink], t[s])));
    assert.ok(worst('--text') >= 7, `${id} text ${worst('--text').toFixed(2)}`);
    for (const ink of ['--muted', '--accent', '--good', '--warn', '--bad', '--info']) {
      assert.ok(worst(ink) >= 4.5, `${id} ${ink} ${worst(ink).toFixed(2)}`);
    }
    assert.ok(ratio(t['--on-accent'], t['--accent']) >= 4.5, `${id} button label`);
    assert.ok(ratio(t['--well-text'], t['--well-bg']) >= 7, `${id} code well`);
  });
}

test('the picker offers exactly the themes the stylesheet defines, with their colours', () => {
  const offered = THEMES.filter((t) => t.id !== 'classic');
  assert.deepEqual(offered.map((t) => t.id).sort(), [...themes.keys()].sort());
  for (const t of offered) {
    const s = themes.get(t.id);
    assert.equal(t.bg, s['--bg'], `${t.id} preview page`);
    assert.equal(t.surface, s['--surface-1'], `${t.id} preview card`);
    assert.equal(t.accent, s['--accent'], `${t.id} preview accent`);
    assert.equal(t.dark, s['color-scheme'] === 'dark', `${t.id} light or dark`);
  }
});
