// @ts-check
// A browser a session can look through: find one on this machine, drive it over the
// DevTools protocol, and take pictures with it. The `verify-ui` skill shoots with it and
// the `design-check` gate audits through it.
//
// It drives Chrome directly, over a WebSocket, with nothing but this repo's own
// dependencies, so the gate runs wherever Bench runs - including in a project that has
// no browser tooling of its own. Nothing in here judges a page: it returns what the
// browser saw, and the caller decides what that means.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

/** A page that could not be rendered or read. Never a pass, never a defect. */
export class Unrenderable extends Error {}

const HOME = os.homedir();

/** Names a browser goes by on PATH, best first. @type {string[]} */
const ON_PATH = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome', 'chrome-headless-shell', 'msedge'];

/** Where macOS keeps them. @type {string[]} */
const MAC_APPS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

/**
 * Folders holding a browser someone else downloaded - Playwright's and Puppeteer's caches,
 * whose names end in the build number. Newest first, so a machine with several uses the
 * one it last installed.
 * @returns {string[]}
 */
function cacheRoots() {
  /** @type {string[]} */
  const roots = [];
  /** @param {string} base @param {string} pattern */
  const glob = (base, pattern) => {
    let names = [];
    try {
      names = fs.readdirSync(base);
    } catch {
      return;
    }
    const re = new RegExp(`^${pattern}$`);
    for (const name of names.filter((n) => re.test(n)).sort((a, b) => build(b) - build(a))) roots.push(path.join(base, name));
  };
  const pw = [path.join(HOME, '.cache', 'ms-playwright'), path.join(HOME, 'Library', 'Caches', 'ms-playwright')];
  for (const base of pw) {
    glob(base, 'chromium-\\d+');
    glob(base, 'chromium_headless_shell-\\d+');
  }
  glob(path.join(HOME, '.cache', 'puppeteer', 'chrome'), '\\d+\\.\\d+\\.\\d+\\.\\d+');
  glob(path.join(HOME, '.cache', 'puppeteer', 'chrome-headless-shell'), '\\d+\\.\\d+\\.\\d+\\.\\d+');
  return roots;
}

/** The build number in a cache folder's name, so the newest sorts first. @param {string} name */
const build = (name) => Number(/\d+(?=\D*$)/.exec(name)?.[0] || 0);

/** The executable inside one cache folder, wherever that build put it. @param {string} dir */
function fromCacheDir(dir) {
  for (const rel of [
    'chrome-linux64/chrome',
    'chrome-linux/chrome',
    'chrome-headless-shell-linux64/chrome-headless-shell',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
    'chrome-headless-shell-mac-arm64/chrome-headless-shell',
    'chrome-headless-shell-mac-x64/chrome-headless-shell',
    'chrome-win64/chrome.exe',
    'chrome-win/chrome.exe',
  ]) {
    const file = path.join(dir, rel);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** On PATH, if it is. @param {string} name */
function onPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      /* not this one */
    }
  }
  return null;
}

/**
 * A browser to drive: `BENCH_BROWSER` if it is set, else the first one found on PATH,
 * in the application folders, or in a Playwright or Puppeteer cache. Null when this
 * machine has none, which is a "could not look" and not a failure of the page.
 * @param {string} [explicit] a path the caller was given
 * @returns {string|null}
 */
export function findBrowser(explicit) {
  const said = explicit || process.env.BENCH_BROWSER;
  if (said) return fs.existsSync(said) ? said : null;
  for (const name of ON_PATH) {
    const found = onPath(name);
    if (found) return found;
  }
  for (const file of MAC_APPS) if (fs.existsSync(file)) return file;
  for (const dir of cacheRoots()) {
    const file = fromCacheDir(dir);
    if (file) return file;
  }
  return null;
}

/** What to tell a person whose machine has no browser. */
export const NO_BROWSER = `No Chrome or Chromium found. Install one, or point BENCH_BROWSER at the executable
(looked on PATH and in the Playwright and Puppeteer caches under ${path.join(HOME, '.cache')}).`;

/**
 * A short, real folder for the browser's own profile. Chrome puts a unix socket under
 * TMPDIR and gives up when the path is long, which it is inside a session's scratch
 * folder - so a browser never uses the scratch folder, whatever TMPDIR says.
 * @returns {string}
 */
