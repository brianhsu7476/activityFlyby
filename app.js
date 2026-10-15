// Flyby comparer: overlay several activities and replay them on a shared clock.
// Activity elapsed time e_i = T + off_i + adj_i, where off_i comes from the
// auto alignment mode and adj_i from the activity's manual slider.

const COLORS = ['#FC4C02', '#1F77B4', '#2CA02C', '#9467BD', '#D62728', '#17BECF', '#8C564B', '#E377C2', '#BCBD22', '#7F7F7F'];
const SPEEDS = [1, 5, 10, 30, 60, 120, 300, 600];
const TAIL_SECONDS = 90;
const METRICS = ['hr', 'cad', 'pwr']; // optional sensor channels kept per sample
const EXAMPLES = [
  { name: '西進武嶺', files: ['西進武嶺2023.fit', '西進武嶺2024-1.fit', '西進武嶺2024-2.fit', '西進武嶺2025.fit', '西進武嶺2026.fit'] },
  { name: '環小台灣', files: ['環小台灣2023.fit', '環小台灣2026.fit'] },
  { name: '椰林盃', files: ['椰林盃2022.fit', '椰林盃2023.fit', '椰林盃2024.fit', '椰林盃2025.fit', '椰林盃2026.fit'] },
];

const state = {
  acts: [],
  mode: 'point',       // 'point' | 'start' | 'clock'
  refId: null,
  T: 0, Tmin: 0, Tmax: 0,
  playing: false,
  speed: 30,
  follow: false,
  spectate: false,     // camera keeps every rider in view, gliding smoothly
  startInfo: '',
  nextId: 1,
};

const $ = sel => document.querySelector(sel);

// ---------- geometry ----------
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371008.8, toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function buildActivity(parsed) {
  const pts = parsed.points, n = pts.length;
  const t = new Float64Array(n), lat = new Float64Array(n), lon = new Float64Array(n);
  const ele = new Float64Array(n), dist = new Float64Array(n);
  const sensors = {}, has = {};
  for (const k of METRICS) {
    has[k] = pts.some(p => p[k] != null);
    if (has[k]) sensors[k] = Float32Array.from(pts, p => p[k] ?? NaN);
  }
  const useRecorded = pts.every(p => p.dist != null);
  let hasEle = false;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    t[i] = (p.time - pts[0].time) / 1000;
    lat[i] = p.lat; lon[i] = p.lon;
    ele[i] = p.ele ?? NaN;
    if (p.ele != null) hasEle = true;
    let d = i === 0 ? 0 : useRecorded ? p.dist - pts[0].dist
      : dist[i - 1] + haversine(lat[i - 1], lon[i - 1], lat[i], lon[i]);
    dist[i] = i === 0 ? 0 : Math.max(dist[i - 1], d);
  }
  if (hasEle) { // fill gaps in elevation
    let last = NaN;
    for (let i = 0; i < n; i++) { if (Number.isNaN(ele[i])) ele[i] = last; else last = ele[i]; }
    for (let i = n - 1; i >= 0; i--) { if (Number.isNaN(ele[i])) ele[i] = last; else last = ele[i]; }
  }
  const id = state.nextId++;
  return {
    id, name: parsed.name, color: COLORS[(id - 1) % COLORS.length], visible: true,
    startMs: pts[0].time, t, lat, lon, ele, dist, hasEle, n, sensors, has,
    duration: t[n - 1], total: dist[n - 1], off: 0, adj: 0, base: 0, t0: 0, t1: t[n - 1],
  };
}

// index of last sample with arr[i] <= x (arr non-decreasing)
function lowerIndex(arr, x) {
  let lo = 0, hi = arr.length - 1;
  if (x <= arr[0]) return 0;
  if (x >= arr[hi]) return hi;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (arr[mid] <= x) lo = mid; else hi = mid; }
  return lo;
}

// only [a.t0, a.t1] is ever shown: not riding to / waiting at the start, nor anything after the finish
function sampleAt(a, e) {
  const status = e < a.t0 ? 'waiting' : e >= a.t1 ? 'finished' : 'riding';
  const ec = Math.min(Math.max(e, a.t0), a.t1);
  const i = lowerIndex(a.t, ec), j = Math.min(i + 1, a.n - 1);
  const span = a.t[j] - a.t[i], f = span > 0 ? (ec - a.t[i]) / span : 0;
  const lerp = arr => arr[i] + (arr[j] - arr[i]) * f;
  return { lat: lerp(a.lat), lon: lerp(a.lon), ele: lerp(a.ele), dist: lerp(a.dist), rd: lerp(a.rd), status };
}

