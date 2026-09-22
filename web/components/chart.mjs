// Inline SVG charts, drawn by hand. PLAN-PLATFORM.md ("Dashboard charts") sets
// the precedent: lightweight inline SVG, no charting library and no CDN chart
// dependency.
//
// Colours come from the --chart-* custom properties declared in index.html, so
// the charts follow the app's existing dark theme. Mark specs follow the same
// document: 2px lines, bars capped at 24px with a 4px rounded data-end and a
// square baseline, hairline solid gridlines, a 2px surface ring on markers, and
// area fills at ~10% opacity.
//
// Charts are drawn in real pixel coordinates rather than a scaled viewBox - a
// viewBox would stretch strokes and turn round markers into ellipses as the
// container changes width. useWidth measures the container instead, so marks
// stay crisp from a 375px phone up to the widest desktop layout.
import { html, useState, useEffect, useRef } from '../lib.mjs';

// SVG attribute names below are written kebab-case on purpose. Preact sets an
// unknown prop verbatim with setAttribute, so `strokeWidth` would land as the
// invalid attribute `strokeWidth` and the browser would fall back to the 1px
// default (and ignore text-anchor entirely). Colours go through `style` so the
// --chart-* custom properties survive.
const SURFACE = 'var(--chart-surface)';
const GRID = 'var(--chart-grid)';
const AXIS = 'var(--chart-axis)';

function useWidth(fallback) {
  const ref = useRef(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const apply = () => {
      const w = Math.round(el.clientWidth);
      if (w > 0) setWidth(w);
    };
    apply();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', apply);
      return () => window.removeEventListener('resize', apply);
    }
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width];
}

