// Minimal SVG chart renderers: a time-series line chart and a daily bar chart.
// Single series per chart (no legend needed — the title names it); hover
// tooltips on both; recessive grid and axes.
// Wrapped in an IIFE so helpers don't collide with app.js globals; exposes
// window.renderTimeSeries and window.renderDailyBars.
(() => {

const CHART = {
  grid: '#e1e0d9',
  baseline: '#c3c2b7',
  muted: '#898781',
  ink: '#0b0b0b',
  surface: '#fcfcfb',
};

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

function niceTicks(min, max, count = 5) {
  if (min === max) { min = Math.max(0, min - 1); max = max + 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => span / s <= count) || 10 * mag;
  const lo = Math.floor(min / step) * step;
  const ticks = [];
  for (let v = lo; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

function tooltipFor(wrap) {
  let tip = wrap.querySelector('.chart-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip hidden';
    wrap.appendChild(tip);
  }
  return tip;
}

function showTip(tip, wrap, xPx, yPx, html) {
  tip.innerHTML = html;
  tip.classList.remove('hidden');
  const w = wrap.clientWidth;
  tip.style.left = Math.min(xPx + 12, w - tip.offsetWidth - 8) + 'px';
  tip.style.top = Math.max(yPx - tip.offsetHeight - 10, 4) + 'px';
}

const fmtDay = (ms) => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
const fmtTime = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function frame(width, height, pad, yTicks, yFmt, xLabels) {
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%' });
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  svg.appendChild(el('rect', { x: 0, y: 0, width, height, fill: CHART.surface }));
  for (const t of yTicks) {
    const y = pad.t + plotH - ((t - yTicks[0]) / (yTicks[yTicks.length - 1] - yTicks[0])) * plotH;
    svg.appendChild(el('line', { x1: pad.l, x2: pad.l + plotW, y1: y, y2: y, stroke: CHART.grid, 'stroke-width': 1 }));
    const lbl = el('text', { x: pad.l - 8, y: y + 4, 'text-anchor': 'end', fill: CHART.muted, 'font-size': 11, style: 'font-variant-numeric: tabular-nums' });
    lbl.textContent = yFmt(t);
    svg.appendChild(lbl);
  }
  svg.appendChild(el('line', { x1: pad.l, x2: pad.l + plotW, y1: pad.t + plotH, y2: pad.t + plotH, stroke: CHART.baseline, 'stroke-width': 1 }));
  for (const { x, text } of xLabels) {
    const lbl = el('text', { x, y: pad.t + plotH + 18, 'text-anchor': 'middle', fill: CHART.muted, 'font-size': 11 });
    lbl.textContent = text;
    svg.appendChild(lbl);
  }
  return { svg, plotW, plotH };
}

// points: [{t: ms, v: number, label: html}]
function renderTimeSeries(wrap, points, { color, unit, band, rangeDays }) {
  wrap.innerHTML = '';
  if (points.length === 0) { wrap.innerHTML = '<p class="chart-empty">No data in this period yet.</p>'; return; }
  const width = 720, height = 260, pad = { l: 46, r: 12, t: 12, b: 28 };
  const now = Date.now();
  const t0 = now - rangeDays * 86400000;
  const vs = points.map((p) => p.v);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (band) { lo = Math.min(lo, band[0]); hi = Math.max(hi, band[1]); }
  const yTicks = niceTicks(Math.max(0, lo - (hi - lo) * 0.1), hi + (hi - lo) * 0.1 || hi + 10);
  const yMin = yTicks[0], yMax = yTicks[yTicks.length - 1];

  const nLbl = Math.min(rangeDays, 6);
  const xLabels = Array.from({ length: nLbl + 1 }, (_, i) => {
    const t = t0 + (i / nLbl) * (now - t0);
    return { x: pad.l + (i / nLbl) * (width - pad.l - pad.r), text: fmtDay(t) };
  });

  const { svg, plotW, plotH } = frame(width, height, pad, yTicks, (v) => v, xLabels);
  const X = (t) => pad.l + ((t - t0) / (now - t0)) * plotW;
  const Y = (v) => pad.t + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  if (band) {
    svg.appendChild(el('rect', {
      x: pad.l, width: plotW, y: Y(band[1]), height: Y(band[0]) - Y(band[1]),
      fill: 'rgba(12,163,12,0.07)',
    }));
    const bandLbl = el('text', { x: pad.l + plotW - 6, y: Y(band[1]) + 14, 'text-anchor': 'end', fill: CHART.muted, 'font-size': 10 });
    bandLbl.textContent = `target ${band[0]}–${band[1]}`;
    svg.appendChild(bandLbl);
  }

  const pts = points.filter((p) => p.t >= t0).sort((a, b) => a.t - b.t);
  if (pts.length > 1) {
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ');
    svg.appendChild(el('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  }
  for (const p of pts) {
    svg.appendChild(el('circle', { cx: X(p.t), cy: Y(p.v), r: 3.5, fill: color, stroke: CHART.surface, 'stroke-width': 2 }));
  }

  // crosshair + tooltip on nearest point
  const cross = el('line', { y1: pad.t, y2: pad.t + plotH, stroke: CHART.baseline, 'stroke-width': 1, 'stroke-dasharray': '3 3', visibility: 'hidden' });
  const hoverDot = el('circle', { r: 5.5, fill: color, stroke: CHART.surface, 'stroke-width': 2, visibility: 'hidden' });
  svg.appendChild(cross);
  svg.appendChild(hoverDot);
  wrap.appendChild(svg);
  const tip = tooltipFor(wrap);
  svg.addEventListener('mousemove', (e) => {
    if (!pts.length) return;
    const rect = svg.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * width;
    let best = pts[0];
    for (const p of pts) if (Math.abs(X(p.t) - mx) < Math.abs(X(best.t) - mx)) best = p;
    cross.setAttribute('x1', X(best.t)); cross.setAttribute('x2', X(best.t));
    cross.setAttribute('visibility', 'visible');
    hoverDot.setAttribute('cx', X(best.t)); hoverDot.setAttribute('cy', Y(best.v));
    hoverDot.setAttribute('visibility', 'visible');
    showTip(tip, wrap, (X(best.t) / width) * rect.width, (Y(best.v) / height) * rect.height,
      `<b>${best.v} ${unit}</b><br>${fmtTime(best.t)}${best.label ? '<br>' + best.label : ''}`);
  });
  svg.addEventListener('mouseleave', () => {
    cross.setAttribute('visibility', 'hidden');
    hoverDot.setAttribute('visibility', 'hidden');
    tip.classList.add('hidden');
  });
}

// bars: one per day. entries: [{t: ms, v: number, label}] aggregated by local day.
function renderDailyBars(wrap, entries, { color, unit, rangeDays, agg = 'sum' }) {
  wrap.innerHTML = '';
  const width = 720, height = 220, pad = { l: 46, r: 12, t: 12, b: 28 };
  const days = [];
  for (let i = rangeDays - 1; i >= 0; i--) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    days.push({ t: d.getTime(), key: d.toDateString(), v: 0, n: 0 });
  }
  const byKey = Object.fromEntries(days.map((d) => [d.key, d]));
  for (const e of entries) {
    const k = new Date(e.t).toDateString();
    if (byKey[k]) { byKey[k].v += e.v; byKey[k].n++; }
  }
  if (agg === 'count') days.forEach((d) => { d.v = d.n; });
  if (days.every((d) => d.v === 0)) { wrap.innerHTML = '<p class="chart-empty">No data in this period yet.</p>'; return; }

  const hi = Math.max(...days.map((d) => d.v));
  const yTicks = niceTicks(0, hi || 1, 4);
  const yMax = yTicks[yTicks.length - 1];
  const nLbl = Math.min(rangeDays - 1, 6);
  const xLabels = Array.from({ length: nLbl + 1 }, (_, i) => {
    const idx = Math.round((i / Math.max(nLbl, 1)) * (days.length - 1));
    return { x: pad.l + ((idx + 0.5) / days.length) * (width - pad.l - pad.r), text: fmtDay(days[idx].t) };
  });

  const { svg, plotW, plotH } = frame(width, height, pad, yTicks, (v) => v, xLabels);
  const bw = Math.max((plotW / days.length) - 2, 1); // 2px gap between bars
  const tip = tooltipFor(wrap);

  days.forEach((d, i) => {
    if (d.v === 0) return;
    const h = (d.v / yMax) * plotH;
    const x = pad.l + (i / days.length) * plotW + 1;
    const y = pad.t + plotH - h;
    const r = Math.min(4, bw / 2, h); // rounded data-end, anchored to baseline
    const bar = el('path', {
      d: `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + bw - r},${y} Q${x + bw},${y} ${x + bw},${y + r} L${x + bw},${y + h} Z`,
      fill: color,
    });
    bar.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      showTip(tip, wrap, ((x + bw / 2) / width) * rect.width, (y / height) * rect.height,
        `<b>${Math.round(d.v * 10) / 10} ${unit}</b><br>${fmtDay(d.t)}${agg === 'sum' && d.n ? `<br>${d.n} entr${d.n === 1 ? 'y' : 'ies'}` : ''}`);
    });
    bar.addEventListener('mouseleave', () => tip.classList.add('hidden'));
    svg.appendChild(bar);
  });
  wrap.appendChild(svg);
}

window.renderTimeSeries = renderTimeSeries;
window.renderDailyBars = renderDailyBars;
})();