// index of first sample with arr[i] >= x (arr non-decreasing), or arr.length
function upperIndex(arr, x, from = 0) {
  let lo = from, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

// time the activity first reaches route distance d (arrival, not departure, if it stopped there)
function timeAtDist(a, d) {
  if (d > a.rtotal || d < 0) return null;
  const j = Math.max(upperIndex(a.rd, d, lowerIndex(a.t, a.t0)), 1), i = j - 1;
  if (j >= a.n) return a.t[a.n - 1];
  const span = a.rd[j] - a.rd[i], f = span > 0 ? Math.max(0, (d - a.rd[i]) / span) : 1;
  // never before the start: interpolating across a recording gap at the start would reach back into it
  return Math.max(a.t[i] + (a.t[j] - a.t[i]) * f, a.t0);
}

function elevationAtDist(a, d) {
  const i = lowerIndex(a.rd, d), j = Math.min(i + 1, a.n - 1);
  const span = a.rd[j] - a.rd[i], f = span > 0 ? (d - a.rd[i]) / span : 0;
  return a.ele[i] + (a.ele[j] - a.ele[i]) * f;
}

// mean of a sensor channel over the last `win` seconds before e (NaN if not recorded there)
function windowAvg(a, k, e, win) {
  const arr = a.sensors[k];
  if (!arr || e < a.t0 || e > a.t1) return NaN;
  let sum = 0, cnt = 0;
  for (let i = lowerIndex(a.t, e); i >= 0 && a.t[i] > e - win; i--) {
    if (!Number.isNaN(arr[i])) { sum += arr[i]; cnt++; }
  }
  return cnt ? sum / cnt : NaN;
}

const elapsed = (a, T) => T + a.off + a.adj;
const relDist = (a, T) => sampleAt(a, elapsed(a, T)).rd;

// ---------- alignment ----------
const CELL = 0.0006; // ~60 m grid for proximity lookups
const ON_TRACK = 40;  // m: a candidate start point must be this close to every track
const cellKey = (lat, lon) => `${Math.floor(lat / CELL)},${Math.floor(lon / CELL)}`;

// direction of travel at sample i, as a unit vector (east, north) over ±HEAD_SPAN metres of
// riding; null where it is ambiguous (a U-turn, or standing still with no way in or out)
const HEAD_SPAN = 25; // m
function headingAt(a, i) {
  const j0 = lowerIndex(a.dist, a.dist[i] - HEAD_SPAN), j1 = Math.min(upperIndex(a.dist, a.dist[i] + HEAD_SPAN), a.n - 1);
  const cos = Math.cos(a.lat[i] * Math.PI / 180);
  const x = (a.lon[j1] - a.lon[j0]) * M_PER_DEG * cos, y = (a.lat[j1] - a.lat[j0]) * M_PER_DEG;
  const len = Math.hypot(x, y);
  return len < HEAD_SPAN * 0.8 ? null : { x: x / len, y: y / len };
}

// Passes of `a` through (lat, lon) travelling in direction `head` (within ~60°), in time order:
// { i: sample closest to the point, arrive: first sample of that pass within ARRIVE_SLACK m of
// that closest distance }. Passes in the opposite direction don't count: riding against the
// route to a meeting point is not starting, and riding back past the line is not finishing.
const SAME_WAY = 0.5;     // cos 60°
const ARRIVE_SLACK = 20;  // m
function passesThrough(a, cells, lat, lon, head) {
  const ci = Math.floor(lat / CELL), cj = Math.floor(lon / CELL);
  const idx = [];
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
    for (const i of cells.get(`${ci + di},${cj + dj}`) || []) idx.push(i);
  }
  idx.sort((p, q) => p - q);
  const out = [];
  let run = [];
  const close = () => {
    if (!run.length) return;
    let best = run[0];
    for (const r of run) if (r.d < best.d) best = r;
    const h = best.d <= ON_TRACK ? headingAt(a, best.i) : null;
    if (h && h.x * head.x + h.y * head.y >= SAME_WAY) {
      out.push({ i: best.i, arrive: run.find(r => r.d <= best.d + ARRIVE_SLACK).i });
    }
    run = [];
  };
  for (let k = 0; k < idx.length; k++) {
    if (k > 0 && a.t[idx[k]] - a.t[idx[k - 1]] > 30) close(); // gap: that pass is over
    run.push({ i: idx[k], d: haversine(a.lat[idx[k]], a.lon[idx[k]], lat, lon) });
  }
  close();
  return out;
}

function firstPass(a, cells, lat, lon, head) {
  const p = passesThrough(a, cells, lat, lon, head);
  return p.length ? p[0].i : -1;
}

// arrival index of the first such pass made after the rider has covered the route up to
// within FINISH_ZONE of route distance d (so a loop's early pass through the start/finish area
// doesn't count, and neither does circling back over the line after finishing), or -1
const FINISH_ZONE = 500; // m
function finishArrival(a, cells, lat, lon, head, d) {
  const p = passesThrough(a, cells, lat, lon, head).find(q => a.t[q.arrive] > a.t0 && a.rd[q.arrive] >= d - FINISH_ZONE);
  return p ? p.arrive : -1;
}

// stops: runs slower than STOP_SPEED lasting at least STOP_MIN seconds, as [first, last] sample index
const STOP_SPEED = 1;  // m/s
const STOP_MIN = 15;   // s
function stopsOf(a) {
  if (a.stops) return a.stops;
  a.stops = [];
  let s = -1;
  for (let i = 1; i <= a.n; i++) {
    const slow = i < a.n && (a.dist[i] - a.dist[i - 1]) < STOP_SPEED * (a.t[i] - a.t[i - 1]);
    if (slow && s < 0) s = i - 1;
    if (!slow && s >= 0) { if (a.t[i - 1] - a.t[s] >= STOP_MIN) a.stops.push([s, i - 1]); s = -1; }
  }
  return a.stops;
}

// Nobody rests at the start: waiting in the start area (a stop within START_ZONE metres along
// the track of the start crossing c) is start-line waiting, so the ride begins when it ends.
const START_ZONE = 300; // m
function setStart(a, c) {
  let idx = c;
  for (const [s, e] of stopsOf(a)) {
    if (a.dist[e] >= a.dist[c] - START_ZONE && a.dist[s] <= a.dist[c] + START_ZONE && e > idx) idx = e;
  }
  a.off = a.t0 = a.t[idx];
  a.base = a.dist[idx];
}

// ---------- route distance ----------
// Devices disagree on distance (one of the examples records 8% more than the rest), so all
// comparisons use a.rd: distance along the *reference* track from the start, found by
// following each activity along the reference. Off-route stretches keep rd flat.
const MATCH_RADIUS = 60; // m
const M_PER_DEG = 111195; // metres per degree of latitude

function routeCells(ref, from) {
  const m = new Map();
  for (let i = from; i < ref.n; i++) {
    const k = cellKey(ref.lat[i], ref.lon[i]);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(i);
  }
  return m;
}

// route distance of (lat, lon) projected onto reference segment j..j+1
function projectOnSegment(ref, j, lat, lon) {
  const k = Math.min(j + 1, ref.n - 1);
  const cos = Math.cos(lat * Math.PI / 180);
  const sx = (ref.lon[k] - ref.lon[j]) * cos, sy = ref.lat[k] - ref.lat[j];
  const px = (lon - ref.lon[j]) * cos, py = lat - ref.lat[j];
  const len2 = sx * sx + sy * sy;
  const f = len2 > 0 ? Math.min(Math.max((px * sx + py * sy) / len2, 0), 1) : 0;
  return ref.dist[j] + (ref.dist[k] - ref.dist[j]) * f - ref.base;
}