// Axis-tick and value formatting. Compact forms keep the y-axis gutter narrow
// enough to survive a 375px viewport.
export function compactNumber(v) {
  const n = Number(v) || 0;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${trimZero(n / 1e9)}B`;
  if (abs >= 1e6) return `${trimZero(n / 1e6)}M`;
  if (abs >= 1e3) return `${trimZero(n / 1e3)}K`;
  if (Number.isInteger(n)) return String(n);
  return trimZero(n);
}

export function formatCost(v) {
  const n = Number(v) || 0;
  if (!n) return '$0';
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  if (Math.abs(n) < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function trimZero(n) {
  const s = n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

// Round the axis maximum up to 1/2/2.5/5/10 x a power of ten so the tick
// labels land on clean numbers.
function niceMax(v) {
  if (!(v > 0)) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  const n = v / base;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * base;
}

function eachIndex(count, width, perLabel) {
  const step = Math.max(1, Math.ceil(count / Math.max(2, Math.floor(width / perLabel))));
  const idxs = [];
  for (let i = 0; i < count; i += step) idxs.push(i);
  const last = count - 1;
  if (idxs[idxs.length - 1] !== last) {
    if (last - idxs[idxs.length - 1] < step * 0.6) idxs.pop();
    idxs.push(last);
  }
  return idxs;
}

function NoData() {
  return html`<p class="muted chart-nodata">No data for this period.</p>`;
}

/* ---------------------------------------------------------------- sparkline */

// Trend line for a stat tile: no axes, no legend - the card's own label names
// the series. `label` becomes the accessible name.
export function Sparkline({ values = [], label, color = 'var(--chart-1)', height = 34 }) {
  const [ref, width] = useWidth(96);
  const nums = values.map((v) => Number(v) || 0);

  if (nums.length < 2) return html`<div class="sparkline" ref=${ref}></div>`;

  const pad = 4;
  const plotW = Math.max(8, width - pad * 2);
  const plotH = height - pad * 2;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min;
  const xAt = (i) => pad + (i / (nums.length - 1)) * plotW;
  const yAt = (v) => (span === 0 ? pad + plotH / 2 : pad + (1 - (v - min) / span) * plotH);
  const line = nums.map((v, i) => `${xAt(i)},${yAt(v)}`).join(' ');
  const endX = xAt(nums.length - 1);
  const endY = yAt(nums[nums.length - 1]);

  return html`
    <div class="sparkline" ref=${ref}>
      <svg width=${width} height=${height} role="img" aria-label=${label || '7 day trend'} viewBox="0 0 ${width} ${height}">
        <polyline points=${line} fill="none" style=${{ stroke: color }} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <circle cx=${endX} cy=${endY} r="4" style=${{ fill: color, stroke: SURFACE }} stroke-width="2" />
      </svg>
    </div>
  `;
}

/* --------------------------------------------------------------- line chart */

// Time series. One series by construction (the usage API's by_day carries a
// single value per day per measure), so there is no legend - the title names
// what is plotted. Hovering or focusing the plot snaps a crosshair to the
// nearest day and reads out that day's value.
export function LineChart({
  points = [],
  title,
  ariaLabel,
  color = 'var(--chart-1)',
  formatValue = compactNumber,
  plotHeight = 190,
  bandHeight = 22,
}) {
  const [ref, width] = useWidth(360);
  const [hover, setHover] = useState(null);

  const padL = 62;
  const padR = 18;
  const padT = 10;
  const plotW = Math.max(24, width - padL - padR);
  const plotH = plotHeight;
  const svgH = padT + plotH + bandHeight;

  const n = points.length;
  const max = niceMax(points.reduce((m, p) => Math.max(m, Number(p.value) || 0), 0));
  const xAt = (i) => (n <= 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const yAt = (v) => padT + plotH - (Math.max(0, Number(v) || 0) / max) * plotH;
  const baseY = padT + plotH;

  function move(e) {
    if (n === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const svgX = padL + (e.clientX - rect.left);
    const i = n <= 1 ? 0 : Math.round(((svgX - padL) / plotW) * (n - 1));
    setHover(Math.min(n - 1, Math.max(0, i)));
  }

  function key(e) {
    if (n === 0) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      setHover((h) => Math.min(n - 1, (h == null ? -1 : h) + 1));
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setHover((h) => Math.max(0, (h == null ? n : h) - 1));
    } else if (e.key === 'Escape') {
      setHover(null);
    }
  }

  if (!n) {
    return html`<div class="chart-figure" ref=${ref}><${NoData} /></div>`;
  }

  const line = points.map((p, i) => `${xAt(i)},${yAt(p.value)}`).join(' ');
  const area = `M${xAt(0)} ${baseY} L${points.map((p, i) => `${xAt(i)} ${yAt(p.value)}`).join(' L')} L${xAt(n - 1)} ${baseY} Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const xIdxs = eachIndex(n, plotW, 64);
  const active = hover == null ? null : points[hover];
  const tipX = active ? Math.min(Math.max(xAt(hover), 62), Math.max(62, width - 62)) : 0;

  return html`
    <div class="chart-figure" ref=${ref}>
      <svg
        width=${width}
        height=${svgH}
        viewBox="0 0 ${width} ${svgH}"
        role="img"
        aria-label=${ariaLabel || title}
        tabindex="0"
        class="chart-svg"
        onKeyDown=${key}
        onBlur=${() => setHover(null)}
      >
        <title>${title}</title>

        ${ticks.map(
          (t) => html`
            <g key=${t}>
              <line x1=${padL} y1=${yAt(max * t)} x2=${padL + plotW} y2=${yAt(max * t)} style=${{ stroke: t === 0 ? AXIS : GRID }} stroke-width="1" />
              <text x=${padL - 8} y=${yAt(max * t) + 4} text-anchor="end" class="chart-tick">${formatValue(max * t)}</text>
            </g>
          `
        )}

        ${n > 1
          ? html`
              <path d=${area} style=${{ fill: color }} fill-opacity="0.1" />
              <polyline points=${line} fill="none" style=${{ stroke: color }} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            `
          : html`<circle cx=${xAt(0)} cy=${yAt(points[0].value)} r="4" style=${{ fill: color, stroke: SURFACE }} stroke-width="2" />`}

        ${active
          ? html`
              <line x1=${xAt(hover)} y1=${padT} x2=${xAt(hover)} y2=${baseY} style=${{ stroke: AXIS }} stroke-width="1" />
              <circle cx=${xAt(hover)} cy=${yAt(active.value)} r="4" style=${{ fill: color, stroke: SURFACE }} stroke-width="2" />
            `
          : null}
        <circle cx=${xAt(n - 1)} cy=${yAt(points[n - 1].value)} r="4" style=${{ fill: color, stroke: SURFACE }} stroke-width="2" />

        ${xIdxs.map(
          (i) => html`<text key=${i} x=${xAt(i)} y=${baseY + 15} text-anchor="middle" class="chart-tick">${points[i].label}</text>`
        )}

        <rect
          x=${padL}
          y=${padT}
          width=${plotW}
          height=${plotH}
          fill="transparent"
          class="chart-hit"
          onMouseMove=${move}
          onMouseLeave=${() => setHover(null)}
        />
      </svg>

      ${active
        ? html`
            <div class="chart-tip" style=${{ left: `${tipX}px` }}>
              <div class="chart-tip-row">
                <span class="chart-tip-key" style=${{ background: color }}></span>
                <span class="chart-tip-value">${formatValue(active.value)}</span>
              </div>
              <div class="chart-tip-label">${active.label}</div>
            </div>
          `
        : null}
    </div>
  `;
}

