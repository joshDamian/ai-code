// The design gate, run the way a task's check runs it: as a child process against a page
// served over HTTP, judged by its exit code. The pages under fixtures/design are what the
// gate is held to - one that keeps the rules, one with a defect planted for every rule, and
// one that never wrote its values down as tokens - and the apps that broke it in real use:
// a hash-routed one, one that picks its own theme, one whose body text is deliberately
// small, and one whose shell is fixed at the window's height with a pane that scrolls.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tmp } from './tmp.mjs';
import { findBrowser } from '../pack/browser.mjs';

const GATE = new URL('../pack/skills/design-check/design-check.mjs', import.meta.url).pathname;
const FIXTURES = new URL('./fixtures/design/', import.meta.url).pathname;

// Looking costs a browser launch, which is the slow part, so it is settled once here and
// the tests that need one are skipped on a machine that has none - the gate itself would
// answer 2, which is a fact about the machine rather than about the page.
const browser = findBrowser();
const looking = browser ? {} : { skip: 'no browser on this machine' };

/** @type {Map<string, {url:string, server:http.Server}>} */
const served = new Map();

/** Serves one fixture folder, as a dev server would. @param {string} name */
function serve(name) {
  const dir = path.join(FIXTURES, name);
  const server = http.createServer((req, res) => {
    const file = path.join(dir, req.url === '/' ? 'index.html' : decodeURIComponent(/** @type {string} */ (req.url).split('?')[0]));
    let body;
    try {
      body = fs.readFileSync(file);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not here');
      return;
    }
    res.writeHead(200, { 'content-type': file.endsWith('.css') ? 'text/css' : 'text/html' }).end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      served.set(name, { url: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`, server });
      resolve(served.get(name));
    });
  });
}

/**
 * Runs the gate and reads its verdict the only way a check can: the exit code.
 * @param {string} cwd @param {string[]} args @param {Record<string,string|undefined>} [env]
 */
function gate(cwd, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GATE, ...args], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (err += b));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

/** A throwaway copy of a fixture, for a run that writes files. @param {string} name */
function copy(name) {
  const dir = tmp('design');
  fs.cpSync(path.join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

before(async () => {
  for (const name of ['good', 'bad', 'plain', 'small', 'hash', 'theme', 'scroll']) await serve(name);
});

after(() => {
  for (const { server } of served.values()) server.close();
});

test('a page that keeps the rules passes, and the pass says what was looked at', looking, async () => {
  const { url } = /** @type {any} */ (served.get('good'));
  const { code, out } = await gate(path.join(FIXTURES, 'good'), ['--url', url]);
  assert.equal(code, 0, `expected a pass, got:\n${out}`);
  assert.match(out, /clean/);
  // A pass that does not say what it saw is worth nothing, so the states it looked at are
  // in the line - including the ones a person only reaches with a mouse or a tab key.
  assert.match(out, /hover and focus/);
  assert.match(out, /reduced motion/);
  assert.match(out, /tokens from tokens\.css/);
});

test('a project that never wrote its values down as tokens is not held to any', looking, async () => {
  const { url } = /** @type {any} */ (served.get('plain'));
  const { code, out } = await gate(path.join(FIXTURES, 'plain'), ['--url', url]);
  assert.equal(code, 0, `a hardcoded colour is only a defect where tokens exist, got:\n${out}`);
  assert.match(out, /no design-token file found/);
});

test('a planted defect is caught for every rule the gate keeps', looking, async () => {
  const { url } = /** @type {any} */ (served.get('bad'));
  const { code, out } = await gate(path.join(FIXTURES, 'bad'), ['--url', url, '--json']);
  assert.equal(code, 1, `expected a defect, got:\n${out}`);
  const report = JSON.parse(out);
  const found = report.findings.filter((/** @type {any} */ f) => f.route === '/');

  /** What the fixture planted, and the rule that has to name it. */
  const planted = [
    ['contrast', 'div.hardcoded', /4\.5:1/],
    ['target', 'button.tiny', /20x20px/],
    ['type', 'div.small', /14px text/],
    ['spacing', '.off-grid', /7px is off the 8px grid/],
    ['tokens', '.hardcoded', /is a colour written out/],
    ['semantics', 'div.submit', /not a <button> or a link/],
    ['focus', 'button', /nothing about it changes when it is focused/],
    ['overflow', 'div.wide', /scrolls sideways at 280px/],
    ['motion', 'div.spin', /still moving/],
  ];
  for (const [rule, selector, detail] of planted) {
    const hit = found.find((/** @type {any} */ f) => f.rule === rule && f.selector.includes(selector) && detail.test(f.detail));
    assert.ok(hit, `${rule}: nothing matched ${selector} ${detail} in\n${found.map((/** @type {any} */ f) => `${f.rule} ${f.selector} ${f.detail}`).join('\n')}`);
  }
  // The contrast rule is asked of the dark theme too: ink written for a white page is
  // unreadable on midnight, and only a run in the dark theme can see that.
  assert.ok(
    found.some((/** @type {any} */ f) => f.rule === 'contrast' && f.theme === 'dark' && /rgb\(31, 41, 55\) on rgb\(11, 18, 32\)/.test(f.detail)),
    'the dark theme was rendered and its contrast measured',
  );
  // The headings and body text of the page itself are fine, so nothing should be said
  // about them: a gate that cries wolf gets turned off.
  assert.equal(found.filter((/** @type {any} */ f) => /h1|\.muted/.test(f.selector)).length, 0);
});

test('the screenshots a session shows as evidence are written at both widths', looking, async () => {
  const dir = copy('good');
  const { url } = /** @type {any} */ (served.get('good'));
  const { code, out } = await gate(dir, ['--url', url, '--only-shots', '--shots', '.bench/evidence', '--label', 'after']);
  assert.equal(code, 0, `expected the shots to be written, got:\n${out}`);
  const [desktop, mobile] = ['after-home-1280.png', 'after-home-390.png'].map((f) => path.join(dir, '.bench', 'evidence', f));
  for (const file of [desktop, mobile]) assert.ok(fs.existsSync(file), `${file} was not written`);
  // A file that is not a picture of the right width is not evidence of anything.
  for (const [file, width] of [[desktop, 1280], [mobile, 390]]) {
    const png = fs.readFileSync(file);
    assert.equal(png.subarray(1, 4).toString(), 'PNG', `${file} is not a PNG`);
    assert.equal(png.readUInt32BE(16), width, `${file} is not ${width}px wide`);
  }
});

test('a design review gets both themes and the clicked state, and no picture of a click that missed', looking, async () => {
  const dir = copy('good');
  const { url } = /** @type {any} */ (served.get('good'));
  const { code, out } = await gate(dir, ['--url', url, '--only-shots', '--shots', 'shots', '--shots-widths', '390', '--shots-themes', 'light,dark', '--click', 'button', '--click', '#nowhere', '--json']);
  assert.equal(code, 0, `expected the shots to be written, got:\n${out}`);
  const written = fs.readdirSync(path.join(dir, 'shots')).sort();
  assert.deepEqual(written, ['home-390-button-dark.png', 'home-390-button.png', 'home-390-dark.png', 'home-390.png']);
  assert.ok(JSON.parse(out).notes.some((/** @type {string} */ n) => /#nowhere: nothing matches it/.test(n)), 'the missed click is said, not silently skipped');
});

test('a config file in the project is read, and what it ignores is left alone', looking, async () => {
  const dir = copy('bad');
  fs.mkdirSync(path.join(dir, '.bench'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.bench', 'design-check.json'), JSON.stringify({ themes: ['light'], ignore: ['.spin', '.wide'] }));
  const { url } = /** @type {any} */ (served.get('bad'));
  const { code, out } = await gate(dir, ['--url', url, '--json']);
  assert.equal(code, 1, `the rest of the page is still a defect, got:\n${out}`);
  const report = JSON.parse(out);
  const rules = new Set(report.findings.map((/** @type {any} */ f) => f.rule));
  assert.ok(!rules.has('motion'), 'the ignored animation is left alone');
  assert.ok(!rules.has('overflow'), 'the ignored element is left alone');
  assert.ok(rules.has('target') && rules.has('contrast'), 'and the rest is still judged');
  assert.deepEqual([...new Set(report.findings.map((/** @type {any} */ f) => f.theme))].filter(Boolean), ['light'], 'only the theme the config asks for');
});

/** A PNG's height, from its header. @param {string} file */
const pngHeight = (file) => fs.readFileSync(file).readUInt32BE(20);

test('a hash-routed app is looked at on every route, and each shot is named for its route', looking, async () => {
  const dir = copy('hash');
  const { url } = /** @type {any} */ (served.get('hash'));
  // From / to /#/settings is a same-document navigation: no load event ever comes, and the
  // gate used to wait for one, give up, and say it could not look.
  const { code, out } = await gate(dir, ['--url', url, '--routes', '/,/#/settings', '--shots', 'shots', '--shots-widths', '390', '--json']);
  assert.equal(code, 0, `expected both routes looked at and passed, got:\n${out}`);
  const report = JSON.parse(out);
  assert.equal(report.looked, 2);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'shots')).sort(), ['home-390.png', 'settings-390.png'], 'the second route is not shot over the first as "home"');
});

test('a full-page shot reaches the bottom of a pane that scrolls inside a fixed shell', looking, async () => {
  const dir = copy('scroll');
  const { url } = /** @type {any} */ (served.get('scroll'));
  const { code, out } = await gate(dir, ['--url', url, '--only-shots', '--shots', 'shots', '--shots-widths', '1280']);
  assert.equal(code, 0, `expected the shot to be written, got:\n${out}`);
  const height = pngHeight(path.join(dir, 'shots', 'home-1280.png'));
  // The pane holds 3000px of content in a 900px window. Taller than the window is the bug
  // fixed; not much taller than the content is the box with a height of its own left alone.
  assert.ok(height > 3000, `the shot is ${height}px tall, so it stopped short of the pane's bottom`);
  assert.ok(height < 3600, `the shot is ${height}px tall, padded past the content`);
  // And the page it leaves behind is the size it was: the next shot, at 390, is not 3000px of window.
  const again = await gate(dir, ['--url', url, '--only-shots', '--shots', 'again', '--shots-widths', '390,1280']);
  assert.equal(again.code, 0, again.out);
  assert.ok(pngHeight(path.join(dir, 'again', 'home-1280.png')) < 3600);
});

test('an app that picks its own theme is shot in each theme through the project\'s theme script', looking, async () => {
  const dir = copy('theme');
  const { url } = /** @type {any} */ (served.get('theme'));
  const shoot = async (/** @type {string} */ into, /** @type {string[]} */ extra) => {
    const { code, out } = await gate(dir, ['--url', url, '--only-shots', '--shots', into, '--shots-widths', '390', '--shots-themes', 'light,dark', ...extra]);
    assert.equal(code, 0, `expected the shots to be written, got:\n${out}`);
    return ['home-390.png', 'home-390-dark.png'].map((f) => fs.readFileSync(path.join(dir, into, f)));
  };
  // prefers-color-scheme alone: this app never asks it, so "dark" is the light page again.
  const [plainLight, plainDark] = await shoot('media', []);
  assert.ok(plainLight.equals(plainDark), 'without a theme script both themes are the same picture - the problem the script solves');
  const [light, dark] = await shoot('scripted', ['--theme-script', 'theme.js']);
  assert.ok(!light.equals(dark), 'with the theme script, dark is a different picture');
  assert.ok(light.equals(plainLight), 'and light is still light');

  // The audit's themes go through it too, and from the config as well as the flag: the
  // dark theme renders with light ink on midnight, and a script that throws is never a pass.
  fs.mkdirSync(path.join(dir, '.bench'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.bench', 'design-check.json'), JSON.stringify({ themeScript: 'theme.js' }));
  const audited = await gate(dir, ['--url', url, '--json']);
  assert.equal(audited.code, 0, audited.out);
  fs.writeFileSync(path.join(dir, 'broken.js'), "throw new Error('no such setting');\n");
  const broken = await gate(dir, ['--url', url, '--theme-script', 'broken.js']);
  assert.equal(broken.code, 2, broken.out);
  assert.match(broken.out, /could not look - the theme script broken\.js threw .*no such setting/);
  const missing = await gate(dir, ['--url', url, '--theme-script', 'nowhere.js']);
  assert.equal(missing.code, 2, missing.out);
  assert.match(missing.out, /could not read the theme script nowhere\.js/);
});

test('the smallest body text is the project\'s to set, and 16px when it has not', looking, async () => {
  const { url } = /** @type {any} */ (served.get('small'));
  const strict = await gate(path.join(FIXTURES, 'small'), ['--url', url, '--json']);
  assert.equal(strict.code, 1, `14px body text is a defect by default, got:\n${strict.out}`);
  const type = JSON.parse(strict.out).findings.filter((/** @type {any} */ f) => f.rule === 'type');
  assert.ok(type.length && type.every((/** @type {any} */ f) => /14px text, and body text is 16px at the smallest/.test(f.detail)));
  const dense = await gate(path.join(FIXTURES, 'small'), ['--url', url, '--body-px', '14']);
  assert.equal(dense.code, 0, `a project that set 14px passes at 14px, got:\n${dense.out}`);
  const stricter = await gate(path.join(FIXTURES, 'small'), ['--url', url, '--body-px', '15', '--json']);
  assert.match(stricter.out, /14px text, and body text is 15px at the smallest/);
  const nonsense = await gate(path.join(FIXTURES, 'small'), ['--url', url, '--body-px', 'big']);
  assert.equal(nonsense.code, 2, nonsense.out);
});

test('a page it could not look at is never a pass', async () => {
  const { url } = /** @type {any} */ (served.get('good'));
  // Nothing to look at, nowhere to look, and a browser that is not there. Each of these
  // is 2, not 0: a gate that cannot see must never report the page as fine.
  const cases = [
    { why: 'no url', cwd: tmp('design'), args: [], env: {} },
    { why: 'an option nobody knows', cwd: tmp('design'), args: ['--url', url, '--nope'], env: {} },
    { why: 'a browser that is not installed', cwd: tmp('design'), args: ['--url', url], env: { BENCH_BROWSER: '/nonexistent/browser' } },
    { why: 'shots asked for with nowhere to put them', cwd: tmp('design'), args: ['--url', url, '--only-shots'], env: {} },
    { why: 'a theme that does not exist', cwd: tmp('design'), args: ['--url', url, '--themes', 'sepia'], env: {} },
  ];
  if (browser) {
    // A port nothing is listening on, and a route the app does not have.
    const dead = http.createServer();
    await new Promise((r) => dead.listen(0, '127.0.0.1', () => r(null)));
    const port = /** @type {any} */ (dead.address()).port;
    await new Promise((r) => dead.close(() => r(null)));
    cases.push({ why: 'an app that is not running', cwd: tmp('design'), args: ['--url', `http://127.0.0.1:${port}`], env: {} });
    cases.push({ why: 'a route the app does not have', cwd: tmp('design'), args: ['--url', url, '--routes', '/nowhere'], env: {} });
  }
  for (const c of cases) {
    const { code, out } = await gate(c.cwd, c.args, c.env);
    assert.equal(code, 2, `${c.why}: expected 2, got ${code}:\n${out}`);
    assert.match(out, /could not look/, c.why);
  }
});