function projectRoute(a, ref, cells, refFrom) {
  a.rd = new Float64Array(a.n);
  a.onRoute = true;
  if (a === ref) {
    for (let i = 0; i < a.n; i++) a.rd[i] = Math.max(0, a.dist[i] - a.base);
  } else {
    const i0 = lowerIndex(a.t, a.t0);
    let k = -1, lastT = 0, cur = 0, matched = 0, lastI = -1;
    for (let i = i0; i < a.n; i++) {
      const ci = Math.floor(a.lat[i] / CELL), cj = Math.floor(a.lon[i] / CELL);
      const cos = Math.cos(a.lat[i] * Math.PI / 180);
      // only plausible forward progress, so crossings of the route don't teleport the rider
      const lo = k < 0 ? -Infinity : ref.dist[k] - 30;
      const hi = k < 0 ? Infinity : ref.dist[k] + 200 + 30 * (a.t[i] - lastT);
      let best = -1, bestD = Infinity;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        const list = cells.get(`${ci + di},${cj + dj}`);
        if (!list) continue;
        let q = 0, r = list.length; // first entry with ref.dist >= lo (lists are in track order)
        while (q < r) { const m = (q + r) >> 1; if (ref.dist[list[m]] < lo) q = m + 1; else r = m; }
        for (; q < list.length; q++) {
          const j = list[q];
          if (ref.dist[j] > hi) break;
          const dy = (a.lat[i] - ref.lat[j]) * M_PER_DEG, dx = (a.lon[i] - ref.lon[j]) * M_PER_DEG * cos;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d >= MATCH_RADIUS) continue;
          // first match: earliest reference pass; afterwards: the nearest point
          if (best < 0 || (k < 0 ? j < best : d < bestD)) { bestD = d; best = j; }
        }
      }
      if (best >= 0) {
        const p = Math.max(projectOnSegment(ref, best, a.lat[i], a.lon[i]),
          best > refFrom ? projectOnSegment(ref, best - 1, a.lat[i], a.lon[i]) : -Infinity);
        const next = Math.max(cur, p);
        // Back on the route after an off-route stretch (a parallel road, a detour): spread the
        // progress over the distance ridden off-route instead of jumping ahead in one sample.
        if (lastI >= 0 && i - lastI > 1 && next > cur) {
          const span = a.dist[i] - a.dist[lastI];
          for (let q = lastI + 1; q < i; q++) {
            a.rd[q] = cur + (next - cur) * (span > 0 ? (a.dist[q] - a.dist[lastI]) / span : 0);
          }
        }
        cur = next;
        k = best; lastT = a.t[i]; lastI = i; matched++;
      }
      a.rd[i] = cur;
    }
    a.onRoute = matched >= 0.5 * (a.n - i0);
    if (!a.onRoute) { // mostly a different route: fall back to its own distance
      for (let i = 0; i < a.n; i++) a.rd[i] = Math.max(0, a.dist[i] - a.base);
    }
  }
  a.rtotal = a.rd[a.n - 1];
}

function computeAlignment() {
  const acts = state.acts;
  state.startInfo = '';
  if (!acts.length) return;
  const ref = acts.find(a => a.id === state.refId) || acts[0];
  state.refId = ref.id;
  if (state.mode === 'start') {
    for (const a of acts) setStart(a, 0); // each from the moment they actually leave their own start
  } else if (state.mode === 'clock') {
    const minStart = Math.min(...acts.map(a => a.startMs));
    for (const a of acts) { a.off = (minStart - a.startMs) / 1000; a.base = 0; a.t0 = 0; }
  } else {
    // Candidate start points along the reference; pick the one that every activity reaches
    // earliest (minimise the largest distance anyone rides before getting there). Taking the
    // first shared point instead breaks loops started at different places: someone may pass
    // the reference's start only at the very end of their ride.
    const others = acts.filter(a => a !== ref).map(a => ({ a, cells: routeCells(a, 0) }));
    let bestIdx = -1, bestCost = Infinity, lastD = -Infinity, bestPass = null;
    for (let i = 0; i < ref.n; i++) {
      if (ref.dist[i] - lastD < 50 && i !== ref.n - 1) continue; // sample every ~50 m
      lastD = ref.dist[i];
      if (ref.dist[i] >= bestCost) break; // the reference alone already costs more
      const head = headingAt(ref, i);
      if (!head) continue;
      let cost = ref.dist[i];
      const pass = new Map();
      for (const o of others) {
        const j = firstPass(o.a, o.cells, ref.lat[i], ref.lon[i], head);
        if (j < 0) { cost = Infinity; break; }
        pass.set(o.a, j);
        cost = Math.max(cost, o.a.dist[j]);
        if (cost >= bestCost) break;
      }
      if (cost < bestCost) { bestCost = cost; bestIdx = i; bestPass = pass; }
    }
    const found = bestIdx >= 0;
    const startIdx = found ? bestIdx : 0;
    for (const a of acts) setStart(a, a === ref ? startIdx : found ? bestPass.get(a) : 0);
    state.startInfo = found
      ? `共同起點：參考活動第 ${(ref.dist[startIdx] / 1000).toFixed(2)} km 處`
      : '找不到所有活動都經過的點，改為各自的起點開始';
  }
  const refFrom = lowerIndex(ref.t, ref.t0);
  const cells = routeCells(ref, refFrom);
  for (const a of acts) projectRoute(a, ref, cells, refFrom);
  setFinish(acts, ref);
  updateRange();
}