function shortDir() {
  for (const base of ['/tmp', os.tmpdir()]) {
    try {
      fs.accessSync(base, fs.constants.W_OK);
      if (base.length > 60) continue;
      return fs.mkdtempSync(path.join(base, 'bench-browser-'));
    } catch {
      /* try the next one */
    }
  }
  throw new Unrenderable('Nowhere short to put a browser profile (tried /tmp).');
}

/** @typedef {(params?:any) => any} Send */
/** @typedef {(params:any) => void} Listener */
/** @typedef {{id:number, method:string, params:any, sessionId?:string}} Message */

/**
 * One connection to the browser, and the events it sends back. Commands are sent flat -
 * one socket, a session id per target - so a page and its browser never need two sockets.
 */
class Cdp {
  /** @type {WebSocket} */ #ws;
  /** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */ #pending = new Map();
  /** @type {Map<string, Set<Listener> >} */ #listeners = new Map();
  /** @type {Error|null} */ #dead = null;
  #id = 0;

  /** @param {WebSocket} ws */
  constructor(ws) {
    this.#ws = ws;
    ws.on('message', (raw) => {
      /** @type {Message & {result?:any, error?:{message:string}, sessionId?:string}} */
      let m;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      const key = `${m.sessionId || ''}/${m.method}`;
      if (m.id && this.#pending.has(m.id)) {
        const p = /** @type {{resolve:(v:any)=>void, reject:(e:Error)=>void}} */ (this.#pending.get(m.id));
        this.#pending.delete(m.id);
        if (m.error) p.reject(new Unrenderable(`${m.method}: ${m.error.message}`));
        else p.resolve(m.result);
      } else if (m.method) {
        for (const fn of this.#listeners.get(key) || []) fn(m.params);
      }
    });
    ws.on('error', (e) => this.#fail(new Unrenderable(`The browser connection failed: ${e.message}`)));
    ws.on('close', () => this.#fail(new Unrenderable('The browser closed the connection.')));
  }

  /** @param {Error} e */
  #fail(e) {
    this.#dead = e;
    for (const p of this.#pending.values()) p.reject(e);
    this.#pending.clear();
  }

  /** @param {string} method @param {any} [params] @param {string} [sessionId] @param {number} [timeoutMs] */
  send(method, params = {}, sessionId, timeoutMs = 20000) {
    if (this.#dead) return Promise.reject(this.#dead);
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Unrenderable(`${method} did not answer within ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.#ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  /** Listens for one event, per target. @param {string} method @param {string} sessionId @param {(p:any)=>void} fn */
  on(method, sessionId, fn) {
    const key = `${sessionId}/${method}`;
    /** @type {Set<Listener>} */
    const set = this.#listeners.get(key) || new Set();
    this.#listeners.set(key, set);
    set.add(fn);
    return () => set.delete(fn);
  }

  /** Resolves on the next `method`, or rejects after `timeoutMs`. @param {string} method @param {string} sessionId @param {number} timeoutMs */
  next(method, sessionId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const off = this.on(method, sessionId, (p) => {
        off();
        clearTimeout(timer);
        resolve(p);
      });
      const timer = setTimeout(() => {
        off();
        reject(new Unrenderable(`${method} never arrived within ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }
}

/** What the browser told us about the last navigation. @typedef {{ok:boolean, status:number|null, error:string|null}} Nav */

/**
 * A running browser with one page open. Every call is a page call: the gate audits one
 * page at a time, and a session's screenshots are of one page at a time.
 */
export class Browser {
  /** @type {import('node:child_process').ChildProcess} */ #proc;
  /** @type {Cdp} */ #cdp;
  /** @type {string} */ #session;
  /** @type {string} */ #profile;
  /** @type {Set<string>} */ #initScripts = new Set();
  /** @type {string[]} */ #notes = [];

  /** @param {import('node:child_process').ChildProcess} proc @param {Cdp} cdp @param {string} session @param {string} profile */
  constructor(proc, cdp, session, profile) {
    this.#proc = proc;
    this.#cdp = cdp;
    this.#session = session;
    this.#profile = profile;
  }

  /**
   * Starts a browser with a page of its own, and leaves the page enabled.
   * @param {{browser?:string, timeoutMs?:number}} [o]
   * @returns {Promise<Browser>}
   */
  static async launch(o = {}) {
    const exe = findBrowser(o.browser);
    if (!exe) throw new Unrenderable(NO_BROWSER);
    const profile = shortDir();
    // A headless shell is already headless; a full Chrome needs telling.
    const headless = /headless.shell/i.test(path.basename(exe)) ? [] : ['--headless=new'];
    const args = [
      ...headless,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--mute-audio',
      '--force-color-profile=srgb',
      '--hide-scrollbars',
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      '--window-size=1280,900',
      'about:blank',
    ];
    const proc = spawn(exe, args, {
      // TMPDIR too: Chrome's singleton socket lives there, and a long one is fatal.
      env: { ...process.env, TMPDIR: path.dirname(profile), TMP: path.dirname(profile) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    /** @type {string} */
    let said = '';
    const endpoint = await new Promise((resolve, reject) => {
      const done = setTimeout(() => reject(new Unrenderable(`The browser started but never opened a debugging port. ${said.trim()}`)), o.timeoutMs ?? 20000);
      proc.stderr?.on('data', (b) => {
        said += String(b);
        const m = /ws:\/\/\S+/.exec(said);
        if (m) {
          clearTimeout(done);
          resolve(m[0]);
        }
      });
      proc.on('exit', (code) => {
        clearTimeout(done);
        reject(new Unrenderable(`The browser exited at once (code ${code}). ${said.trim()}`));
      });
      proc.on('error', (e) => {
        clearTimeout(done);
        reject(new Unrenderable(`Could not start ${exe}: ${e.message}`));
      });
    }).catch((e) => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      throw e;
    });

    const cdp = await connect(endpoint);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Browser(proc, cdp, sessionId, profile);
    for (const domain of ['Page.enable', 'Runtime.enable', 'DOM.enable', 'CSS.enable', 'Network.enable']) await cdp.send(domain, {}, sessionId);
    // Chrome's first screenshot of a fresh profile can come back blank; one thrown away
    // here costs a moment and saves a person wondering why their picture is white.
    await page.setViewport(1280, 900);
    await page.#drain();
    return page;
  }

  /** Notes for the report: what the browser could not do, short of failing. @returns {string[]} */
  get notes() {
    return this.#notes;
  }

  /** @param {string} note */
  note(note) {
    if (!this.#notes.includes(note)) this.#notes.push(note);
  }

  /** Empties the events queued while nothing was listening. */
  async #drain() {
    await this.#cdp.send('Runtime.evaluate', { expression: '1' }, this.#session).catch(() => {});
  }

  /** @param {number} width @param {number} height */
  async setViewport(width, height) {
    await this.#cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, this.#session);
  }

  /**
   * The media a page is asked to believe it is being seen in: the theme, and whether the
   * person has asked for less motion.
   * @param {{colorScheme?:'light'|'dark', reducedMotion?:boolean}} o
   */
  async setMedia(o) {
    /** @type {Array<{name:string, value:string}>} */
    const features = [];
    if (o.colorScheme) features.push({ name: 'prefers-color-scheme', value: o.colorScheme });
    features.push({ name: 'prefers-reduced-motion', value: o.reducedMotion ? 'reduce' : 'no-preference' });
    await this.#cdp.send('Emulation.setEmulatedMedia', { features }, this.#session);
  }

  /** Runs before every page's own scripts, on this navigation and later ones. @param {string} source */
  async addInitScript(source) {
    if (this.#initScripts.has(source)) return;
    this.#initScripts.add(source);
    await this.#cdp.send('Page.addScriptToEvaluateOnNewDocument', { source }, this.#session);
  }

  /**
   * Loads a URL and waits for the page to finish loading. A navigation that fails, times
   * out, or answers 4xx/5xx is reported rather than thrown: the caller says whether that
   * is "could not look".
   * @param {string} url @param {number} [timeoutMs]
   * @returns {Promise<Nav>}
   */
  async goto(url, timeoutMs = 20000) {
    /** @type {Nav} */
    const nav = { ok: false, status: null, error: null };
    const offs = [
      this.#cdp.on('Network.responseReceived', this.#session, (p) => {
        if (p.type === 'Document' && nav.status === null) nav.status = p.response?.status ?? null;
      }),
      this.#cdp.on('Network.loadingFailed', this.#session, (p) => {
        if (p.type === 'Document' && !nav.error) nav.error = p.errorText || 'the request failed';
      }),
    ];
    // The wait for the load is made unable to reject: the navigation itself can fail
    // first, and a promise nobody is left holding would take the process down with it.
    const loaded = this.#cdp.next('Page.loadEventFired', this.#session, timeoutMs).then(
      () => null,
      (e) => /** @type {Error} */ (e),
    );
    try {
      const r = await this.#cdp.send('Page.navigate', { url }, this.#session, timeoutMs);
      // The same URL again, or one that differs only after the `#` - every route of a
      // hash-routed app - is a same-document navigation: no loader, so no load event,
      // and the wait above would time out. Reload instead, which is the fresh page
      // every other goto gives.
      if (r && !r.errorText && !r.loaderId) await this.#cdp.send('Page.reload', {}, this.#session, timeoutMs);
    } catch (e) {
      nav.error = e instanceof Error ? e.message : String(e);
    }
    const late = await loaded;
    if (!nav.error && late) nav.error = late.message;
    for (const off of offs) off();
    if (!nav.error && nav.status !== null && nav.status >= 400) nav.error = `the server answered ${nav.status}`;
    nav.ok = !nav.error;
    // Fonts and images settle after load; a little wait keeps a screenshot honest.
    if (nav.ok) await new Promise((r) => setTimeout(r, 60));
    return nav;
  }

  /**
   * Evaluates an expression in the page and brings the value back.
   * @param {string} expression
   * @param {{awaitPromise?:boolean, timeoutMs?:number}} [o]
   * @returns {Promise<any>}
   */
  async evaluate(expression, o = {}) {
    const r = await this.#cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: o.awaitPromise !== false, userGesture: true },
      this.#session,
      o.timeoutMs ?? 20000,
    );
    if (r?.exceptionDetails) {
      const said = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'the page threw';
      throw new Unrenderable(`The page threw while being read: ${String(said).split('\n')[0]}`);
    }
    return r?.result?.value;
  }

  /**
   * Makes the page believe these elements are hovered, focused, and so on. A CSS state
   * cannot be reached from the page's own script, so the browser is asked for it.
   * @param {Array<{nodeId:number, id:string}>} nodes @param {string[]} states
   */
  async forcePseudo(nodes, states) {
    for (const n of nodes) {
      await this.#cdp
        .send('CSS.forcePseudoState', { nodeId: n.nodeId, forcedPseudoClasses: states }, this.#session)
        .catch(() => this.note('some hover and focus states could not be forced'));
    }
  }

  /**
   * The elements matching a selector, in document order, with their ids on the page.
   * @param {string} selector
   * @returns {Promise<Array<{nodeId:number, id:string}>>}
   */
  async nodes(selector) {
    const { root } = await this.#cdp.send('DOM.getDocument', { depth: 0 }, this.#session);
    /** @type {number[]} */
    const nodeIds = (await this.#cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector }, this.#session)).nodeIds || [];
    if (!nodeIds.length) return [];
    /** @type {string[]} */
    const ids = await this.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)}), (e) => e.getAttribute('data-bc-id') || '')`);
    return nodeIds.map((nodeId, i) => ({ nodeId, id: ids[i] || '' }));
  }

  /**
   * Writes a PNG of the page as it stands. The whole page, not the window: a change below
   * the fold is still a change.
   * @param {string} file
   */
  async screenshot(file) {
    /** @type {string} */
    let data;
    try {
      ({ data } = await this.#cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, this.#session, 30000));
    } catch {
      // Older builds refuse to capture past the viewport; make the viewport the page.
      const height = Math.min(20000, await this.evaluate('Math.ceil(document.documentElement.scrollHeight)'));
      await this.setViewport(await this.evaluate('document.documentElement.clientWidth'), height || 900);
      ({ data } = await this.#cdp.send('Page.captureScreenshot', { format: 'png' }, this.#session, 30000));
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  /** Stops the browser and forgets its profile. */
  async close() {
    try {
      await this.#cdp.send('Browser.close', {}, undefined, 2000);
    } catch {
      /* closing the pipe below is enough */
    }
    try {
      this.#proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    // The browser writes its profile as it exits; a moment's wait stops the rm racing it.
    await new Promise((r) => setTimeout(r, 50));
    fs.rmSync(this.#profile, { recursive: true, force: true });
  }
}

/** @param {string} url @returns {Promise<Cdp>} */
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Unrenderable('The browser never answered on its debugging port.')), 20000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve(new Cdp(ws));
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(new Unrenderable(`Could not talk to the browser: ${e.message}`));
    });
  });
}
