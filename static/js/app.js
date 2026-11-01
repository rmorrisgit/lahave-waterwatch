/* LaHave River · WaterWatch — single-viewport workspace
   Renders entirely from static/data.json (real Coastal Action / DataStream
   data). The DATA + compute layer (windowed CCME WQI, windowed stats,
   seasonal, anomalies) is unchanged; the layout is a cohesive map + analysis
   workspace with a view switcher, persistent date-range and indicator
   controls, and a contextual station panel. Wrapped in an IIFE. */
(function () {
'use strict';

const L = window.__LEAFLET__ || (typeof window.L !== 'undefined' ? window.L : undefined);

const RATING_COLOR = { Excellent: '#2f8f6b', Good: '#6aa05a', Fair: '#c79a3e', Marginal: '#cc7a43', Poor: '#c1584f' };
const CONF_META = {
  high:     { label: 'high reliability',     color: '#2f8f6b' },
  moderate: { label: 'moderate reliability', color: '#c79a3e' },
  low:      { label: 'low reliability',      color: '#cc7a43' },
};
const RIVER = '#1f8a84', ESTUARY = '#2f6f9e', MUTED = '#6d7d80', LINE = '#e4e0d6';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let DATA, STATE = { station: null, markers: {}, y0: null, y1: null, wqi: {}, view: 'trends', compare: '', trendline: true };
let trendChart, profileChart, seasonChart;

const $ = (s) => document.querySelector(s);
const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v))
  ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d });
const pkeys = {};

const winText = () => (STATE.y0 === STATE.y1 ? `${STATE.y0}` : `${STATE.y0}–${STATE.y1}`);
const unitText = (p) => (p && p.unit ? ` (${p.unit})` : '');
/* One consistent caption under every chart: what is measured, its units,
   which station, and the active time window. */
function chartCaption(p, { station, scope } = {}) {
  const where = station !== undefined ? station : (DATA.stations.find((s) => s.id === STATE.station) || {}).name;
  const parts = [`<strong>${p.label}</strong>${unitText(p)}`];
  if (where) parts.push(where);
  parts.push(scope || `${winText()}`);
  return parts.join(' &nbsp;·&nbsp; ');
}

init();

async function init() {
  try {
    const resp = await fetch('static/data.json', { cache: 'no-store' });
    if (!resp.ok) throw new Error(`data.json HTTP ${resp.status}`);
    DATA = await resp.json();
    DATA.params.forEach((p) => { pkeys[p.key] = p; });

    if (typeof L === 'undefined' || typeof L.map !== 'function') {
      const diag = window.__LEAFLET_DIAG__ || {};
      throw new Error('Leaflet did not load (L.map is not a function). Probe: typeof L='
        + diag.typeofL + ', L.map=' + diag.hasMap + ', version=' + diag.version + '.');
    }
    if (typeof Chart === 'undefined' || typeof Chart !== 'function') {
      throw new Error('Chart.js did not load. Chart = ' + describeGlobal(window.Chart));
    }

    Chart.defaults.font.family = "'Inter',system-ui,sans-serif";
    Chart.defaults.font.size = 11.5;
    Chart.defaults.color = MUTED;
    Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(28,42,48,.95)';
    Chart.defaults.plugins.tooltip.titleColor = '#f6f4ee';
    Chart.defaults.plugins.tooltip.bodyColor = '#dfe6e4';
    Chart.defaults.plugins.tooltip.padding = 11;
    Chart.defaults.plugins.tooltip.cornerRadius = 10;
    Chart.defaults.plugins.tooltip.displayColors = false;

    STATE.y0 = DATA.meta.year_min;
    STATE.y1 = DATA.meta.year_max;

    renderHeadline();
    buildMap();
    fillParamSelects();
    buildRangeControl();
    bindViewTabs();
    bindControls();
    recomputeWindow();
    const worst = Object.values(STATE.wqi).sort((a, b) => a.score - b.score)[0];
    selectStation(worst ? worst.station_id : DATA.stations[0].id);
    renderDataQuality();
  } catch (err) {
    console.error('[WaterWatch] init failed:', err);
    showFatal(err);
  }
}

function describeGlobal(g) {
  if (g === undefined) return 'undefined';
  if (g === null) return 'null';
  if (typeof g === 'function') return 'function ' + (g.name || '(anon)');
  if (typeof g === 'object') return 'object {' + Object.keys(g).slice(0, 8).join(', ') + '}';
  return typeof g + ' ' + String(g).slice(0, 40);
}
function showFatal(err) {
  const bar = document.createElement('div');
  bar.className = 'fatal-bar';
  bar.innerHTML = `<b>Could not load the data:</b> ${String(err && err.message || err)} — open DevTools (F12) → Console.`;
  document.body.appendChild(bar);
}