// Common finish, the mirror of the common start: scanning back from the reference's end, the
// point (passed in the reference's direction) after which nobody rides much further — minimise
// the largest distance anyone records past it. Each rider finishes on first arriving there once
// they have ridden the route; whatever they ride afterwards (cooling down, heading home) is never shown and
// cannot change the order.
function setFinish(acts, ref) {
  for (const a of acts) a.t1 = a.duration;
  if (acts.length < 2) return;
  const all = acts.map(a => ({ a, cells: routeCells(a, 0) }));
  const refFrom = lowerIndex(ref.t, ref.t0);
  let bestIdx = -1, bestCost = Infinity, bestArr = null, lastD = Infinity;
  for (let i = ref.n - 1; i > refFrom; i--) {
    if (lastD - ref.dist[i] < 50 && i !== ref.n - 1) continue; // sample every ~50 m
    lastD = ref.dist[i];
    if (ref.total - ref.dist[i] >= bestCost) break; // the reference alone already costs more
    const head = headingAt(ref, i);
    if (!head) continue;
    let cost = 0;
    const arr = new Map();
    for (const { a, cells } of all) {
      const j = finishArrival(a, cells, ref.lat[i], ref.lon[i], head, ref.dist[i] - ref.base);
      if (j < 0) { cost = Infinity; break; }
      arr.set(a, j);
      cost = Math.max(cost, a.total - a.dist[j]);
      if (cost >= bestCost) break;
    }
    if (cost < bestCost) { bestCost = cost; bestIdx = i; bestArr = arr; }
  }
  if (bestIdx < 0) return;
  for (const a of acts) a.t1 = a.t[bestArr.get(a)];
  state.startInfo += `${state.startInfo ? '\n' : ''}共同終點：參考活動第 ${(ref.dist[bestIdx] / 1000).toFixed(2)} km 處`;
}

function updateRange() {
  const vis = state.acts.filter(a => a.visible);
  if (!vis.length) { state.Tmin = state.Tmax = state.T = 0; return; }
  state.Tmin = Math.min(...vis.map(a => a.t0 - a.off - a.adj));
  state.Tmax = Math.max(...vis.map(a => a.t1 - a.off - a.adj));
  state.T = Math.min(Math.max(state.T, state.Tmin), state.Tmax);
}

// ---------- formatting ----------
function fmtDur(s, signed = false) {
  const sign = s < 0 ? '−' : signed ? '+' : '';
  s = Math.round(Math.abs(s));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  const mmss = `${String(m).padStart(h ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`;
  return sign + (h ? `${h}:${mmss}` : mmss);
}
const fmtKm = m => `${(m / 1000).toFixed(2)} km`;
const fmtDate = ms => new Date(ms).toLocaleString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const escapeHtml = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- map ----------
let map = null;
// Full tracks (canvas) and the moving markers/tails (SVG) use separate renderers, so
// moving a marker only repaints the marker's own small area, not every full track.
let trackRenderer = null, liveRenderer = null;
const layers = new Map(); // id -> { line, tail, marker, status }

function initMap() {
  if (typeof L === 'undefined') {
    $('#map').innerHTML = '<p class="map-error">地圖函式庫載入失敗（需要網路連線），其餘功能仍可使用。</p>';
    return;
  }
  map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([25.02, 121.54], 11);
  // Small padding: Leaflet's default 0.5 makes each canvas 4x the map area, and
  // repainting a canvas that big is what made playback stutter on laptops.
  trackRenderer = L.canvas({ padding: 0.1 });
  liveRenderer = L.svg({ padding: 0.1 });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
}

function rebuildLayers() {
  if (!map) return;
  for (const l of layers.values()) { l.line.remove(); l.tail.remove(); l.marker.remove(); }
  layers.clear();
  const bounds = [];
  for (const a of state.acts) {
    const latlngs = [];
    const step = Math.max(1, Math.floor(a.n / 4000));
    for (let i = 0; i < a.n; i += step) latlngs.push([a.lat[i], a.lon[i]]);
    const line = L.polyline(latlngs, { color: a.color, weight: 3, opacity: 0.35, renderer: trackRenderer });
    const tail = L.polyline([], { color: a.color, weight: 5, opacity: 0.9, renderer: liveRenderer });
    const marker = L.circleMarker([a.lat[0], a.lon[0]], { radius: 8, color: '#fff', weight: 2, fillColor: a.color, fillOpacity: 1, renderer: liveRenderer })
      .bindTooltip(escapeHtml(a.name));
    if (a.visible) { line.addTo(map); tail.addTo(map); marker.addTo(map); latlngs.forEach(p => bounds.push(p)); }
    layers.set(a.id, { line, tail, marker, status: null });
  }
  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30], animate: false });
}

function updateMap() {
  if (!map) return;
  let leader = null, leadD = -Infinity;
  for (const a of state.acts) {
    const l = layers.get(a.id);
    if (!l || !a.visible) continue;
    const e = elapsed(a, state.T);
    const s = sampleAt(a, e);
    l.marker.setLatLng([s.lat, s.lon]);
    if (l.status !== s.status) { l.status = s.status; l.marker.setStyle({ fillOpacity: s.status === 'riding' ? 1 : 0.4 }); }
    const from = lowerIndex(a.t, Math.max(a.t0, e - TAIL_SECONDS)), to = lowerIndex(a.t, Math.min(Math.max(e, a.t0), a.t1));
    const tail = [];
    for (let i = from; i <= to; i++) tail.push([a.lat[i], a.lon[i]]);
    tail.push([s.lat, s.lon]);
    l.tail.setLatLngs(e > 0 ? tail : []);
    if (s.rd > leadD) { leadD = s.rd; leader = s; }
  }
  // Re-centre only when the leader nears the edge: panning every frame forces the
  // map (tiles and every track) to redraw on every frame.
  if (state.follow && leader && !state.spectate) {
    const p = map.latLngToContainerPoint([leader.lat, leader.lon]), size = map.getSize();
    if (p.x < size.x * 0.2 || p.x > size.x * 0.8 || p.y < size.y * 0.2 || p.y > size.y * 0.8) {
      map.panTo([leader.lat, leader.lon], { animate: false });
    }
  }
}

// ---------- spectator camera ----------
// Its own animation loop (not tied to playback), so seeking, pausing and speed changes all glide.
const CAM_TAU = 0.6;     // s: time constant of the camera easing
const CAM_MAX_ZOOM = 16;
const CAM_PAD = 60;      // px kept free around the riders
let cam = null, camFrame = null;

