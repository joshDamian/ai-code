// @ts-check
// The design gate: render a page in a real browser and hold it to the mechanical rules -
// contrast, touch targets, type size, the spacing grid, design tokens, real buttons,
// focus, overflow, motion.
//
//   0  the page passed every rule
//   1  the page broke at least one rule, and here is which
//   2  it could not look: no browser, a page that would not render, a rule that could not
//      be measured. Never a pass - a gate that cannot see must not say "fine".
//
// It judges only what a machine can judge. Whether the layout is right, whether the change
// is the one that was asked for, whether the design is any good: that is what `verify-ui`
// and a person's eyes are for.

import fs from 'node:fs';
import path from 'node:path';
import { Browser, Unrenderable, findBrowser, NO_BROWSER } from '../../browser.mjs';

const USAGE = `design-check - render a page and hold it to the mechanical rules.

  node design-check.mjs [options]

  --url <url>           the running app, e.g. http://127.0.0.1:5173
  --routes <a,b>        routes to audit (default: /)
  --config <file>       a JSON file of these options (default: .bench/design-check.json if it exists)
  --tokens <file>       the design-token file; without one the token rules are skipped
  --widths <a,b>        widths the overflow rule is measured at (default: 280,320,414)
  --width <px>          the viewport everything else is measured at (default: 1280)
  --themes <a,b>        themes contrast is checked in (default: light,dark)
  --grid <px>           the spacing grid (default: 8)
  --ignore <sel,...>    selectors to leave alone
  --shots <dir>         also write screenshots here (they are the before/after evidence)
  --shots-widths <a,b>  widths for --shots (default: 1280,390)
  --only-shots          screenshots only, no audit
  --label <name>        prefix for screenshot names, e.g. "after"
  --wait <ms>           wait this long for the app to answer before giving up
  --browser <path>      the browser executable (or set BENCH_BROWSER)
  --json                findings as JSON
  --help                this

  exit 0 pass, 1 a defect, 2 could not look
`;

/** One thing wrong with the page. @typedef {{rule:string, route:string, theme:string, state:string, viewport:string, selector:string, detail:string}} Finding */

// ---------------------------------------------------------------------------
// What the page is asked, in its own words

/**
 * Everything the rules need about one rendering of the page, as plain values, so it can
 * cross back over the DevTools connection. Hover and focus are put on the elements by the
 * browser before this runs, so each pass sees the styles that state really produces.
 *
 * The selectors are written out here rather than shared with the code around it: this
 * function is stringified and run in the page, where nothing outside it exists.
 * @param {{ignore:string[]}} opts
 */