/* ================= compute layer (unchanged) ================= */
function wqiForWindow(sid, y0, y1) {
  const st = DATA.stations.find((s) => s.id === sid);
  const est = !!(st && st.estuary);
  const G = DATA.guidelines;
  let testsTotal = 0, testsFailed = 0;
  const paramsTotal = new Set(), paramsFailed = new Set();
  const excursions = []; const yrs = new Set();
  for (const pkey of Object.keys(G)) {
    if (pkey === 'chloride' && est) continue;
    const gl = G[pkey];
    const buckets = DATA.yearagg[`${sid}|${pkey}`];
    if (!buckets) continue;
    const w = gl.wqi_weight || 1.0;
    const skipLow = !!gl.wqi_skip_low;
    let contributed = 0;
    for (const yr of Object.keys(buckets)) {
      const y = +yr; if (y < y0 || y > y1) continue;
      yrs.add(y);
      for (const v of (buckets[yr].gvals || [])) {
        contributed++; testsTotal++;
        let failed = false, exc = 0;
        if (gl.max !== undefined && v > gl.max) { failed = true; exc = gl.max ? (v / gl.max - 1) : 0; }
        if (gl.min !== undefined && !skipLow && v >= 0 && v < gl.min) { failed = true; exc = v ? (gl.min / v - 1) : 0; }
        if (failed) { testsFailed++; paramsFailed.add(pkey); excursions.push(Math.max(exc, 0) * w); }
      }
    }
    if (contributed) paramsTotal.add(pkey);
  }
  if (testsTotal === 0 || paramsTotal.size === 0) return null;
  const f1 = 100 * paramsFailed.size / paramsTotal.size;
  const f2 = 100 * testsFailed / testsTotal;
  const nse = excursions.reduce((a, b) => a + b, 0) / testsTotal;
  const f3 = nse ? nse / (0.01 * nse + 0.01) : 0;
  let score = 100 - Math.sqrt(f1 * f1 + f2 * f2 + f3 * f3) / 1.732;
  score = Math.max(0, Math.min(100, score));
  const rating = score >= 95 ? 'Excellent' : score >= 80 ? 'Good'
    : score >= 65 ? 'Fair' : score >= 45 ? 'Marginal' : 'Poor';
  const pe = paramsTotal.size, ny = yrs.size;
  const tier = (pe >= 6 && testsTotal >= 150 && ny >= 5) ? 'high'
    : (pe >= 4 && testsTotal >= 40 && ny >= 2) ? 'moderate' : 'low';
  return { station_id: sid, station: st.name, score: Math.round(score * 10) / 10, rating,
    params_evaluated: pe, tests_failed: testsFailed, tests_total: testsTotal,
    n_years: ny, confidence: tier, window: [y0, y1] };
}

function windowStats(sid, pkey, y0, y1) {
  const buckets = DATA.yearagg[`${sid}|${pkey}`];
  if (!buckets) return null;
  let n = 0, sum = 0, lo = Infinity, hi = -Infinity, allVals = [];
  for (const yr of Object.keys(buckets)) {
    const y = +yr; if (y < y0 || y > y1) continue;
    const b = buckets[yr];
    n += b.n; sum += b.sum;
    if (b.min < lo) lo = b.min; if (b.max > hi) hi = b.max;
    allVals = allVals.concat(b.vals);
  }
  if (!n) return null;
  allVals.sort((a, b) => a - b);
  const mid = allVals.length >> 1;
  const median = allVals.length % 2 ? allVals[mid] : (allVals[mid - 1] + allVals[mid]) / 2;
  return { n, mean: sum / n, median, min: lo, max: hi };
}

/* ================= header stats ================= */
function renderHeadline() {
  const m = DATA.meta;
  const stats = [
    [`${m.year_min}–${m.year_max}`, 'record'],
    [m.n_stations, 'stations'],
    [fmt(m.n_measurements, 0), 'measurements'],
    [m.n_params, 'indicators'],
  ];
  $('#headline').innerHTML = stats
    .map(([b, s]) => `<div class="hero-stat"><b>${b}</b><span>${s}</span></div>`).join('');
}

/* ================= map ================= */
function buildMap() {
  const map = L.map('map', { zoomControl: true, attributionControl: false, scrollWheelZoom: false })
    .setView([44.52, -64.62], 10);
  map.on('focus', () => map.scrollWheelZoom.enable());
  map.on('blur', () => map.scrollWheelZoom.disable());
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, subdomains: 'abc', className: 'osm-tiles' }).addTo(map);
  L.control.attribution({ prefix: false })
    .addAttribution('&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors').addTo(map);
  STATE.map = map;

  const ordered = [...DATA.stations].sort((a, b) => a.river_order - b.river_order);
  L.polyline(ordered.map((s) => [s.lat, s.lon]), { color: RIVER, weight: 2.5, opacity: 0.4, dashArray: '1 8', lineCap: 'round' }).addTo(map);

  DATA.stations.forEach((s) => {
    const m = L.marker([s.lat, s.lon], { icon: markerIcon(s, '#9aa6a5') }).addTo(map);
    m.on('mouseover', function () { this.openPopup(); });
    m.on('mouseout', function () { this.closePopup(); });
    m.on('click', () => selectStation(s.id));
    STATE.markers[s.id] = { marker: m, station: s };
  });
}