// View (centre + fractional zoom) that fits every rider now *and* where each one will ride in
// the next CAM_LOOKAHEAD seconds of playback (speed × that much riding time). At high speed the
// camera frames the stretch about to be ridden rather than zooming far out, and since riders
// need CAM_LOOKAHEAD seconds to cross that window the map never streaks past.
const CAM_LOOKAHEAD = 3; // s of wall-clock playback
const CAM_LOOK_STEPS = 12;
function camTarget() {
  const vis = state.acts.filter(a => a.visible);
  const pts = vis.map(a => {
    const s = sampleAt(a, elapsed(a, state.T));
    return [s.lat, s.lon];
  });
  if (!pts.length) return null;
  const ahead = [...pts];
  const span = CAM_LOOKAHEAD * state.speed;
  for (const a of vis) {
    const e = elapsed(a, state.T);
    if (e >= a.t1) continue;
    for (let k = 1; k <= CAM_LOOK_STEPS; k++) {
      const s = sampleAt(a, Math.min(e + (span * k) / CAM_LOOK_STEPS, a.t1));
      ahead.push([s.lat, s.lon]);
    }
  }
  const size = map.getSize();
  const pad = Math.min(CAM_PAD, size.x / 6, size.y / 6);
  const b = L.latLngBounds(ahead);
  const zoom = Math.min(map.getBoundsZoom(b, false, L.point(pad * 2, pad * 2)), CAM_MAX_ZOOM);
  return { lat: b.getCenter().lat, lon: b.getCenter().lng, zoom, pts };
}

// does view v show every point at least CAM_EDGE px inside the map?
const CAM_EDGE = 16;
function camFits(v, pts) {
  const size = map.getSize(), c = map.project([v.lat, v.lon], v.zoom);
  return pts.every(p => {
    const q = map.project(p, v.zoom).subtract(c);
    return Math.abs(q.x) <= size.x / 2 - CAM_EDGE && Math.abs(q.y) <= size.y / 2 - CAM_EDGE;
  });
}

// Moves the map with Leaflet's internal _move/_moveEnd (Leaflet 1.9): setView would reset the
// view and throw away every tile on each frame. _move shifts the pixel origin, so every frame is
// closed with 'zoom' (tiles and renderers re-transform) and 'zoomend'/'moveend' (paths
// re-project and redraw); otherwise tracks and markers drift off the map until the next reset.
function camStep(now) {
  if (!state.spectate || !map) { cam = null; return; }
  const target = camTarget();
  if (!target) return;
  if (!cam) cam = { lat: target.lat, lon: target.lon, zoom: target.zoom, t: now };
  let k = 1 - Math.exp(-Math.min(now - cam.t, 100) / 1000 / CAM_TAU);
  cam.t = now;
  // The easing alone lags behind at high playback speed; catch up just enough (binary search
  // on the step) that nobody leaves the screen. The target view itself always fits.
  const at = f => ({ lat: cam.lat + (target.lat - cam.lat) * f, lon: cam.lon + (target.lon - cam.lon) * f, zoom: cam.zoom + (target.zoom - cam.zoom) * f });
  if (!camFits(at(k), target.pts)) {
    let lo = k, hi = 1;
    for (let it = 0; it < 10; it++) { const m = (lo + hi) / 2; if (camFits(at(m), target.pts)) hi = m; else lo = m; }
    k = hi;
  }
  const moved = ['lat', 'lon', 'zoom'].map(key => (cam[key] += (target[key] - cam[key]) * k, Math.abs(target[key] - cam[key])));
  if (moved[0] > 1e-7 || moved[1] > 1e-7 || moved[2] > 1e-4) {
    const zoomChanged = map.getZoom() !== cam.zoom;
    map._move(L.latLng(cam.lat, cam.lon), cam.zoom);
    if (!zoomChanged) map.fire('zoom');
    map._moveEnd(true);
  }
}

// While playing, render() moves the camera in the same pass that places the riders (so it never
// aims at last frame's positions); this loop keeps it gliding while paused or scrubbing.
function camTick(now) {
  camFrame = null;
  if (!state.spectate || !map) { cam = null; return; }
  if (!state.playing) camStep(now);
  camFrame = requestAnimationFrame(camTick);
}

function setSpectate(on) {
  state.spectate = on && !!map;
  $('#spectate').checked = state.spectate;
  if (!map) return;
  map.options.zoomSnap = state.spectate ? 0 : 1; // fractional zoom so the camera can glide
  if (state.spectate) {
    if (state.follow) { state.follow = false; $('#follow').checked = false; }
    cam = { lat: map.getCenter().lat, lon: map.getCenter().lng, zoom: map.getZoom(), t: performance.now() };
    if (!camFrame) camFrame = requestAnimationFrame(camTick);
  } else {
    map.setZoom(Math.round(map.getZoom()), { animate: false });
  }
}

// ---------- leaderboard ----------
let boardHtml = '';
function setBoard(html) {
  if (html === boardHtml) return;
  boardHtml = html;
  $('#board').innerHTML = html;
}

function updateBoard() {
  const rows = state.acts.filter(a => a.visible).map(a => {
    const e = elapsed(a, state.T);
    const s = sampleAt(a, e);
    const prev = sampleAt(a, e - 5);
    const speed = s.status === 'riding' ? Math.max(0, (s.dist - prev.dist) / Math.min(5, Math.max(e - a.t0, 1))) * 3.6 : NaN;
    return {
      a, e, s, d: s.rd, speed,
      pwr: windowAvg(a, 'pwr', e, 3), hr: windowAvg(a, 'hr', e, 3), cad: windowAvg(a, 'cad', e, 3),
      fin: s.status === 'finished' ? a.t1 - a.off - a.adj : null, // finish time on the shared clock
    };
  }).sort((x, y) => (x.fin ?? Infinity) - (y.fin ?? Infinity) || y.d - x.d); // finishers by finish time first
  if (!rows.length) { setBoard(''); return; }
  const lead = rows[0];
  // a sensor column only appears when some visible activity recorded it
  const cols = [['pwr', 'W'], ['hr', '心率'], ['cad', '踏頻']].filter(([k]) => rows.some(r => r.a.has[k]));
  const num = (v, digits = 0) => Number.isFinite(v) ? v.toFixed(digits) : '—';
  setBoard(`<table>
    <thead><tr><th></th><th>活動</th><th>距離</th><th>落後</th><th>km/h</th>${cols.map(([, h]) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r, k) => {
      let gap = '—';
      if (k > 0 && r.fin != null) gap = fmtDur(r.fin - lead.fin, true); // behind the winner at the line
      else if (k > 0) {
        // how long ago the leader was where this rider is now: always grows down the table
        const tPass = timeAtDist(lead.a, r.d);
        gap = tPass != null ? fmtDur(lead.e - tPass, true) : `${((lead.d - r.d) / 1000).toFixed(2)} km`;
      }
      const status = r.s.status === 'waiting' ? '<span class="tag">未出發</span>' : r.s.status === 'finished' ? '<span class="tag">完成</span>' : '';
      return `<tr><td><span class="dot" style="background:${r.a.color}"></span>${k + 1}</td>
        <td class="name">${escapeHtml(r.a.name)} ${status}</td>
        <td>${fmtKm(Math.max(0, r.d))}</td><td>${gap}</td><td>${num(r.speed, 1)}</td>${cols.map(([k]) => `<td>${num(r[k])}</td>`).join('')}</tr>`;
    }).join('')}</tbody></table>`);
}