/* ---------------------------------------------------------------- bar chart */

// Horizontal bars for one measure across categories (providers, roles). Every
// bar wears the same hue: the categories are rows of one measure, not separate
// series, so a hue per bar would double-encode the length. Each value is
// direct-labelled at the bar's tip, and each bar carries its own hover/focus
// readout.
export function BarChart({
  items = [],
  title,
  ariaLabel,
  color = 'var(--chart-1)',
  formatValue = compactNumber,
  rowHeight = 42,
  barHeight = 14,
}) {
  const [ref, width] = useWidth(360);
  const valueCol = 76;
  const barMaxW = Math.max(16, width - valueCol);
  const max = items.reduce((m, it) => Math.max(m, Number(it.value) || 0), 0) || 1;
  const svgH = items.length * rowHeight + 4;

  if (!items.length) {
    return html`<div class="chart-figure" ref=${ref}><${NoData} /></div>`;
  }

  return html`
    <div class="chart-figure" ref=${ref}>
      <svg width=${width} height=${svgH} viewBox="0 0 ${width} ${svgH}" role="img" aria-label=${ariaLabel || title}>
        <title>${title}</title>
        ${items.map((it, i) => {
          const top = i * rowHeight;
          const w = ((Number(it.value) || 0) / max) * barMaxW;
          const barY = top + 19;
          return html`
            <g key=${it.label} class="chart-bar-row" tabindex="0">
              <title>${`${it.label}: ${formatValue(it.value)}`}</title>
              <text x="0" y=${top + 13} class="chart-cat">${it.label}</text>
              ${w > 0 ? html`<path d=${barPath(0, barY, w, barHeight, 4)} style=${{ fill: color }} class="chart-bar" />` : null}
              <text x=${width} y=${barY + barHeight / 2 + 4} text-anchor="end" class="chart-value">${formatValue(it.value)}</text>
            </g>
          `;
        })}
      </svg>
    </div>
  `;
}

// Rounded data-end, square at the baseline.
function barPath(x, y, w, h, r) {
  const rr = Math.min(r, w, h / 2);
  if (w <= 0) return '';
  if (rr <= 0) return `M${x} ${y}h${w}v${h}h${-w}Z`;
  return `M${x} ${y}h${w - rr}a${rr} ${rr} 0 0 1 ${rr} ${rr}v${h - rr * 2}a${rr} ${rr} 0 0 1 ${-rr} ${rr}h${-(w - rr)}Z`;
}

// Column: rounded cap on the data end, square where it meets the baseline.
function columnPath(x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  if (w <= 0 || h <= 0) return '';
  if (rr <= 0) return `M${x} ${y}h${w}v${h}h${-w}Z`;
  return `M${x} ${y + h}V${y + rr}a${rr} ${rr} 0 0 1 ${rr} ${-rr}h${w - rr * 2}a${rr} ${rr} 0 0 1 ${rr} ${rr}V${y + h}Z`;
}

/* ------------------------------------------------------- stacked bar chart */

// How many categorical hues the theme declares. A series past the last slot is
// never given a generated hue - it folds into "Other" (see seriesSlots).
export const CHART_SLOTS = 8;
const OTHER_KEY = '\u0000other';

export function chartColor(slot) {
  const i = Math.max(0, Math.floor(Number(slot) || 0)) % CHART_SLOTS;
  return `var(--chart-${i + 1})`;
}