function stationPopupHtml(s) {
  const w = STATE.wqi[s.id];
  const col = w ? RATING_COLOR[w.rating] : MUTED;
  const cf = w ? CONF_META[w.confidence] : null;
  return `<h3>${s.name}</h3>` +
    `<div class="pp"><b>${s.type}</b> · river position ${s.river_order + 1} of 20</div>` +
    (w ? `<div class="pp">Water Quality <b style="color:${col}">${w.score}</b> · <span style="color:${col}">${w.rating}</span> · <span style="color:${cf.color}">${cf.label}</span></div>`
       : `<div class="pp">No indicator data in this window</div>`) +
    `<div class="pp">${fmt(s.n, 0)} measurements · ${s.first.slice(0, 4)}–${s.last.slice(0, 4)}</div>`;
}

function markerIcon(s, color, selected = false) {
  const size = 13 + Math.min(10, Math.log10((s.n || 1) + 1) * 4);
  return L.divIcon({ className: '',
    html: `<div class="station-marker${selected ? ' sel' : ''}" style="width:${size}px;height:${size}px;background:${color}"></div>`,
    iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

function colorMap(mode) {
  DATA.stations.forEach((s) => {
    const ref = STATE.markers[s.id];
    let color = '#9aa6a5';
    if (mode === 'wqi') { const w = STATE.wqi[s.id]; color = w ? RATING_COLOR[w.rating] : '#c3c9c4'; }
    else color = rampColor(s.id, mode);
    ref.color = color;
    ref.marker.setIcon(markerIcon(s, color, STATE.station === s.id));
    ref.marker.bindPopup(stationPopupHtml(s), { closeButton: false, offset: [0, -4] });
  });
  const leg = $('#map-legend');
  if (mode === 'wqi') {
    leg.innerHTML = Object.entries(RATING_COLOR).map(([k, v]) => `<span class="sw"><i style="background:${v}"></i>${k}</span>`).join('')
      + `<span class="hint">Water Quality Index · ${STATE.y0}–${STATE.y1}</span>`;
  } else {
    const p = pkeys[mode];
    leg.innerHTML =
      `<span class="sw"><i style="background:#2f6f9e"></i>lower</span>
       <span class="sw"><i style="background:#5fb3c9"></i>mid</span>
       <span class="sw"><i style="background:#c8a56b"></i>higher</span>
       <span class="hint">${p ? p.label + (p.unit ? ' (' + p.unit + ')' : '') : ''} · median, ${STATE.y0}–${STATE.y1}</span>`;
  }
}

function rampColor(sid, pkey) {
  const med = (id) => { const st = windowStats(id, pkey, STATE.y0, STATE.y1); return st ? st.median : null; };
  const vals = DATA.stations.map((s) => med(s.id)).filter((v) => v !== null && v !== undefined);
  if (!vals.length) return '#9aa6a5';
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const v = med(sid);
  if (v === null || v === undefined) return '#c3c9c4';
  const t = hi === lo ? 0.5 : (v - lo) / (hi - lo);
  const stops = [[47, 111, 158], [95, 179, 201], [200, 165, 107]];
  const seg = t < 0.5 ? 0 : 1, local = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  const a = stops[seg], b = stops[seg + 1];
  const c = a.map((x, i) => Math.round(x + (b[i] - x) * local));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/* ================= window recompute ================= */
function recomputeWindow() {
  STATE.wqi = {};
  DATA.stations.forEach((s) => { const w = wqiForWindow(s.id, STATE.y0, STATE.y1); if (w) STATE.wqi[s.id] = w; });
  renderRanking();
  colorMap(($('#map-param') && $('#map-param').value) || 'wqi');
  if (STATE.station != null) { renderStationCard(); renderActiveView(); }
}

/* ================= station selection + context card ================= */
function selectStation(id) {
  STATE.station = id;
  const s = DATA.stations.find((x) => x.id === id);
  if (STATE.compare && +STATE.compare === id) STATE.compare = '';  // can't compare with self
  colorMap(($('#map-param').value) || 'wqi');
  if (STATE.markers[id]) STATE.map.panTo([s.lat, s.lon], { animate: true });
  fillCompareSelect();
  renderStationCard();
  renderActiveView();
  highlightRank();
}

function renderStationCard() {
  const s = DATA.stations.find((x) => x.id === STATE.station);
  if (!s) return;
  const w = STATE.wqi[s.id];
  const col = w ? RATING_COLOR[w.rating] : MUTED;
  const cf = w ? CONF_META[w.confidence] : null;
  const winTxt = STATE.y0 === STATE.y1 ? `${STATE.y0}` : `${STATE.y0}–${STATE.y1}`;
  $('#map-station').innerHTML = `
    <div class="st-card">
      <div class="st-top">
        <div>
          <div class="st-name">${s.name}</div>
          <div class="st-type">${s.type} · river position ${s.river_order + 1} of 20 · ${s.first.slice(0, 4)}–${s.last.slice(0, 4)}</div>
          ${w ? `<div class="reliab"><span class="dot" style="background:${cf.color}"></span>${cf.label} · ${w.params_evaluated} of 8 indicators · ${w.n_years} yr in window</div>` : ''}
        </div>
        <div class="st-scorebox">
          ${w ? scoreRing(w.score, col) : '<div class="st-name" style="color:var(--muted)">—</div>'}
          <div class="srate" style="color:${col}">${w ? w.rating : 'no data'}</div>
        </div>
      </div>
      <div class="st-quickstats">
        <div class="q"><b style="color:${col}">${w ? w.score : '—'}</b><small>WQI · ${winTxt}</small></div>
        <div class="q"><b>${fmt(s.n, 0)}</b><small>measurements</small></div>
        <div class="q"><b>${s.n_years}</b><small>years</small></div>
        <div class="q"><b>${s.n_days}</b><small>sampling days</small></div>
      </div>
    </div>`;
}

function scoreRing(pct, col) {
  const r = 24, c = 2 * Math.PI * r, off = c * (1 - pct / 100);
  return `<svg class="ring" viewBox="0 0 60 60"><circle cx="30" cy="30" r="${r}" fill="none" stroke="#e4e0d6" stroke-width="5.5"/>
    <circle cx="30" cy="30" r="${r}" fill="none" stroke="${col}" stroke-width="5.5" stroke-linecap="round"
      stroke-dasharray="${c}" stroke-dashoffset="${off}" transform="rotate(-90 30 30)"/>
    <text x="30" y="34" text-anchor="middle" font-family="var(--mono)" font-size="15" font-weight="500" fill="${col}">${pct}</text></svg>`;
}

/* ================= selects ================= */
function fillParamSelects() {
  const groups = {};
  DATA.params.forEach((p) => { (groups[p.group] ||= []).push(p); });
  const optsHtml = Object.entries(groups).map(([g, arr]) =>
    `<optgroup label="${g}">${arr.map((p) => `<option value="${p.key}">${p.label}${p.unit ? ' (' + p.unit + ')' : ''}</option>`).join('')}</optgroup>`).join('');
  $('#trend-param').innerHTML = optsHtml;
  $('#seasonal-param').innerHTML = optsHtml;
  $('#profile-param').innerHTML = optsHtml;
  $('#map-param').innerHTML = `<option value="wqi">Overall water quality</option>` + optsHtml;
  $('#trend-param').value = 'do';
  $('#seasonal-param').value = 'temp';   // temperature shows the clearest seasonal cycle
  $('#profile-param').value = 'salinity';
  fillCompareSelect();
}

function fillCompareSelect() {
  const sel = $('#compare-station');
  if (!sel) return;
  const cur = STATE.compare;
  const opts = [...DATA.stations].sort((a, b) => a.river_order - b.river_order)
    .filter((s) => s.id !== STATE.station)
    .map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
  sel.innerHTML = `<option value="">— none —</option>` + opts;
  sel.value = (cur && +cur !== STATE.station) ? cur : '';
  STATE.compare = sel.value;
}

/* ================= year range control (inline header) ================= */
function buildRangeControl() {
  const ymin = DATA.meta.year_min, ymax = DATA.meta.year_max;
  $('#range-control').innerHTML = `
    <span class="range-label">Years</span>
    <div class="range-core">
      <div class="range-sliders">
        <input type="range" id="yr-start" min="${ymin}" max="${ymax}" value="${ymin}" step="1" aria-label="Start year">
        <input type="range" id="yr-end"   min="${ymin}" max="${ymax}" value="${ymax}" step="1" aria-label="End year">
      </div>
      <span class="range-readout" id="range-readout">${ymin}–${ymax}</span>
      <div class="range-presets">
        <button data-y0="${ymin}" data-y1="${ymax}" class="rp active">All</button>
        <button data-y0="${ymax - 4}" data-y1="${ymax}" class="rp">5 yr</button>
        <button data-y0="${ymax - 9}" data-y1="${ymax}" class="rp">10 yr</button>
        <button data-y0="2020" data-y1="2021" class="rp">'20–21</button>
      </div>
    </div>`;

  const s0 = $('#yr-start'), s1 = $('#yr-end');
  const apply = () => {
    $('#range-readout').textContent = STATE.y0 === STATE.y1 ? `${STATE.y0}` : `${STATE.y0}–${STATE.y1}`;
    document.querySelectorAll('.rp').forEach((btn) =>
      btn.classList.toggle('active', +btn.dataset.y0 === STATE.y0 && +btn.dataset.y1 === STATE.y1));
    recomputeWindow();
  };
  const onSlide = () => {
    let a = +s0.value, b = +s1.value;
    if (a > b) { if (document.activeElement === s0) { b = a; s1.value = b; } else { a = b; s0.value = a; } }
    STATE.y0 = a; STATE.y1 = b; apply();
  };
  s0.addEventListener('input', onSlide);
  s1.addEventListener('input', onSlide);
  document.querySelectorAll('.rp').forEach((btn) => btn.addEventListener('click', () => {
    STATE.y0 = +btn.dataset.y0; STATE.y1 = +btn.dataset.y1;
    s0.value = STATE.y0; s1.value = STATE.y1; apply();
  }));
}

/* ================= view switching ================= */
const VIEW_META = {
  trends:   { title: 'How an indicator changes over time', sub: 'Full measurement history with the long-term trend, health guidelines, and readings that crossed them — overlay a second station to compare.' },
  seasonal: { title: 'The river’s seasonal rhythm',        sub: 'Typical value by month with its range, so you can tell a normal seasonal swing from something unusual.' },
  profile: { title: 'From headwaters to the sea', sub: 'Explore how water-quality measurements vary along the LaHave River, from its freshwater headwaters to the coastal estuary.' },  ranking:  { title: 'Which stretches are healthiest',      sub: 'One Water Quality Index per station over the chosen years, each weighted by how much data stands behind it.' },
  signals:  { title: 'Readings worth a second look',        sub: 'Exceedances, unusual values, and expected natural conditions — kept honestly apart.' },
  quality:  { title: 'How we keep the numbers honest',      sub: 'What is set aside, what is measured, and why a merely-odd reading is never called a problem.' },
};
function placeDescriptor(s) { return ''; }  // retired — station name is the primary heading
function bindViewTabs() {
  document.querySelectorAll('#viewtabs button').forEach((b) =>
    b.addEventListener('click', () => switchView(b.dataset.view)));
}
function switchView(view) {
  STATE.view = view;
  document.querySelectorAll('#viewtabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  $(`#view-${view}`).classList.remove('hidden');
  renderActiveView();
}
function renderViewHeader() {
  const m = VIEW_META[STATE.view]; if (!m) return;
  const s = DATA.stations.find((x) => x.id === STATE.station);
  const ctx = (STATE.view === 'ranking' || STATE.view === 'quality') ? ''
    : s ? `<span class="vh-ctx">${s.name}</span>` : '';
  $('#view-header').innerHTML = `<div class="vh-title">${m.title}${ctx}</div><div class="vh-sub">${m.sub}</div>`;
}
function renderActiveView() {
  renderViewHeader();
  switch (STATE.view) {
    case 'trends': renderTrend(); break;
    case 'seasonal': renderSeasonal(); break;
    case 'profile': renderProfile(); break;
    case 'ranking': renderRanking(); break;
    case 'signals': renderAnoms(); break;
    case 'quality': renderDataQuality(); break;
  }
}

/* ================= trends ================= */
function seriesPoints(sid, pkey, y0, y1) {
  const s = DATA.series[`${sid}|${pkey}`] || [];
  return s.filter(([d]) => { const y = +d.slice(0, 4); return y >= y0 && y <= y1; })
          .map(([d, v]) => ({ x: Date.parse(d), y: v }));
}

function renderTrend() {
  const pkey = $('#trend-param').value, sid = STATE.station;
  const key = `${sid}|${pkey}`;
  const series = DATA.series[key] || [];
  const life = DATA.stats[key];
  const p = pkeys[pkey];
  const gl = p.guideline;
  $('#trend-caption').innerHTML = chartCaption(p, { scope: `measured over ${winText()}` });
  const y0 = STATE.y0, y1 = STATE.y1;
  const fullWindow = (y0 === DATA.meta.year_min && y1 === DATA.meta.year_max);
  const ptsAll = series.map(([d, v]) => ({ x: Date.parse(d), y: v }));
  const ptsWin = seriesPoints(sid, pkey, y0, y1);

  const ctx = $('#trend-chart').getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 300);
  grad.addColorStop(0, 'rgba(31,138,132,.20)'); grad.addColorStop(1, 'rgba(31,138,132,0)');

  const datasets = [];
  if (!fullWindow) datasets.push({ label: 'outside window', data: ptsAll, parsing: false,
    borderColor: 'rgba(109,125,128,.28)', borderWidth: 1, pointRadius: 0, fill: false, tension: 0.25, order: 5 });

  const mainPts = fullWindow ? ptsAll : ptsWin;
  datasets.push({ label: `${(DATA.stations.find((x)=>x.id===sid)||{}).name || ''}`, data: mainPts, parsing: false,
    borderColor: RIVER, backgroundColor: STATE.compare ? 'transparent' : grad, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5,
    pointHoverBackgroundColor: RIVER, pointHoverBorderColor: '#fffdf8', pointHoverBorderWidth: 2, tension: 0.25, fill: !STATE.compare, order: 2 });

  // exceedance markers: readings that cross a guideline (scatter overlay)
  if (gl) {
    const excPts = mainPts.filter((pt) => {
      if (gl.max !== undefined && pt.y > gl.max) return true;
      if (gl.min !== undefined && !gl.wqi_skip_low && pt.y >= 0 && pt.y < gl.min) return true;
      return false;
    });
    if (excPts.length) datasets.push({ label: `past guideline (${excPts.length})`, data: excPts, parsing: false,
      type: 'scatter', showLine: false, pointRadius: 3.2, pointHoverRadius: 5,
      pointBackgroundColor: '#c1584f', pointBorderColor: '#fffdf8', pointBorderWidth: 1, order: 0 });
  }

  // Theil–Sen trend line (drawn across the window, anchored at the window median)
  if (STATE.trendline && !STATE.compare && life && life.trend_per_year != null && mainPts.length >= 2) {
    const slope = life.trend_per_year; // per year
    const xs = mainPts.map((pt) => pt.x), ys = mainPts.map((pt) => pt.y);
    const xMid = (xs[0] + xs[xs.length - 1]) / 2;
    const yMid = [...ys].sort((a, b) => a - b)[ys.length >> 1];
    const MS_PER_YR = 365.25 * 864e5;
    const trendAt = (x) => yMid + slope * ((x - xMid) / MS_PER_YR);
    datasets.push({ label: `trend ${slope > 0 ? '↑' : slope < 0 ? '↓' : '→'}`, parsing: false,
      data: [{ x: xs[0], y: trendAt(xs[0]) }, { x: xs[xs.length - 1], y: trendAt(xs[xs.length - 1]) }],
      borderColor: '#146b6a', borderWidth: 1.6, borderDash: [7, 4], pointRadius: 0, fill: false, order: 1 });
  }

  // compare overlay
  if (STATE.compare) {
    const cid = +STATE.compare;
    const cpts = seriesPoints(cid, pkey, y0, y1);
    const cname = (DATA.stations.find((x) => x.id === cid) || {}).name || 'other';
    datasets.push({ label: cname, data: cpts, parsing: false,
      borderColor: '#c8a56b', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, pointHoverRadius: 5,
      pointHoverBackgroundColor: '#c8a56b', tension: 0.25, fill: false, order: 2 });
  }

  // guideline reference lines
  if (gl && series.length) {
    const xmin = Date.parse(series[0][0]), xmax = Date.parse(series[series.length - 1][0]);
    ['max', 'min'].forEach((k) => {
      if (gl[k] !== undefined) {
        const soft = (k === 'min' && gl.wqi_skip_low);
        datasets.push({ label: `guideline ${k}${soft ? ' (reference)' : ''}`, parsing: false,
          data: [{ x: xmin, y: gl[k] }, { x: xmax, y: gl[k] }],
          borderColor: soft ? 'rgba(199,154,62,.6)' : 'rgba(193,88,79,.55)',
          borderWidth: 1.2, borderDash: soft ? [2, 4] : [6, 5], pointRadius: 0, fill: false, order: 4 });
      }
    });
  }

  if (trendChart) trendChart.destroy();
  trendChart = new Chart($('#trend-chart'), { type: 'line', data: { datasets },
    options: { responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: { legend: { display: true, labels: { color: MUTED, boxWidth: 12, font: { size: 10.5 }, usePointStyle: true, filter: (i) => i.text !== 'outside window' } },
        tooltip: { callbacks: { title: (it) => new Date(it[0].raw.x).toISOString().slice(0, 10), label: (it) => `${it.dataset.label}: ${fmt(it.raw.y)} ${p.unit}` } } },
      scales: { x: { type: 'time', time: { unit: 'year' }, ticks: { color: MUTED, maxTicksLimit: 12 }, grid: { color: LINE } },
        y: { ticks: { color: MUTED }, grid: { color: LINE }, title: { display: !!p.unit, text: p.unit, color: MUTED } } } } });

  const badge = $('#trend-badge');
  if (life && life.trend_per_year !== null && life.trend_per_year !== undefined) {
    const slope = life.trend_per_year;
    const dir = Math.abs(slope) < 1e-6 ? 'flat' : slope > 0 ? 'up' : 'down';
    const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→';
    badge.className = `trend-badge ${dir}`;
    badge.textContent = `${arrow} ${fmt(slope, 3)} ${p.unit}/yr · full record`;
  } else { badge.className = 'trend-badge'; badge.textContent = (life && life.n < 6) ? `only ${life ? life.n : 0} samples` : 'no reliable trend'; }

  const ws = windowStats(sid, pkey, y0, y1);
  const winTxt = y0 === y1 ? `${y0}` : `${y0}–${y1}`;
  const sg = $('#trend-stats');
  if (ws) {
    const cells = [['readings', fmt(ws.n, 0), `in ${winTxt}`], ['lowest', fmt(ws.min), p.unit],
      ['typical', fmt(ws.median), p.unit], ['average', fmt(ws.mean), p.unit], ['highest', fmt(ws.max), p.unit],
      ['latest', life ? fmt(life.latest) : '—', life ? life.latest_date : '']];
    sg.innerHTML = cells.map(([l, v, u]) => `<div class="fig"><b>${v}</b><small>${l}${u ? ' · ' + u : ''}</small></div>`).join('');
  } else sg.innerHTML = `<div class="fig"><b>—</b><small>No ${p.label} in ${winTxt}</small></div>`;
}

function renderSeasonal() {
  const pkey = $('#seasonal-param').value, sid = STATE.station, p = pkeys[pkey];
  $('#seasonal-caption').innerHTML = chartCaption(p, { scope: `monthly pattern · ${winText()}` });
  const host = $('#seasonal-wrap');

  // Compute per-month median / min / max from the raw series within the window,
  // so the band reflects the chosen years (richer than a single median line).
  const series = DATA.series[`${sid}|${pkey}`] || [];
  const byMonth = Array.from({ length: 12 }, () => []);
  series.forEach(([d, v]) => {
    const y = +d.slice(0, 4); if (y < STATE.y0 || y > STATE.y1) return;
    byMonth[+d.slice(5, 7) - 1].push(v);
  });
  const monthsWithData = byMonth.filter((a) => a.length).length;
  if (monthsWithData < 4) {
    host.innerHTML = `<p class="hint">Not enough months of ${p.label} data at ${(DATA.stations.find((x)=>x.id===sid)||{}).name || 'this station'} in ${winText()} for a seasonal pattern. Try another indicator, station, or a wider window.</p>`;
    return;
  }
  const med = byMonth.map((a) => a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : null);
  const lo = byMonth.map((a) => a.length ? Math.min(...a) : null);
  const hi = byMonth.map((a) => a.length ? Math.max(...a) : null);

  host.innerHTML = `<canvas id="seasonal-canvas"></canvas>`;
  if (seasonChart) seasonChart.destroy();
  seasonChart = new Chart($('#seasonal-canvas'), { type: 'line',
    data: { labels: MONTHS, datasets: [
      { label: 'range (min–max)', data: hi, spanGaps: true, borderColor: 'transparent',
        backgroundColor: 'rgba(47,111,158,.10)', pointRadius: 0, fill: '+1', tension: 0.4, order: 3 },
      { label: 'range floor', data: lo, spanGaps: true, borderColor: 'transparent',
        backgroundColor: 'transparent', pointRadius: 0, fill: false, tension: 0.4, order: 3 },
      { label: `${p.label} monthly median${unitText(p)}`, data: med, spanGaps: true,
        borderColor: ESTUARY, backgroundColor: 'transparent', borderWidth: 2.2, pointRadius: 3,
        pointBackgroundColor: ESTUARY, tension: 0.4, fill: false, order: 1 } ] },
    options: { responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: true, labels: { color: MUTED, boxWidth: 12, font: { size: 10.5 }, usePointStyle: true,
        filter: (i) => i.text !== 'range floor' } },
        tooltip: { filter: (it) => it.dataset.label !== 'range floor',
          callbacks: { title: (it) => it[0].label, label: (it) => `${it.dataset.label.includes('range') ? 'highest' : 'median'}: ${fmt(it.raw)} ${p.unit}` } } },
      scales: { x: { ticks: { color: MUTED }, grid: { display: false } },
        y: { ticks: { color: MUTED }, grid: { color: LINE }, title: { display: !!p.unit, text: p.unit, color: MUTED } } } } });
}

function renderProfile() {
  const pkey = ($('#profile-param') && $('#profile-param').value) || 'salinity';
  const p = pkeys[pkey];
  $('#profile-caption').innerHTML = chartCaption(p, { station: 'all 20 stations', scope: `median by station · ${winText()}` });
  const rows = [...DATA.stations]
    .map((s) => { const ws = windowStats(s.id, pkey, STATE.y0, STATE.y1); return ws ? { station: s.name, river_order: s.river_order, median: ws.median, type: s.type } : null; })
    .filter(Boolean).sort((a, b) => a.river_order - b.river_order);
  if (profileChart) profileChart.destroy();
  profileChart = new Chart($('#profile-chart'), { type: 'bar',
    data: { labels: rows.map((r) => r.station), datasets: [{ label: `${p.label} median${unitText(p)}`, data: rows.map((r) => r.median),
      backgroundColor: rows.map((r) => (r.type === 'Estuary' ? ESTUARY : RIVER) + 'cc'),
      borderColor: rows.map((r) => r.type === 'Estuary' ? ESTUARY : RIVER), borderWidth: 1, borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (it) => `${fmt(it.raw)} ${p.unit}` } },
        title: { display: true, text: `Headwaters → estuary · ${STATE.y0}–${STATE.y1}`, color: MUTED, font: { size: 12 } } },
      scales: { x: { ticks: { color: MUTED, maxRotation: 60, minRotation: 45, font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: MUTED }, grid: { color: LINE }, title: { display: !!p.unit, text: p.unit, color: MUTED } } } } });
}

/* ================= signals ================= */
function renderAnoms() {
  const show = ($('#anom-filter') && $('#anom-filter').value) || 'all';
  const thisOnly = $('#anom-this-station') && $('#anom-this-station').checked;
  let list = DATA.anomalies.filter((a) => { const y = +a.date.slice(0, 4); return y >= STATE.y0 && y <= STATE.y1; });
  if (show !== 'all') list = list.filter((a) => a.kind === show);
  if (thisOnly) list = list.filter((a) => a.station_id === STATE.station);
  const total = list.length; list = list.slice(0, 120);
  const el = $('#anom-list');
  if (!list.length) { el.innerHTML = `<p class="hint">No readings match in ${STATE.y0}–${STATE.y1}.</p>`; return; }
  el.innerHTML = list.map((a) => {
    const p = DATA.params.find((x) => x.key === a.pkey);
    let cls, tag;
    if (a.kind === 'exceedance') { cls = a.exceedance === 'high' ? 'exc-high' : 'exc-low'; tag = `<span class="tag exc">${a.exceedance === 'high' ? 'Above' : 'Below'} guideline</span>`; }
    else if (a.kind === 'natural') { cls = 'natural'; tag = `<span class="tag nat">Natural</span>`; }
    else { cls = 'stat'; tag = `<span class="tag stat">Unusual · review</span>`; }
    return `<div class="sig ${cls}" data-sid="${a.station_id}">
      <span class="when">${a.date}</span>
      <span class="what"><b>${a.param}</b> · ${a.station}${a.note ? `<span class="note">${a.note}</span>` : ''}</span>
      <span class="val">${fmt(a.value)} ${p ? p.unit : ''}</span>${tag}</div>`;
  }).join('') + (total > list.length ? `<p class="hint">Showing 120 of ${fmt(total, 0)} — narrow the window or filter.</p>` : '');
  el.querySelectorAll('.sig').forEach((row) => row.addEventListener('click', () => selectStation(+row.dataset.sid)));
}

/* ================= ranking ================= */
function renderRanking() {
  const ranked = Object.values(STATE.wqi).sort((a, b) => b.score - a.score);
  const winTxt = STATE.y0 === STATE.y1 ? `${STATE.y0}` : `${STATE.y0}–${STATE.y1}`;
  const rw = $('#rank-window'); if (rw) rw.textContent = winTxt;
  const missing = DATA.stations.length - ranked.length;
  $('#rank-list').innerHTML = ranked.map((w, i) => {
    const col = RATING_COLOR[w.rating]; const cf = CONF_META[w.confidence];
    const exc = `${fmt(w.tests_failed, 0)} of ${fmt(w.tests_total, 0)} readings outside guidelines`;
    return `<div class="rank" data-sid="${w.station_id}">
      <span class="pos">${i + 1}</span>
      <span class="rn">${w.station}<small>${w.rating} · <span style="color:${cf.color}">${cf.label}</span> · ${exc}</small></span>
      <span class="rbar"><i style="width:${w.score}%;background:${col}"></i></span>
      <span class="rsc" style="color:${col}">${w.score}</span></div>`;
  }).join('') + (missing > 0 ? `<p class="hint">${missing} station(s) have no indicator data in ${winTxt} and are left out.</p>` : '');
  $('#rank-list').querySelectorAll('.rank').forEach((row) => row.addEventListener('click', () => selectStation(+row.dataset.sid)));
  highlightRank();
}
function highlightRank() {
  document.querySelectorAll('#rank-list .rank').forEach((r) => r.classList.toggle('sel', +r.dataset.sid === STATE.station));
}

/* ================= data quality ================= */
function renderDataQuality() {
  const dq = DATA.meta.data_quality || {}, ex = DATA.dq_examples || [];
  $('#dq-body').innerHTML = `
    <div class="qa-grid">
      <div class="qa"><b>${fmt(DATA.meta.n_analysis_grade, 0)}</b><small>readings used in the analysis</small></div>
      <div class="qa"><b>${fmt(dq.implausible_values || 0, 0)}</b><small>impossible readings set aside</small></div>
      <div class="qa"><b>${fmt(dq.off_unit_rows || 0, 0)}</b><small>non-standard units, not guideline-tested</small></div>
      <div class="qa"><b>${fmt(dq.below_detection || 0, 0)}</b><small>below the lab detection limit</small></div>
    </div>
    <p class="view-note">Physically impossible readings — a dissolved-oxygen value far above what water can hold, say — are set aside from every statistic, chart and score, never silently deleted and never shown as real. Readings in a non-standard unit are kept for display but left out of the pass/fail guideline check, so a unit mix-up can't manufacture a false warning.</p>
    ${ex.length ? `<div class="qa-list">${ex.map((e) => `<div class="qa-row"><span class="when">${e.date}</span><span class="what"><b>${e.param}</b> · ${e.station}</span><span class="val">${fmt(e.value)} ${e.unit}</span><span class="tag">set aside</span></div>`).join('')}</div>` : ''}`;
}

/* ================= controls ================= */
function bindControls() {
  $('#map-param').addEventListener('change', (e) => colorMap(e.target.value));
  $('#trend-param').addEventListener('change', renderTrend);
  $('#compare-station').addEventListener('change', (e) => { STATE.compare = e.target.value; renderTrend(); });
  $('#trendline-toggle').addEventListener('change', (e) => { STATE.trendline = e.target.checked; renderTrend(); });
  $('#seasonal-param').addEventListener('change', renderSeasonal);
  $('#profile-param').addEventListener('change', renderProfile);
  $('#anom-filter').addEventListener('change', renderAnoms);
  $('#anom-this-station').addEventListener('change', renderAnoms);
}

})();