// ---------- charts ----------
// Each chart has a static background (axes, curves, elevation profile) drawn once into
// an offscreen canvas; a frame only copies it and draws the cursor/dots on top.
let chartVersion = 0;     // bump to redraw backgrounds (alignment, visibility, reference, theme)
const chartBg = new Map(); // canvas id -> { key, img, scale }
const canvasSize = new Map(); // canvas id -> { w, h }, refreshed on resize (avoids forced layout per frame)

let theme = null;
function colors() {
  if (!theme) {
    const cs = getComputedStyle(document.body);
    theme = { muted: cs.getPropertyValue('--muted'), grid: cs.getPropertyValue('--grid'),
      area: cs.getPropertyValue('--area'), text: cs.getPropertyValue('--text') };
  }
  return theme;
}

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  let size = canvasSize.get(canvas.id);
  if (!size) { size = { w: canvas.clientWidth, h: canvas.clientHeight }; canvasSize.set(canvas.id, size); }
  const { w, h } = size;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

// draw(ctx) paints the background and returns whatever the per-frame overlay needs
function background(canvas, w, h, draw) {
  const dpr = window.devicePixelRatio || 1;
  const key = `${w}x${h}@${dpr}#${chartVersion}`;
  let bg = chartBg.get(canvas.id);
  if (!bg || bg.key !== key) {
    const img = document.createElement('canvas');
    img.width = Math.round(w * dpr); img.height = Math.round(h * dpr);
    const ctx = img.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bg = { key, img, scale: draw(ctx) };
    chartBg.set(canvas.id, bg);
  }
  return bg;
}

const PAD = { l: 64, r: 16, t: 28, b: 28 };
let gapCache = null; // recomputed when alignment or visibility changes

function chartRange() {
  const vis = state.acts.filter(a => a.visible);
  if (!vis.length) return null;
  const ref = state.acts.find(a => a.id === state.refId);
  const D = Math.min(...vis.map(a => a.rtotal));
  return { vis, ref, D: Math.max(D, 1) };
}

function computeGaps() {
  chartVersion++;
  const r = chartRange();
  if (!r || !r.ref || !r.ref.visible) { gapCache = null; return; }
  const N = 400, series = [];
  let lo = 0, hi = 0;
  for (const a of r.vis) {
    const ys = new Float64Array(N + 1);
    for (let k = 0; k <= N; k++) {
      const d = (r.D * k) / N;
      const ta = timeAtDist(a, d), tr = timeAtDist(r.ref, d);
      const y = ta == null || tr == null ? NaN : (tr - r.ref.off - r.ref.adj) - (ta - a.off - a.adj);
      ys[k] = y;
      if (Number.isFinite(y)) { lo = Math.min(lo, y); hi = Math.max(hi, y); }
    }
    series.push({ a, ys });
  }
  const pad = Math.max(10, (hi - lo) * 0.08);
  gapCache = { D: r.D, N, series, lo: lo - pad, hi: hi + pad };
}

function drawAxes(ctx, w, h, title) {
  const c = colors();
  ctx.fillStyle = c.muted;
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillText(title, PAD.l, 16);
  ctx.strokeStyle = c.grid;
  ctx.lineWidth = 1;
  ctx.strokeRect(PAD.l, PAD.t, w - PAD.l - PAD.r, h - PAD.t - PAD.b);
}

function drawDistTicks(ctx, w, h, D) {
  ctx.fillStyle = colors().muted; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center';
  const stepKm = [0.5, 1, 2, 5, 10, 20, 50, 100].find(s => D / 1000 / s <= 8) || 200;
  for (let km = 0; km * 1000 <= D; km += stepKm) {
    const x = PAD.l + (km * 1000 / D) * (w - PAD.l - PAD.r);
    ctx.fillText(`${km} km`, x, h - 8);
  }
  ctx.textAlign = 'left';
}

function drawGapChart() {
  const canvas = $('#gapChart');
  const { ctx, w, h } = setupCanvas(canvas);
  const bg = background(canvas, w, h, g => {
    const ref = state.acts.find(a => a.id === state.refId);
    drawAxes(g, w, h, `與參考活動（${ref ? ref.name : '—'}）的時間差：往上 = 比參考快（秒）`);
    if (!gapCache) return null;
    const { D, N, series, lo, hi } = gapCache;
    const X = d => PAD.l + (d / D) * (w - PAD.l - PAD.r);
    const Y = v => PAD.t + (1 - (v - lo) / (hi - lo)) * (h - PAD.t - PAD.b);
    const muted = colors().muted;
    g.fillStyle = muted; g.font = '11px system-ui, sans-serif'; g.textAlign = 'right';
    for (const v of [lo, 0, hi]) g.fillText(fmtDur(v, true), PAD.l - 6, Y(v) + 4);
    g.textAlign = 'left';
    g.strokeStyle = muted; g.setLineDash([4, 4]);
    g.beginPath(); g.moveTo(PAD.l, Y(0)); g.lineTo(w - PAD.r, Y(0)); g.stroke(); g.setLineDash([]);
    for (const { a, ys } of series) {
      g.strokeStyle = a.color; g.lineWidth = 2; g.beginPath();
      let pen = false;
      for (let k = 0; k <= N; k++) {
        if (!Number.isFinite(ys[k])) { pen = false; continue; }
        const x = X((D * k) / N), y = Y(ys[k]);
        pen ? g.lineTo(x, y) : g.moveTo(x, y); pen = true;
      }
      g.stroke();
    }
    drawDistTicks(g, w, h, D);
    return { X, Y, D };
  });
  ctx.drawImage(bg.img, 0, 0, w, h);
  if (!bg.scale) return;
  // each rider's dot sits on their own curve at their current distance
  const { X, Y, D } = bg.scale, { N, series } = gapCache;
  for (const { a, ys } of series) {
    const d = Math.min(Math.max(relDist(a, state.T), 0), D);
    const f = (d / D) * N, k = Math.min(Math.floor(f), N - 1);
    const y = ys[k] + (ys[k + 1] - ys[k]) * (f - k);
    if (!Number.isFinite(y)) continue;
    ctx.beginPath(); ctx.arc(X(d), Y(y), 5, 0, Math.PI * 2);
    ctx.fillStyle = a.color; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
  }
}