// Deterministic slot assignment. Keys are sorted before they are given a hue, so
// a series keeps the same colour as the period - and therefore the set of
// series present - changes. Colour follows the entity, never its rank.
// Returns the ordered series list for the legend plus a keyOf map that routes
// every original key to its series (the folded tail routes to "Other").
export function seriesSlots(keys, labelOf) {
  const sorted = [...new Set((keys || []).filter((k) => k != null))].sort();
  const head = sorted.slice(0, CHART_SLOTS);
  const series = head.map((key, i) => ({ key, label: labelOf ? labelOf(key) : key, color: chartColor(i) }));
  const keyOf = new Map(head.map((key) => [key, key]));
  if (sorted.length > CHART_SLOTS) {
    series.push({ key: OTHER_KEY, label: 'Other', color: 'var(--chart-other)', other: true });
    for (const key of sorted.slice(CHART_SLOTS)) keyOf.set(key, OTHER_KEY);
  }
  return { series, keyOf };
}

// Cost - or any additive measure - split by category over time. One column per
// day, stacked by series, so a segment's height is that series' share of the
// day and the column's height is the day's total. Stacked (rather than grouped)
// because cost is additive: the column top is a real number you can read off the
// axis.
//
// `rows` are `[{ key, label, total, segments: [{ key, value, runs }] }]` and
// `series` is the ordered `[{ key, label, color }]` list from seriesSlots; a
// segment with no colour of its own resolves through `series` by key, which is
// also the legend and tooltip order. Zero-value segments are listed in the
// tooltip but draw nothing, so a day whose providers all priced at $0 keeps its
// column slot and reads as empty rather than broken.
export function StackedBarChart({
  rows = [],
  series = [],
  title,
  ariaLabel,
  formatValue = formatCost,
  plotHeight = 190,
  bandHeight = 22,
  zeroNote = 'No cost recorded in this period.',
}) {
  const [ref, width] = useWidth(360);
  const [hover, setHover] = useState(null);

  const padL = 62;
  const padR = 18;
  const padT = 10;
  const plotW = Math.max(24, width - padL - padR);
  const plotH = plotHeight;
  const svgH = padT + plotH + bandHeight;

  const n = rows.length;
  const colour = new Map(series.map((s) => [s.key, s.color]));
  const seriesTotal = new Map(series.map((s) => [s.key, 0]));
  let dataMax = 0;
  for (const r of rows) {
    for (const seg of r.segments || []) {
      const v = Number(seg.value) || 0;
      if (v > 0) seriesTotal.set(seg.key, (seriesTotal.get(seg.key) || 0) + v);
    }
    dataMax = Math.max(dataMax, Number(r.total) || 0);
  }

  // A period where every run priced at $0 has no scale to draw against. Rather
  // than invent one (a $1 axis over an empty plot reads as a bug), the chart
  // keeps its day axis and its hover readout and says so in words.
  const scaled = dataMax > 0;
  const max = scaled ? niceMax(dataMax) : 0;
  const ticks = scaled ? [0, 0.25, 0.5, 0.75, 1] : [0];

  const bandW = n ? plotW / n : plotW;
  const barW = Math.max(1, Math.min(24, bandW * 0.62));
  const centre = (i) => padL + (i + 0.5) * bandW;
  const yAt = (v) => padT + plotH - (Math.max(0, Number(v) || 0) / (max || 1)) * plotH;
  const baseY = padT + plotH;

  function move(e) {
    if (!n) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left) / bandW);
    setHover(Math.min(n - 1, Math.max(0, i)));
  }

  function key(e) {
    if (!n) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      setHover((h) => Math.min(n - 1, (h == null ? -1 : h) + 1));
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setHover((h) => Math.max(0, (h == null ? n : h) - 1));
    } else if (e.key === 'Escape') {
      setHover(null);
    }
  }

  if (!n) {
    return html`<div class="chart-figure" ref=${ref}><${NoData} /></div>`;
  }

  const xIdxs = eachIndex(n, plotW, 64);
  const active = hover == null ? null : rows[hover];
  // The tooltip grows downward from the top of the figure and is centred on the
  // column. Clamping the centre keeps its full width inside the figure, so it
  // can never widen the page - the chart cards deliberately have no scroll
  // container of their own.
  const tipHalf = Math.min(120, Math.max(40, width / 2 - 4));
  const tipX = active ? Math.min(Math.max(centre(hover), tipHalf), Math.max(tipHalf, width - tipHalf)) : 0;

  return html`
    <div class="chart-figure" ref=${ref}>
      <svg
        width=${width}
        height=${svgH}
        viewBox="0 0 ${width} ${svgH}"
        role="img"
        aria-label=${ariaLabel || title}
        tabindex="0"
        class="chart-svg"
        onKeyDown=${key}
        onBlur=${() => setHover(null)}
      >
        <title>${title}</title>

        ${ticks.map(
          (t) => html`
            <g key=${t}>
              <line x1=${padL} y1=${yAt(max * t)} x2=${padL + plotW} y2=${yAt(max * t)} style=${{ stroke: t === 0 ? AXIS : GRID }} stroke-width="1" />
              <text x=${padL - 8} y=${yAt(max * t) + 4} text-anchor="end" class="chart-tick">${formatValue(max * t)}</text>
            </g>
          `
        )}

        ${active
          ? html`<rect x=${padL + hover * bandW} y=${padT} width=${bandW} height=${plotH} style=${{ fill: AXIS }} fill-opacity="0.22" />`
          : null}

        ${rows.map((row, i) => {
          const drawn = (row.segments || [])
            .map((seg) => ({ key: seg.key, h: Math.max(0, Number(seg.value) || 0) * (scaled ? plotH / max : 0) }))
            .filter((seg) => seg.h > 0);
          if (!drawn.length) return null;
          const x = centre(i) - barW / 2;
          // Heights are walked from the baseline up, so segment order in the
          // stack is series order. The 1px inset at an interior boundary is the
          // mark spec's 2px surface gap - two insets facing each other - and it
          // is only taken where both neighbours have the room to spare. Nothing
          // is inset at the baseline or the column top, so the column still
          // spans exactly its total.
          let y = baseY;
          const marks = [];
          for (let j = 0; j < drawn.length; j += 1) {
            const h = drawn[j].h;
            const below = j > 0 ? drawn[j - 1].h : null;
            const above = j < drawn.length - 1 ? drawn[j + 1].h : null;
            const insetBottom = below != null && Math.min(h, below) >= 5 ? 1 : 0;
            const insetTop = above != null && Math.min(h, above) >= 5 ? 1 : 0;
            const top = y - h + insetTop;
            const drawH = h - insetTop - insetBottom;
            if (drawH > 0) {
              marks.push({ key: drawn[j].key, d: columnPath(x, top, barW, drawH, above == null ? 4 : 0) });
            }
            y -= h;
          }
          return marks.length
            ? html`<g key=${row.key}>${marks.map((m) => html`<path key=${m.key} d=${m.d} style=${{ fill: colour.get(m.key) || chartColor(0) }} class="chart-bar" />`)}</g>`
            : null;
        })}

        ${xIdxs.map((i) => html`<text key=${i} x=${centre(i)} y=${baseY + 15} text-anchor="middle" class="chart-tick">${rows[i].label}</text>`)}

        <rect
          x=${padL}
          y=${padT}
          width=${plotW}
          height=${plotH}
          fill="transparent"
          class="chart-hit"
          onMouseMove=${move}
          onMouseLeave=${() => setHover(null)}
        />
      </svg>

      <ul class="legend">
        ${series.map(
          (s) => html`
            <li key=${s.key} class="legend-item">
              <span class="legend-key" style=${{ background: s.color }}></span>
              <span class="legend-label">${s.label}</span>
              <span class="legend-value">${formatValue(seriesTotal.get(s.key) || 0)}</span>
            </li>
          `
        )}
      </ul>

      ${active
        ? html`
            <div class="chart-tip chart-tip-multi" style=${{ left: `${tipX}px` }}>
              <div class="chart-tip-head">${active.label} · ${formatValue(active.total)}</div>
              ${(active.segments || [])
                .filter((s) => (Number(s.value) || 0) > 0 || (Number(s.runs) || 0) > 0)
                .map(
                  (s) => html`
                    <div key=${s.key} class="chart-tip-row">
                      <span class="chart-tip-key" style=${{ background: colour.get(s.key) || chartColor(0) }}></span>
                      <span class="chart-tip-name">${legendLabel(series, s.key)}</span>
                      <span class="chart-tip-value">${formatValue(s.value)}</span>
                    </div>
                  `
                )}
            </div>
          `
        : null}

      ${scaled ? null : html`<p class="muted chart-note">${zeroNote}</p>`}
    </div>
  `;
}

function legendLabel(series, key) {
  const found = series.find((s) => s.key === key);
  return found ? found.label : key;
}