function pageAudit(opts) {
  const TAG = 'data-bc-id';
  const NATIVE = 'a[href],button,input,select,textarea,summary,details,[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=menuitem],[role=option],[contenteditable=""],[contenteditable=true]';
  const INTERACTIVE = `${NATIVE},[onclick],[data-bc-click]`;
  const FOCUSABLE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex]';
  /** @type {any} */ const w = globalThis;
  w.__bcSeq = w.__bcSeq || 0;

  /** @param {any} el */
  const ignored = (el) => {
    if (el.closest('[data-design-check-ignore]')) return true;
    return opts.ignore.some((/** @type {string} */ sel) => {
      try {
        return !!el.closest(sel);
      } catch {
        return false;
      }
    });
  };
  /** @param {any} el */
  const idOf = (el) => el.getAttribute(TAG) || (el.setAttribute(TAG, String(++w.__bcSeq)), el.getAttribute(TAG));
  /** @param {any} el */
  const shown = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0.5 && r.height > 0.5;
  };
  /** @param {any} el */
  const where = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    for (const c of String(el.getAttribute('class') || '').trim().split(/\s+/).slice(0, 2)) if (c) s += `.${c}`;
    return s;
  };
  /** @param {any} el */
  const words = (el) => String(el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);

  /**
   * The first background a person would see behind this text, and whether a picture or a
   * gradient is in the way of knowing it.
   * @param {any} el
   */
  const behind = (el) => {
    let node = el;
    let image = false;
    while (node && node.nodeType === 1) {
      const cs = getComputedStyle(node);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') image = true;
      if (!/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor)) return { color: cs.backgroundColor, image };
      node = node.parentElement;
    }
    return { color: 'rgb(255, 255, 255)', image };
  };

  /** @type {any[]} */ const texts = [];
  /** @type {any[]} */ const targets = [];
  /** @type {any[]} */ const clickables = [];
  /** @type {any[]} */ const focusables = [];
  /** @type {any[]} */ const motion = [];
  /** @type {any[]} */ const overflow = [];
  /** What is sticking out that the project asked to be left alone. @type {any[]} */
  const overflowIgnored = [];
  const clientWidth = document.documentElement.clientWidth;

  // The page element is in the list too: a `body` set wider than the viewport is not one of
  // its own descendants, and nothing else would catch it.
  for (const el of [document.body, ...document.querySelectorAll('body *')]) {
    const skip = ignored(el);
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const on = shown(el);

    if (on && (rect.right > clientWidth + 1 || rect.left < -1)) {
      (skip ? overflowIgnored : overflow).push({ selector: where(el), text: words(el), right: Math.round(rect.right), left: Math.round(rect.left), width: Math.round(rect.width) });
    }
    if (skip) continue;
    if (on && ((cs.animationName !== 'none' && parseFloat(cs.animationDuration) > 0.05) || parseFloat(cs.transitionDuration) > 0.2)) {
      motion.push({ selector: where(el), animation: cs.animationName === 'none' ? '0s' : cs.animationDuration, transition: cs.transitionDuration });
    }

    if (el.matches(INTERACTIVE) && on) {
      idOf(el);
      targets.push({
        selector: where(el),
        w: Math.round(rect.width * 10) / 10,
        h: Math.round(rect.height * 10) / 10,
        // A link inside a sentence is not a tap target that has to stand on its own: WCAG
        // exempts it, and a word in a paragraph cannot be 24px tall.
        inline: cs.display === 'inline' && Array.from(el.parentElement?.childNodes || []).some((n) => n.nodeType === 3 && String(n.textContent).trim()),
      });
      const native = el.matches(NATIVE) || el.closest('a[href],button,label,summary');
      if (!native && !['body', 'html'].includes(el.tagName.toLowerCase())) {
        /** @type {any} */ const any = el; // a framework's own bookkeeping lives on the element
        const props = Object.keys(any).find((k) => k.startsWith('__reactProps$'));
        const onClick = props ? any[props]?.onClick : null;
        const vue = Object.keys(any).some((k) => k.startsWith('__vnode') || k.startsWith('__vueParentComponent'));
        if (el.hasAttribute('onclick') || typeof any.onclick === 'function') clickables.push({ selector: where(el), why: 'an onclick' });
        else if (el.hasAttribute('data-bc-click')) clickables.push({ selector: where(el), why: 'a click listener' });
        else if (onClick) clickables.push({ selector: where(el), why: 'a React onClick' });
        else if (vue) clickables.push({ selector: where(el), why: 'a Vue click handler' });
      }
    }

    if (el.matches(FOCUSABLE) && !el.hasAttribute('disabled') && el.getAttribute('tabindex') !== '-1' && on) {
      focusables.push({
        id: idOf(el),
        selector: where(el),
        style: {
          outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`,
          shadow: cs.boxShadow,
          border: cs.borderColor,
          background: cs.backgroundColor,
          color: cs.color,
          decoration: cs.textDecorationLine,
        },
      });
    }

    if (on && Array.from(el.childNodes).some((n) => n.nodeType === 3 && String(n.textContent).trim())) {
      const bg = behind(el);
      texts.push({
        selector: where(el),
        text: words(el),
        size: Math.round(parseFloat(cs.fontSize) * 100) / 100,
        weight: Number(cs.fontWeight) || 400,
        color: cs.color,
        bg: bg.color,
        bgImage: bg.image,
        heading: /^h[1-6]$/.test(el.tagName.toLowerCase()) || el.getAttribute('role') === 'heading',
        interactive: !!el.closest(INTERACTIVE),
      });
    }
  }
  return { viewport: { clientWidth, scrollWidth: document.documentElement.scrollWidth }, texts, targets, clickables, focusables, motion, overflow, overflowIgnored };
}

/**
 * The values written in the page's own stylesheets, with `var()` still in them - the only
 * place a hardcoded value is still visible, since a computed style has resolved every
 * token away - along with the token names the page declares anywhere.
 * @param {{tokens:string}} opts the token file's name, whose own values are the tokens
 */
function pageDeclared(opts) {
  /** The property a declaration has to be written as a token, and which kind it is. */
  const kindOf = (/** @type {string} */ prop) => {
    if (/color$/.test(prop) || prop === 'color') return 'color';
    if (/^(box-shadow|text-shadow)$/.test(prop)) return 'shadow';
    if (/^(margin|padding)(-top|-right|-bottom|-left)?$/.test(prop) || /^(row-)?gap$/.test(prop) || prop === 'column-gap') return 'space';
    return null;
  };
  /** `padding-top` and `padding-right` are the one `padding` a person wrote. @param {string} prop */
  const baseProp = (prop) => prop.replace(/^border-(top|right|bottom|left)-(color|width|style)$/, 'border-$2').replace(/-(top|right|bottom|left)$/, '');

  /** @type {any[]} */ const declared = [];
  /** @type {Set<string>} */ const tokens = new Set();
  /**
   * A rule has declarations and it has inner rules - a media query has only inner rules,
   * a style rule usually has both (an empty inner list, which is why neither may be
   * assumed away). A value written with `var()` in it reads back as empty longhands,
   * since a browser cannot expand a shorthand it does not yet know: only what was written
   * out is visible here, which is exactly what these rules are about.
   * @param {any} rule @param {string} origin
   */
  const walk = (rule, origin) => {
    const style = rule.style;
    if (style) {
      const selector = rule.selectorText || (rule.keyText ? `${rule.parentRule?.name || '@keyframes'} ${rule.keyText}` : '');
      for (const prop of style) {
        const value = style.getPropertyValue(prop);
        if (!value) continue;
        if (prop.startsWith('--')) {
          tokens.add(prop);
          continue;
        }
        const what = kindOf(prop);
        if (what) declared.push({ origin, selector, prop: baseProp(prop), value, what, inline: false });
      }
    }
    if (rule.cssRules) for (const inner of rule.cssRules) walk(inner, origin);
  };

  for (const sheet of Array.from(document.styleSheets)) {
    if (opts.tokens && String(sheet.href || '').split('/').pop() === opts.tokens) continue;
    /** @type {any} */
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // another origin's stylesheet: not this page's to read
    }
    for (const rule of Array.from(rules || [])) walk(rule, sheet.href ? String(sheet.href).split('/').pop() || '<style>' : '<style>');
  }
  for (const el of Array.from(document.querySelectorAll('[style]'))) {
    /** @type {any} */ const inline = el;
    for (const prop of inline.style) {
      if (prop.startsWith('--')) {
        tokens.add(prop);
        continue;
      }
      const what = kindOf(prop);
      if (what) declared.push({ origin: 'a style attribute', selector: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : ''), prop: baseProp(prop), value: inline.style.getPropertyValue(prop), what, inline: true });
    }
  }
  return { declared, tokens: Array.from(tokens) };
}

// ---------------------------------------------------------------------------
// Reading values

/** @type {Record<string, number[]>} */
const NAMED = { transparent: [0, 0, 0, 0], white: [255, 255, 255, 1], black: [0, 0, 0, 1] };

/**
 * A colour as red, green, blue and alpha, or null when the text is not one.
 * @param {string} value
 * @returns {number[]|null}
 */
function color(value) {
  const v = String(value).trim().toLowerCase();
  if (NAMED[v]) return NAMED[v];
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(v);
  if (fn) {
    const parts = fn[2].split(/[\s,/]+/).filter(Boolean).map((p) => Number(p.replace('%', '')));
    const alpha = parts.length > 3 ? (parts[3] > 1 ? parts[3] / 100 : parts[3]) : 1;
    if (fn[1].startsWith('rgb')) return [parts[0] || 0, parts[1] || 0, parts[2] || 0, alpha];
    const [h, s, l] = [(parts[0] || 0) / 360, (parts[1] || 0) / 100, (parts[2] || 0) / 100];
    const f = (/** @type {number} */ n) => {
      const k = (n + h * 12) % 12;
      return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [f(0) * 255, f(8) * 255, f(4) * 255, alpha];
  }
  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex) {
    const h = hex[1];
    const at = (/** @type {number} */ i) => parseInt(h.length <= 4 ? h[i] + h[i] : h.slice(i * 2, i * 2 + 2), 16);
    return [at(0), at(1), at(2), h.length === 4 || h.length === 8 ? at(3) / 255 : 1];
  }
  return null;
}

/** The same colour written the same way, so `#fff` and `rgb(255, 255, 255)` compare equal. @param {string} value */
function sameColor(value) {
  const c = color(value);
  return c ? `${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${Math.round(c[3] * 100) / 100}` : null;
}

/** How readable one colour is on another, 1 to 21. @param {string} fg @param {string} bg */
function contrast(fg, bg) {
  const a = color(fg);
  const b = color(bg);
  if (!a || !b) return null;
  // Text with alpha sits on the background, so blend it before measuring.
  const mix = (/** @type {number} */ i) => a[i] * a[3] + b[i] * (1 - a[3]);
  /** @param {number[]} c */
  const lum = (c) => {
    const f = (/** @type {number} */ v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const [l1, l2] = [lum([mix(0), mix(1), mix(2)]), lum([b[0], b[1], b[2]])].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/**
 * A length in pixels, or null when the value is not one. `em` and `rem` are read against
 * the root size, which is how a type and spacing scale is written down.
 * @param {string} text @param {number} root
 */
function px(text, root) {
  const m = /^(-?\d*\.?\d+)(px|rem|em|pt|in|cm|mm)?$/.exec(String(text).trim());
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'rem':
    case 'em':
      return n * root;
    case 'pt':
      return (n * 96) / 72;
    case 'in':
      return n * 96;
    case 'cm':
      return (n * 96) / 2.54;
    case 'mm':
      return (n * 96) / 25.4;
    case 'px':
      return n;
    default:
      return n === 0 ? 0 : null;
  }
}

/** Every length written out in a value: the literals a token is supposed to have replaced. @param {string} value */
const lengthLiterals = (value) => String(value).match(/-?\d*\.?\d+(px|rem|em|pt|in|cm|mm)\b/g) || [];

/**
 * The colour literals in a value, `var()` references and pictures left out. A named colour
 * - `rebeccapurple` - is a colour too, and a gradient's stops are colours to replace.
 * @param {string} value
 */
function colorLiterals(value) {
  // A `var()` reference and a `url()` are taken out first: `var(--ink)` is a colour that
  // comes from a token, and `url(tomato.png)` is not the colour tomato.
  const text = String(value).replace(/url\([^)]*\)/g, ' ').replace(/var\([^)]*\)/g, ' ');
  const found = text.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)|\b[a-zA-Z]{3,}\b/g) || [];
  return found.filter((l) => !EXEMPT.has(l.toLowerCase()));
}

/** Values that are structure rather than design: they are nobody's tokens. */
const EXEMPT = new Set(['0', '0px', '1px', 'auto', 'none', 'normal', 'inherit', 'initial', 'unset', 'revert', 'currentcolor', 'transparent', 'solid', 'dotted', 'dashed', 'double', 'groove', 'ridge', 'inset', 'outset', 'hidden', 'visible', 'clip', 'collapse', 'sticky', 'relative', 'absolute', 'fixed', 'static', 'inline', 'block', 'contents']);

// ---------------------------------------------------------------------------
// The rules

/**
 * Is every value a project writes on the spacing grid, and does every value come from a
 * token when the project keeps a token file? Both questions are asked of the stylesheets,
 * not of the computed page: this is about what was written down.
 * @param {{declared:any[], tokens:Set<string>, colors:Set<string>, lengths:Set<number>, hasTokens:boolean, grid:number, root:number, route:string, theme:string}} o
 * @returns {Finding[]}
 */
function declaredFindings(o) {
  /** @type {Finding[]} */
  const out = [];
  for (const d of o.declared) {
    /** @type {string[]} */
    const why = [];
    const vars = String(d.value).match(/var\(\s*(--[\w-]+)/g)?.map((v) => v.replace(/var\(\s*/, '')) || [];
    for (const v of vars) if (!o.tokens.has(v)) why.push(`${v} is used but never declared`);

    if (o.hasTokens && (d.what === 'color' || d.what === 'shadow')) {
      const escaped = colorLiterals(d.value).filter((l) => !o.colors.has(String(sameColor(l))));
      if (escaped.length) why.push(`${escaped.join(', ')} ${escaped.length > 1 ? 'are colours written out' : 'is a colour written out'} rather than taken from a token`);
    }
    if (d.what === 'space') {
      /** @type {number[]} */
      const nums = lengthLiterals(d.value)
        .map((n) => px(n, o.root))
        .filter((n) => n !== null)
        .map((n) => /** @type {number} */ (n))
        .filter((n) => Math.abs(n) > 1);
      for (const n of nums) {
        if (o.grid > 0 && n % o.grid !== 0) why.push(`${n}px is off the ${o.grid}px grid`);
        if (o.hasTokens && !o.lengths.has(n)) why.push(`${n}px is not one of the spacing tokens`);
      }
    }
    if (why.length) {
      const rule = d.what === 'space' ? 'spacing' : 'tokens';
      out.push({ rule, route: o.route, theme: o.theme, state: '', viewport: '', selector: `${d.selector} { ${d.prop}: ${d.value} }`, detail: `${[...new Set(why)].join('; ')} (${d.origin})` });
    }
  }
  return out;
}

/**
 * Text on its background. A heading big enough to read as one is held to 3:1; all other
 * text, and all small text, to 4.5:1.
 * @param {{texts:any[], route:string, theme:string, state:string, interactiveOnly:boolean}} o
 * @returns {Finding[]}
 */
function contrastFindings(o) {
  /** @type {Finding[]} */
  const out = [];
  for (const t of o.texts) {
    if (o.interactiveOnly && !t.interactive) continue;
    if (t.bgImage) continue; // a picture or a gradient behind the words: any ratio would be a guess
    const big = t.size >= 24 || (t.size >= 18.66 && t.weight >= 700);
    const want = t.heading && big ? 3 : 4.5;
    const ratio = contrast(t.color, t.bg);
    if (ratio === null || ratio + 0.005 >= want) continue;
    out.push({
      rule: 'contrast',
      route: o.route,
      theme: o.theme,
      state: o.state,
      viewport: '',
      selector: t.selector,
      detail: `${ratio.toFixed(2)}:1, under the ${want}:1 ${t.heading && big ? 'large heading' : 'text'} is allowed - "${t.text}" ${t.color} on ${t.bg}`,
    });
  }
  return out;
}

/**
 * A tap target a thumb can hit, and text a person can read without leaning in.
 * @param {any} seen @param {string} route @param {string} theme
 */
function sizeFindings(seen, route, theme) {
  /** @type {Finding[]} */
  const out = [];
  for (const t of seen.targets) {
    if (t.inline || (t.w >= 24 && t.h >= 24)) continue;
    out.push({ rule: 'target', route, theme, state: '', viewport: '', selector: t.selector, detail: `${t.w}x${t.h}px, under the 24x24px a touch target needs` });
  }
  for (const t of seen.texts) {
    if (t.heading || t.size >= 16) continue;
    out.push({ rule: 'type', route, theme, state: '', viewport: '', selector: t.selector, detail: `${t.size}px text, and body text is 16px at the smallest - "${t.text}"` });
  }
  return out;
}

/** @param {any} seen @param {string} route @param {string} theme */
function semanticsFindings(seen, route, theme) {
  /** @type {Finding[]} */
  const out = [];
  for (const c of seen.clickables) {
    out.push({
      rule: 'semantics',
      route,
      theme,
      state: '',
      viewport: '',
      selector: c.selector,
      detail: `clickable but not a <button> or a link: it answers to ${c.why}. A div cannot be reached with a keyboard and says nothing to a screen reader`,
    });
  }
  return out;
}

/**
 * Elements that do not look any different when they are focused.
 * @param {any[]} plain what they looked like before @param {any[]} focused what they look like focused
 * @param {string} route @param {string} theme
 */
function focusFindings(plain, focused, route, theme) {
  /** @type {Map<string, string>} */
  const before = new Map(plain.map((f) => [f.id, JSON.stringify(f.style)]));
  /** @type {Finding[]} */
  const out = [];
  for (const f of focused) {
    const was = before.get(f.id);
    if (was === undefined || was !== JSON.stringify(f.style)) continue;
    out.push({ rule: 'focus', route, theme, state: 'focus', viewport: '', selector: f.selector, detail: 'nothing about it changes when it is focused: no ring, no outline, no colour' });
  }
  return out;
}

/**
 * The page scrolling sideways, and what is doing it. Only what is not being ignored counts:
 * a widget the project has said the gate cannot judge must not leave an unfixable finding
 * behind. An overflow nothing in the page explains - a wider-than-viewport page element, a
 * pseudo-element, a box a stylesheet grew - is still reported, with no selector to blame.
 * @param {any} seen @param {string} route @param {string} theme @param {number} width
 */
function overflowFindings(seen, route, theme, width) {
  const over = (/** @type {any} */ e) => e.right > seen.viewport.clientWidth + 1 || e.left < -1;
  const worst = seen.overflow.filter(over).slice(0, 3);
  if (!worst.length) {
    if (seen.viewport.scrollWidth <= seen.viewport.clientWidth + 1) return [];
    if (seen.overflowIgnored.some(over)) return [];
    worst.push(null);
  }
  const who = worst.map((/** @type {any} */ e) => (e ? `${e.selector} (${e.width}px wide)` : 'nothing on its own - something is wider than the page')).join(', ');
  return [{ rule: 'overflow', route, theme, state: '', viewport: `${width}px`, selector: worst[0]?.selector || '', detail: `the page scrolls sideways at ${width}px: ${who}` }];
}

/** @param {any[]} motion @param {string} route */
function motionFindings(motion, route) {
  return motion.slice(0, 8).map((m) => ({
    rule: 'motion',
    route,
    theme: '',
    state: '',
    viewport: '',
    selector: m.selector,
    detail: `still moving (${m.animation !== '0s' ? `animation ${m.animation}` : `transition ${m.transition}`}) with prefers-reduced-motion set`,
  }));
}

// ---------------------------------------------------------------------------
// The run

/** @param {string[]} argv @param {Record<string, any>} base */
function options(argv, base) {
  /** @type {Record<string, any>} */
  const o = { routes: ['/'], widths: [280, 320, 414], themes: ['light', 'dark'], shotsWidths: [1280, 390], ignore: [], grid: 8, width: 1280, wait: 0, json: false, ...base };
  const list = (/** @type {string} */ v) => String(v).split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].includes('=') ? argv[i].split(/=(.*)/s) : [argv[i], null];
    const next = () => (inline !== null ? inline : argv[++i]);
    switch (flag) {
      case '--url': o.url = next(); break;
      case '--routes': o.routes = list(next()); break;
      case '--config': o.config = next(); break;
      case '--tokens': o.tokens = next(); break;
      case '--widths': o.widths = list(next()).map(Number); break;
      case '--width': o.width = Number(next()); break;
      case '--themes': o.themes = list(next()); break;
      case '--grid': o.grid = Number(next()); break;
      // Added to what the config file already ignores, rather than replacing it: a run that
      // names one extra selector must not silently drop the project's own exceptions.
      case '--ignore': o.ignore = [...o.ignore, ...list(next())]; break;
      case '--shots': o.shots = next(); break;
      case '--shots-widths': o.shotsWidths = list(next()).map(Number); break;
      case '--only-shots': o.onlyShots = true; break;
      case '--label': o.label = next(); break;
      case '--wait': o.wait = Number(next()); break;
      case '--browser': o.browser = next(); break;
      case '--json': o.json = true; break;
      case '--help':
      case '-h': o.help = true; break;
      default: throw new Unrenderable(`Unknown option ${flag}\n\n${USAGE}`);
    }
  }
  return o;
}

/** @param {string} url @param {string} route */
function join(url, route) {
  if (/^https?:\/\//.test(route)) return route;
  return `${String(url).replace(/\/+$/, '')}${route.startsWith('/') ? route : `/${route}`}`;
}

/** `/settings/billing` reads as `settings-billing` in a file name. @param {string} route */
const slug = (route) => route.replace(/[?#].*$/, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') || 'home';

/** Where a project would keep a token file. @param {string} cwd */
function findTokens(cwd) {
  for (const rel of ['tokens.css', 'design-tokens.json', 'tokens.json', 'src/tokens.css', 'src/styles/tokens.css', 'styles/tokens.css', 'app/tokens.css', 'src/design-tokens.json', 'src/styles/tokens.json']) {
    if (fs.existsSync(path.join(cwd, rel))) return rel;
  }
  return null;
}

/**
 * The tokens a project has written down: their names, their colours, and the lengths
 * among them. A CSS file gives names as well as values; a JSON file gives values.
 * @param {string} file
 * @returns {{names:Set<string>, colors:Set<string>, lengths:Set<number>}}
 */
function readTokens(file) {
  const names = new Set();
  const colors = new Set();
  const lengths = new Set();
  /** @param {string} value */
  const take = (value) => {
    const c = sameColor(value);
    if (c) colors.add(c);
    const n = px(value, 16);
    if (n !== null) lengths.add(n);
  };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Unrenderable(`Could not read the token file ${file}: ${/** @type {Error} */ (e).message}`);
  }
  if (file.endsWith('.json')) {
    /** @param {any} node */
    const walk = (node) => {
      if (node && typeof node === 'object') for (const v of Object.values(node)) walk(v);
      else if (typeof node === 'string' || typeof node === 'number') take(String(node).trim());
      else if (typeof node === 'object' && node?.value) take(String(node.value).trim());
    };
    try {
      walk(JSON.parse(text));
    } catch (e) {
      throw new Unrenderable(`Could not read the token file ${file}: ${/** @type {Error} */ (e).message}`);
    }
    return { names, colors, lengths };
  }
  for (const m of text.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) {
    names.add(m[1]);
    take(m[2].trim());
  }
  return { names, colors, lengths };
}

/** Nothing that could not be looked at is ever a pass. @param {string} reason */
function couldNotLook(reason) {
  process.stdout.write(`design-check: could not look - ${reason}\n`);
  return 2;
}

async function main() {
  /** @type {Record<string, any>} */
  let o;
  try {
    // The config file is read first so the command line can override any of it.
    const args = process.argv.slice(2);
    const at = args.findIndex((a) => a === '--config' || a.startsWith('--config='));
    const named = at >= 0 ? (args[at].includes('=') ? args[at].split('=')[1] : args[at + 1]) : fs.existsSync('.bench/design-check.json') ? '.bench/design-check.json' : null;
    /** @type {Record<string, any>} */
    let saved = {};
    if (named) {
      try {
        saved = JSON.parse(fs.readFileSync(named, 'utf8'));
        saved.config = named;
      } catch (e) {
        return couldNotLook(`could not read ${named}: ${/** @type {Error} */ (e).message}`);
      }
    }
    o = options(args, saved);
  } catch (e) {
    return couldNotLook(/** @type {Error} */ (e).message);
  }
  if (o.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (o.onlyShots && !o.shots) return couldNotLook('--only-shots needs --shots <dir>');
  if (!o.url) return couldNotLook(`no --url, and no url in ${o.config || 'a config file'}\n\n${USAGE}`);
  for (const theme of o.themes) if (!['light', 'dark'].includes(theme)) return couldNotLook(`--themes takes light or dark, not ${theme}`);
  for (const n of [...o.widths, o.width, ...o.shotsWidths]) if (!(n > 0)) return couldNotLook(`a width has to be a number of pixels, not ${n}`);

  const cwd = process.cwd();
  const tokens = o.tokens || findTokens(cwd);
  /** @type {{names:Set<string>, colors:Set<string>, lengths:Set<number>}} */
  let tokenFile = { names: new Set(), colors: new Set(), lengths: new Set() };
  if (tokens) {
    try {
      tokenFile = readTokens(path.resolve(cwd, tokens));
    } catch (e) {
      return couldNotLook(/** @type {Error} */ (e).message);
    }
  }
  if (!findBrowser(o.browser)) return couldNotLook(NO_BROWSER);

  /** @type {Finding[]} */
  const findings = [];
  /** @type {string[]} */
  const shots = [];
  /** @type {Browser|null} */
  let page = null;
  let looked = 0;
  try {
    page = await Browser.launch({ browser: o.browser });
    // A click that is not a button is worth catching wherever it is written, including in
    // a framework that never puts an onclick attribute on the element.
    await page.addInitScript(`(() => {
      const add = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function (type, ...rest) {
        if (type === 'click' && this instanceof Element) this.setAttribute('data-bc-click', '');
        return add.call(this, type, ...rest);
      };
    })();`);

    for (const route of o.routes) {
      const url = join(o.url, route);
      const deadline = Date.now() + (o.wait || 0);
      let nav = await page.goto(url);
      while (!nav.ok && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        nav = await page.goto(url);
      }
      if (!nav.ok) throw new Unrenderable(`${url} did not render: ${nav.error}`);

      // Nothing below can be trusted if the browser will not put an element into hover or
      // focus, so that is settled before a single rule is judged.
      if (!o.onlyShots && !(await focusStatesWork(page))) {
        throw new Unrenderable('this browser would not show an element in its hover and focus states, so the states a person clicks and tabs through cannot be checked');
      }
      looked++;

      const audit = `(${pageAudit})(${JSON.stringify({ ignore: o.ignore })})`;
      const declared = `(${pageDeclared})(${JSON.stringify({ tokens: tokens ? path.basename(tokens) : '' })})`;

      // What the stylesheets declare is the same whatever theme the page is rendered in -
      // a `@media (prefers-color-scheme: dark)` block is in the CSS either way - so it is
      // read once per route rather than once per theme.
      if (!o.onlyShots) {
        const written = await page.evaluate(declared);
        findings.push(...declaredFindings({
          declared: written.declared,
          tokens: new Set([...written.tokens, ...tokenFile.names]),
          colors: tokenFile.colors,
          lengths: tokenFile.lengths,
          hasTokens: !!tokens,
          grid: o.grid,
          root: 16,
          route,
          theme: '',
        }));
      }

      for (const theme of o.themes) {
        await page.setMedia({ colorScheme: /** @type {'light'|'dark'} */ (theme) });
        await page.setViewport(o.width, 900);
        if (!(await page.goto(url)).ok) throw new Unrenderable(`${url} did not render in the ${theme} theme`);
        if (!(await page.evaluate(`matchMedia('(prefers-color-scheme: ${theme})').matches`))) throw new Unrenderable(`the browser would not pretend to be in the ${theme} theme`);
        if (o.onlyShots) continue;

        const plain = await page.evaluate(audit);
        findings.push(...contrastFindings({ texts: plain.texts, route, theme, state: 'default', interactiveOnly: false }));
        findings.push(...sizeFindings(plain, route, theme));
        findings.push(...semanticsFindings(plain, route, theme));
        if (theme === o.themes[0]) findings.push(...overflowFindings(plain, route, theme, o.width));

        // Hover, then focus. The browser puts every element into the state and the same
        // audit runs again, so what is measured is what the state really produces.
        const tagged = await page.nodes('[data-bc-id]');
        await page.forcePseudo(tagged, ['hover']);
        const hovered = await page.evaluate(audit);
        findings.push(...contrastFindings({ texts: hovered.texts, route, theme, state: 'hover', interactiveOnly: true }));

        await page.forcePseudo(tagged, ['focus', 'focus-visible']);
        const focused = await page.evaluate(audit);
        findings.push(...contrastFindings({ texts: focused.texts, route, theme, state: 'focus', interactiveOnly: true }));
        findings.push(...focusFindings(plain.focusables, focused.focusables, route, theme));
        await page.forcePseudo(tagged, []);
      }

      if (!o.onlyShots) {
        await page.setMedia({ colorScheme: 'light', reducedMotion: true });
        await page.setViewport(o.width, 900);
        if (!(await page.goto(url)).ok) throw new Unrenderable(`${url} did not render with prefers-reduced-motion`);
        findings.push(...motionFindings((await page.evaluate(audit)).motion, route));

        // The widths a page has to survive: a small phone, a phone, a large phone.
        for (const width of o.widths) {
          await page.setViewport(width, 900);
          if (!(await page.goto(url)).ok) throw new Unrenderable(`${url} did not render at ${width}px`);
          findings.push(...overflowFindings(await page.evaluate(audit), route, 'light', width));
        }
      }

      if (o.shots) {
        for (const width of o.shotsWidths) {
          await page.setMedia({ colorScheme: 'light' });
          await page.setViewport(width, 900);
          if (!(await page.goto(url)).ok) throw new Unrenderable(`${url} did not render at ${width}px for its screenshot`);
          const file = path.resolve(cwd, o.shots, `${o.label ? `${o.label}-` : ''}${slug(route)}-${width}.png`);
          await page.screenshot(file);
          shots.push(file.endsWith(cwd) ? file : path.relative(cwd, file));
        }
      }
    }
  } catch (e) {
    if (page) await page.close().catch(() => {});
    return couldNotLook(/** @type {Error} */ (e).message);
  }
  const notes = page.notes;
  await page.close();

  const list = dedupe(findings);
  const code = list.length ? 1 : 0;
  if (o.json) process.stdout.write(`${JSON.stringify({ code, url: o.url, routes: o.routes, looked, tokens: tokens || null, shots, notes, findings: list }, null, 2)}\n`);
  else process.stdout.write(report(o, list, shots, notes, tokens, looked));
  return code;
}

/** The same complaint once, however many passes found it. @param {Finding[]} list */
function dedupe(list) {
  /** @type {Map<string, Finding>} */
  const seen = new Map();
  for (const f of list) {
    const key = [f.rule, f.route, f.theme, f.state, f.viewport, f.selector, f.detail].join('|');
    if (!seen.has(key)) seen.set(key, f);
  }
  return Array.from(seen.values());
}

/**
 * @param {any} o @param {Finding[]} findings @param {string[]} shots @param {string[]} notes @param {string|null} tokens @param {number} looked
 */
function report(o, findings, shots, notes, tokens, looked) {
  const saw = `${looked} route${looked === 1 ? '' : 's'} at ${o.width}px in ${o.themes.join('+')}${o.onlyShots ? '' : `, hover and focus, overflow at ${o.widths.join('/')}px, reduced motion`}`;
  const tail = [...shots.map((s) => `  shot ${s}`), ...notes.map((n) => `  note ${n}`)];
  const tokenNote = tokens ? `tokens from ${tokens}` : 'no design-token file found, so the token rules were skipped';
  if (!findings.length) return [`design-check ${o.url}: clean - ${saw}, ${tokenNote}`, ...tail, ''].join('\n');
  const width = Math.max(...findings.map((f) => f.rule.length));
  const lines = findings.map((f) => {
    const state = [f.theme, f.state].filter(Boolean).join(' ');
    return `  ${f.rule.padEnd(width)}  ${(f.viewport || state ? `[${[f.viewport, state].filter(Boolean).join(', ')}] ` : '')}${f.selector}  ${f.detail}`;
  });
  return [`design-check ${o.url}: ${findings.length} defect${findings.length === 1 ? '' : 's'} - ${saw}, ${tokenNote}`, ...lines, ...tail, ''].join('\n');
}

/**
 * Will this browser show an element in its focus state at all? If it will not, every
 * "nothing happens when it is focused" would be this gate's fault, not the page's.
 * @param {Browser} page
 */
async function focusStatesWork(page) {
  try {
    await page.evaluate(`(() => {
      const style = document.createElement('style');
      style.id = 'design-check-probe';
      style.textContent = '#design-check-probe:focus-visible { outline: 3px solid rgb(1, 2, 3) }';
      document.head.append(style);
      const el = document.createElement('button');
      el.id = 'design-check-probe';
      el.textContent = 'x';
      document.body.append(el);
      return true;
    })()`);
    const nodes = await page.nodes('#design-check-probe');
    if (!nodes.length) return false;
    await page.forcePseudo(nodes, ['focus-visible']);
    const worked = await page.evaluate(`getComputedStyle(document.querySelector('#design-check-probe')).outlineColor === 'rgb(1, 2, 3)'`);
    await page.evaluate(`document.querySelector('#design-check-probe')?.remove(); document.querySelector('style#design-check-probe')?.remove()`);
    return worked === true;
  } catch {
    return false;
  }
}

process.exitCode = await main();