function drawEleChart() {
  const canvas = $('#eleChart');
  const { ctx, w, h } = setupCanvas(canvas);
  const ref = state.acts.find(a => a.id === state.refId);
  const bg = background(canvas, w, h, g => {
    drawAxes(g, w, h, '參考活動的海拔剖面與目前位置');
    if (!ref || !ref.hasEle) return null;
    const D = ref.rtotal;
    if (D <= 0) return null;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < ref.n; i++) if (ref.dist[i] >= ref.base) { lo = Math.min(lo, ref.ele[i]); hi = Math.max(hi, ref.ele[i]); }
    const pad = Math.max(5, (hi - lo) * 0.1); lo -= pad; hi += pad;
    const X = d => PAD.l + (d / D) * (w - PAD.l - PAD.r);
    const Y = v => PAD.t + (1 - (v - lo) / (hi - lo)) * (h - PAD.t - PAD.b);
    g.beginPath(); g.moveTo(X(0), Y(lo));
    for (let i = 0; i < ref.n; i++) if (ref.dist[i] >= ref.base) g.lineTo(X(ref.dist[i] - ref.base), Y(ref.ele[i]));
    g.lineTo(X(D), Y(lo)); g.closePath();
    g.fillStyle = colors().area; g.fill();
    g.fillStyle = colors().muted;
    g.font = '11px system-ui, sans-serif'; g.textAlign = 'right';
    g.fillText(`${Math.round(hi - pad)} m`, PAD.l - 6, Y(hi - pad) + 4);
    g.fillText(`${Math.round(lo + pad)} m`, PAD.l - 6, Y(lo + pad) + 4);
    g.textAlign = 'left';
    drawDistTicks(g, w, h, D);
    return { X, Y, D };
  });
  ctx.drawImage(bg.img, 0, 0, w, h);
  if (!bg.scale) return;
  const { X, Y, D } = bg.scale;
  for (const a of state.acts) {
    if (!a.visible) continue;
    const d = Math.min(Math.max(relDist(a, state.T), 0), D);
    ctx.beginPath(); ctx.arc(X(d), Y(elevationAtDist(ref, d)), 6, 0, Math.PI * 2);
    ctx.fillStyle = a.color; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
  }
}

// click on a chart: jump to when the reference activity reached that distance
function seekFromChart(ev, canvas) {
  const ref = state.acts.find(a => a.id === state.refId);
  if (!ref) return;
  const D = canvas.id === 'gapChart' ? gapCache?.D : ref.rtotal;
  if (!D) return;
  const rect = canvas.getBoundingClientRect();
  const f = (ev.clientX - rect.left - PAD.l) / (rect.width - PAD.l - PAD.r);
  const t = timeAtDist(ref, Math.min(Math.max(f, 0), 1) * D);
  if (t == null) return;
  state.T = Math.min(Math.max(t - ref.off - ref.adj, state.Tmin), state.Tmax);
  render();
}

// ---------- sidebar ----------
function renderList() {
  const list = $('#acts');
  const maxDur = Math.max(3600, ...state.acts.map(a => a.duration));
  list.innerHTML = state.acts.map(a => `
    <li class="act" data-id="${a.id}">
      <div class="act-head">
        <input type="checkbox" class="vis" ${a.visible ? 'checked' : ''} title="顯示／隱藏">
        <span class="dot" style="background:${a.color}"></span>
        <span class="act-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>
        <button class="icon remove" title="移除">✕</button>
      </div>
      <div class="act-meta">${fmtDate(a.startMs)} · ${fmtKm(a.total)} · ${fmtDur(a.duration)}</div>
      <label class="shift">手動平移
        <input type="range" class="adj" min="${-Math.ceil(maxDur)}" max="${Math.ceil(maxDur)}" step="1" value="${a.adj}">
      </label>
      <div class="shift-row">
        <input type="number" class="adj-num" step="1" value="${a.adj}"> 秒
        <span class="adj-fmt">${fmtDur(a.adj, true)}</span>
        <button class="small reset">歸零</button>
      </div>
    </li>`).join('');
  const refSel = $('#refSelect');
  refSel.innerHTML = state.acts.map(a => `<option value="${a.id}" ${a.id === state.refId ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('');
  $('#startInfo').textContent = state.startInfo;
  $('#empty').hidden = state.acts.length > 0;
}

function onListEvent(ev) {
  const li = ev.target.closest('.act');
  if (!li) return;
  const a = state.acts.find(x => x.id === Number(li.dataset.id));
  const t = ev.target;
  if (t.classList.contains('remove')) {
    state.acts = state.acts.filter(x => x !== a);
    if (state.refId === a.id) state.refId = state.acts[0]?.id ?? null;
    fullRefresh(true);
    return;
  }
  if (t.classList.contains('vis')) { a.visible = t.checked; fullRefresh(true); return; }
  let v = null;
  if (t.classList.contains('adj') || t.classList.contains('adj-num')) v = Math.round(Number(t.value) || 0);
  if (t.classList.contains('reset')) v = 0;
  if (v === null) return;
  a.adj = v;
  li.querySelector('.adj').value = v;
  if (t !== li.querySelector('.adj-num')) li.querySelector('.adj-num').value = v;
  li.querySelector('.adj-fmt').textContent = fmtDur(v, true);
  updateRange(); computeGaps(); render();
}

// ---------- playback ----------
const FRAME_MS = 1000 / 30; // playback redraw cap: plenty for a replay, half the work of 60 fps
const BOARD_MS = 250;       // leaderboard text refresh while playing
let lastBoard = 0;

function setText(el, text) { if (el.textContent !== text) el.textContent = text; }

function render() {
  const slider = $('#time');
  const min = String(Math.floor(state.Tmin)), max = String(Math.ceil(state.Tmax));
  if (slider.min !== min) slider.min = min;
  if (slider.max !== max) slider.max = max;
  slider.value = state.T;
  let label = fmtDur(state.T, true);
  if (state.mode === 'clock' && state.acts.length) {
    const minStart = Math.min(...state.acts.map(a => a.startMs));
    label += ` · ${new Date(minStart + state.T * 1000).toLocaleTimeString('zh-TW', { hour12: false })}`;
  }
  setText($('#timeLabel'), label);
  setText($('#play'), state.playing ? '❚❚ 暫停' : '▶ 播放');
  if (state.playing && state.spectate) camStep(performance.now());
  updateMap();
  const now = performance.now();
  if (!state.playing || now - lastBoard >= BOARD_MS) { lastBoard = now; updateBoard(); }
  drawGapChart(); drawEleChart();
}

let lastFrame = null, lastDraw = 0;
function tick(now) {
  if (!state.playing) { lastFrame = null; return; }
  if (lastFrame != null) {
    state.T += ((now - lastFrame) / 1000) * state.speed;
    if (state.T >= state.Tmax) { state.T = state.Tmax; state.playing = false; }
  }
  lastFrame = now;
  if (!state.playing || now - lastDraw >= FRAME_MS - 2) { lastDraw = now; render(); }
  if (state.playing) requestAnimationFrame(tick);
}

function togglePlay() {
  if (!state.acts.length) return;
  if (!state.playing && state.T >= state.Tmax) state.T = state.Tmin;
  state.playing = !state.playing;
  render();
  if (state.playing) requestAnimationFrame(tick);
}

function fullRefresh(keepView) {
  computeAlignment(); computeGaps(); renderList();
  if (!keepView || layers.size !== state.acts.length) rebuildLayers();
  else for (const a of state.acts) {
    const l = layers.get(a.id);
    for (const layer of [l.line, l.tail, l.marker]) a.visible ? layer.addTo(map) : layer.remove();
  }
  render();
}

// ---------- files ----------
async function addFiles(files) {
  const errors = [];
  $('#status').textContent = `讀取中…（${files.length} 個檔案）`;
  const parsed = [];
  for (const f of files) {
    try { parsed.push(await parseActivityFile(f)); }
    catch (err) { errors.push(`${f.name}：${err.message}`); }
  }
  // added together, right before alignment: frames drawn while parsing must not see half-built activities
  for (const p of parsed) state.acts.push(buildActivity(p));
  $('#status').textContent = errors.join('\n');
  if (state.refId == null && state.acts.length) state.refId = state.acts[0].id;
  state.T = 0;
  fullRefresh(false);
  if (state.mode !== 'point') state.T = state.Tmin;
  render();
}

async function loadExample(ex) {
  $('#status').textContent = `下載範例中…（${ex.name}）`;
  let files;
  try {
    files = await Promise.all(ex.files.map(async f => {
      const res = await fetch('examples/' + encodeURIComponent(f));
      if (!res.ok) throw new Error(`${f}：HTTP ${res.status}`);
      return new File([await res.blob()], f);
    }));
  } catch (err) {
    $('#status').textContent = `範例載入失敗：${err.message}`;
    return;
  }
  state.acts = []; state.refId = null; state.playing = false; state.nextId = 1;
  await addFiles(files);
}

function init() {
  initMap();
  const speedSel = $('#speed');
  speedSel.innerHTML = SPEEDS.map(s => `<option value="${s}" ${s === state.speed ? 'selected' : ''}>${s}×</option>`).join('');
  speedSel.addEventListener('change', () => { state.speed = Number(speedSel.value); });
  const exBox = $('#examples');
  for (const ex of EXAMPLES) {
    const b = document.createElement('button');
    b.className = 'small';
    b.textContent = `${ex.name}（${ex.files.length} 筆）`;
    b.addEventListener('click', () => loadExample(ex));
    exBox.append(b);
  }
  $('#fileInput').addEventListener('change', e => { addFiles([...e.target.files]); e.target.value = ''; });
  const drop = $('#drop');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); addFiles([...e.dataTransfer.files]); });
  $('#mode').addEventListener('change', e => { state.mode = e.target.value; fullRefresh(true); state.T = state.mode === 'point' ? 0 : state.Tmin; render(); });
  $('#refSelect').addEventListener('change', e => { state.refId = Number(e.target.value); fullRefresh(true); });
  $('#resetAll').addEventListener('click', () => { state.acts.forEach(a => { a.adj = 0; }); fullRefresh(true); });
  $('#follow').addEventListener('change', e => {
    state.follow = e.target.checked;
    if (state.follow && state.spectate) setSpectate(false);
    render();
  });
  $('#spectate').addEventListener('change', e => setSpectate(e.target.checked));
  // grabbing the map hands control back to the viewer
  if (map) {
    map.on('dragstart', () => { if (state.spectate) setSpectate(false); });
    for (const el of [map.getContainer(), map.zoomControl.getContainer()]) {
      el.addEventListener(el === map.getContainer() ? 'wheel' : 'click', () => { if (state.spectate) setSpectate(false); }, { passive: true });
    }
  }
  $('#fit').addEventListener('click', () => rebuildLayers());
  $('#play').addEventListener('click', togglePlay);
  $('#time').addEventListener('input', e => { state.T = Number(e.target.value); render(); });
  $('#acts').addEventListener('input', onListEvent);
  $('#acts').addEventListener('click', e => { if (e.target.matches('button')) onListEvent(e); });
  for (const c of [$('#gapChart'), $('#eleChart')]) c.addEventListener('click', e => seekFromChart(e, c));
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && !e.target.matches('input, select, button')) { e.preventDefault(); togglePlay(); }
  });
  window.addEventListener('resize', () => { canvasSize.clear(); render(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { theme = null; chartVersion++; render(); });
  renderList(); render();
}

init();
