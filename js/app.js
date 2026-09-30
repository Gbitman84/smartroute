import { createDb } from './db.js';
import { googleMapsKey } from './firebase-config.js';
import * as maps from './maps/provider.js';
import { solvePath } from './solver.js';
import { wazeUrl, gmapsUrl, gmapsSegments } from './nav.js';
import { STARTER_NAMES, nameIssue, nameWords } from './names.js';
import {
  captureInvite, ensureMember, isSuperEmail, emailRefName, nameRefName, refId, registrationUrl,
} from './members.js';
import {
  $, el, esc, todayStr, fmtDate, fmtTime, fmtDist, fmtDur, norm, addressKey, fullAddress,
  splitAddress, haversine, decodePolyline, getCurrentPosition, prefs,
} from './util.js';

// ------------------------------------------------------------------ constants
const STATUS = {
  pending:         { label: 'ממתין',          icon: '⏳', active: true },
  no_answer_temp:  { label: 'לא ענה – זמני',   icon: '📵', active: true, cls: 'temp' },
  delivered_hand:  { label: 'נמסר ביד',        icon: '🤝', final: true, cls: 'done' },
  delivered_door:  { label: 'נמסר ליד הדלת',   icon: '🚪', final: true, cls: 'done' },
  no_answer_final: { label: 'לא ענה – סופי',   icon: '❌', final: true, cls: 'nofinal' },
};
const DEFAULT_SETTINGS = { defaultCity: 'חולון', geocoder: googleMapsKey ? 'google' : 'osm', googleKey: googleMapsKey || '', optimizer: 'google', serviceSeconds: 90, traffic: true, routeMode: 'both', readMode: 'auto' };
// Two route engines, each with its own frozen "initial" and its own "updated" numbering.
const F = {
  osrm:   { init: 'initialStop', initSub: 'initialSub', upd: 'updatedStop', updSub: 'updatedSub', has: 'hasInitialRoute', line: 'routePolyline', dist: 'routeDistance', dur: 'routeDuration', built: 'initialBuiltAt' },
  google: { init: 'smartInitialStop', initSub: 'smartInitialSub', upd: 'smartUpdatedStop', updSub: 'smartUpdatedSub', has: 'hasSmartInitial', line: 'smartPolyline', dist: 'smartDistance', dur: 'smartDuration', built: 'smartInitialBuiltAt' },
};
const MODE_LABEL = { regular: '🆓 רגיל', smart: '🧠 חכם (Google)', both: '⚖️ גם וגם' };
const MODE_ENGINES = { regular: ['osrm'], smart: ['google'], both: ['google', 'osrm'] };
function routeMode() {
  if (S.day?.routeMode) return S.day.routeMode;
  if (S.day?.hasSmartInitial) return S.day?.hasInitialRoute ? 'both' : 'smart';
  return 'regular';
}
const showSmart = () => routeMode() !== 'regular';
const showRegular = () => routeMode() !== 'smart';
const primary = () => (showSmart() ? F.google : F.osrm);
const updKey = (d) => orderKey(d[primary().upd], d[primary().updSub]);
const updLabel = (d) => stopLabel(d[primary().upd], d[primary().updSub]);
const initLabel = (d) => stopLabel(d[primary().init], d[primary().initSub]);
const hasAnyRoute = () => !!(S.day?.hasInitialRoute || S.day?.hasSmartInitial);
const ENGINE_LABEL = { google: '🧠 Google Route Optimization', osrm: '🆓 מנוע חינמי (OSRM)' };

// ------------------------------------------------------------------ state
const S = {
  db: null, user: null,
  today: todayStr(), date: todayStr(),
  version: 1, key: todayStr(), versions: [1], // several work runs ("versions") per date
  day: null, deliveries: [], unsubs: [],
  unlocked: false,
  hideDone: prefs.get('hideDone', false),
  search: '',
  sort: prefs.get('sort', 'updated'),
  me: null, dist: {}, distAt: null,
  streets: {}, settings: { ...DEFAULT_SETTINGS },
  map: null, layers: null, pickFor: null, mapFitted: false,
  movePromptShown: false,
};

// ------------------------------------------------------------------ helpers
const isFinal = (d) => !!STATUS[d.status]?.final || !!d.movedTo;
const isActive = (d) => !isFinal(d);
const hasCoords = (d) => d.lat != null && d.lng != null;
const latestVersion = () => Math.max(...S.versions, S.version);
const isArchive = () => S.date < S.today || S.version < latestVersion();
const readonly = () => isArchive() && !S.unlocked;
// Firestore key of a work run: "2026-09-30" for version 1, "2026-09-30_v2" for version 2 …
const dayKey = (date, version = 1) => (version > 1 ? `${date}_v${version}` : date);
const parseKey = (key) => { const m = String(key).match(/^(\d{4}-\d{2}-\d{2})(?:_v(\d+))?$/); return { date: m ? m[1] : key, version: m?.[2] ? +m[2] : 1 }; };
const verLabel = (v, latest, many) => (many ? ` · גרסה ${v}${v === latest ? ' (אחרון)' : ''}` : '');
function fmtKey(key) { const { date, version } = parseKey(key); return date.split('-').reverse().join('/') + (version > 1 ? ` גרסה ${version}` : ''); }
const fmtStamp = (ts) => { const d = new Date(ts); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${fmtTime(ts)}`; };
const stopLabel = (stop, sub) => (stop == null ? null : sub ? `${stop}-${sub}` : `${stop}`);
const orderKey = (stop, sub) => (stop == null ? Infinity : stop * 1000 + (sub || 0));
const now = () => Date.now();

function toast(msg, { err = false, ms = 3200 } = {}) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  if (ms) toast._t = setTimeout(() => (t.hidden = true), ms);
}

// Windows (sheets) stack on top of each other. Each open window owns one browser-history
// entry, so the phone's Back button closes the top window and returns to the previous one.
const modalStack = [];
let histDepth = 0;      // history entries currently owned by open windows
let ignorePops = 0;     // popstate events caused by our own history.go()
let syncTimer = null;

function syncHistory() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    const extra = histDepth - modalStack.length;
    if (extra > 0) { histDepth = modalStack.length; ignorePops++; history.go(-extra); }
  }, 0);
}

function openModal(build, { onClose } = {}) {
  const root = $('#modalRoot');
  const sheet = el('div', { class: 'sheet', role: 'dialog' });
  const overlay = el('div', { class: 'overlay' }, sheet);
  const entry = { closed: false };
  entry.remove = () => {
    if (entry.closed) return;
    entry.closed = true;
    overlay.remove();
    modalStack.splice(modalStack.indexOf(entry), 1);
    onClose?.();
  };
  const close = () => { entry.remove(); syncHistory(); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  sheet.append(el('div', { class: 'sheet-head' },
    el('button', { class: 'sheet-back', type: 'button', onclick: close }, modalStack.length ? '→ חזרה' : '→ סגור')));
  build(sheet, close);
  root.append(overlay);
  modalStack.push(entry);
  history.pushState({ smartrun: 'modal' }, '');
  histDepth++;
  return close;
}

// Close every open window (used after an action finishes).
function closeAll() {
  [...modalStack].reverse().forEach((e) => e.remove());
  syncHistory();
}

function showExitPrompt() {
  if ($('#exitPrompt')) return;
  const stay = () => { box.remove(); history.pushState({ smartrun: 'guard' }, ''); };
  const box = el('div', { class: 'overlay', id: 'exitPrompt' }, el('div', { class: 'sheet' },
    el('h2', {}, 'לצאת מ-SmartRoute?'),
    el('p', { class: 'muted' }, 'כל הנתונים שמורים בענן. לחיצה נוספת על "חזרה" בטלפון תסגור את האפליקציה.'),
    el('div', { class: 'sheet-actions' },
      el('button', { class: 'btn primary', type: 'button', onclick: stay }, 'הישאר'),
      el('button', { class: 'btn danger', type: 'button', onclick: () => { box.remove(); history.back(); setTimeout(() => window.close(), 300); } }, 'יציאה'),
    )));
  box.addEventListener('click', (e) => { if (e.target === box) stay(); });
  document.body.append(box);
}

function onPopState() {
  if (ignorePops > 0) { ignorePops--; return; }
  if ($('#exitPrompt')) { $('#exitPrompt').remove(); return; } // second Back while the prompt is up → leave
  if (modalStack.length) {
    histDepth = Math.max(0, histDepth - 1);
    modalStack[modalStack.length - 1].remove();
    return;
  }
  history.pushState({ smartrun: 'guard' }, '');
  if (S.pickFor) { S.pickFor = null; $('#pickHint').hidden = true; return; }
  if (S.search) { setSearch(''); return; }
  showExitPrompt();
}

function confirmModal({ title, body, okText = 'אישור', cancelText = 'ביטול', danger = false, requireWord = null }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v, close) => { done = true; close(); resolve(v); };
    openModal((m, close) => {
      m.append(el('h2', {}, title));
      if (body) m.append(typeof body === 'string' ? el('p', { html: body }) : body);
      let input;
      const ok = el('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), type: 'button', onclick: () => finish(true, close) }, okText);
      if (requireWord) {
        input = el('input', { type: 'text', placeholder: `הקלד "${requireWord}"`, autocomplete: 'off' });
        ok.disabled = true;
        input.addEventListener('input', () => (ok.disabled = input.value.trim() !== requireWord));
        m.append(el('label', { class: 'field' }, `כדי לאשר הקלד: ${requireWord}`, input));
      }
      m.append(el('div', { class: 'sheet-actions' }, ok, el('button', { class: 'btn', type: 'button', onclick: () => finish(false, close) }, cancelText)));
      input?.focus();
    }, { onClose: () => { if (!done) resolve(false); } });
  });
}

// ------------------------------------------------------------------ streets autocomplete
async function ensureStreets(city) {
  city = (city || '').trim();
  if (!city) return [];
  if (S.streets[city]) return S.streets[city];
  const metaName = 'streets-' + city;
  try {
    const cached = await S.db.getMeta(metaName);
    if (cached?.names?.length) return (S.streets[city] = cached.names);
  } catch { /* ignore */ }
  try {
    const names = await maps.streets(city);
    S.streets[city] = names;
    if (names.length) S.db.setMeta(metaName, { names, city, at: now() }).catch(() => {});
    return names;
  } catch (e) {
    console.warn('streets', e);
    return (S.streets[city] = []);
  }
}

function attachAutocomplete(input, getCity) {
  const wrap = input.parentElement;
  let box = null, items = [], idx = -1;
  const hide = () => { box?.remove(); box = null; idx = -1; };
  const pick = (name) => { input.value = name; hide(); input.dispatchEvent(new Event('change')); };
  const show = async () => {
    const list = await ensureStreets(getCity());
    items = maps.streetSuggest(list, input.value);
    hide();
    if (!items.length || (items.length === 1 && norm(items[0]) === norm(input.value))) return;
    const q = norm(input.value);
    box = el('div', { class: 'ac-list' });
    items.forEach((name) => {
      const n = norm(name), i = n.indexOf(q);
      const html = i >= 0 && n === name.toLowerCase()
        ? esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + q.length)) + '</mark>' + esc(name.slice(i + q.length))
        : esc(name);
      box.append(el('div', { html, onmousedown: (e) => { e.preventDefault(); pick(name); } }));
    });
    wrap.append(box);
  };
  input.setAttribute('autocomplete', 'off');
  input.addEventListener('input', show);
  input.addEventListener('focus', () => { if (input.value) show(); });
  input.addEventListener('blur', () => setTimeout(hide, 150));
  input.addEventListener('keydown', (e) => {
    if (!box) return;
    const nodes = [...box.children];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      idx = (idx + (e.key === 'ArrowDown' ? 1 : -1) + nodes.length) % nodes.length;
      nodes.forEach((n, i) => n.classList.toggle('on', i === idx));
    } else if (e.key === 'Enter' && idx >= 0) { e.preventDefault(); pick(items[idx]); }
    else if (e.key === 'Escape') hide();
  });
}

// ------------------------------------------------------------------ geocoding
async function geocodeDelivery(d, { force = false } = {}) {
  const key = addressKey(d);
  let res = null;
  if (!force) {
    const c = await S.db.getGeo(key).catch(() => null);
    if (c && (c.precision === 'house' || c.precision === 'manual' || c.src === maps.geocoderName())) res = c;
  }
  if (!res) {
    try {
      const r = await maps.geocode({ street: d.street, houseNo: d.houseNo, city: d.city });
      res = r ? { lat: r.lat, lng: r.lng, precision: r.precision, src: maps.geocoderName(), at: now() } : { precision: 'none', src: maps.geocoderName(), at: now() };
      if (r) S.db.setGeo(key, res).catch(() => {});
    } catch (e) {
      console.warn('geocode', e);
      res = { precision: 'none' };
    }
  }
  const patch = res.lat != null
    ? { lat: res.lat, lng: res.lng, geoStatus: res.precision === 'house' ? 'ok' : res.precision === 'manual' ? 'manual' : 'approx' }
    : { lat: null, lng: null, geoStatus: 'failed' };
  await S.db.updateDelivery(S.key, d.shipmentId, patch);
  return patch;
}

async function geocodeMany(list, { force = false } = {}) {
  if (!list.length) return;
  const seen = new Map();
  let i = 0, failed = 0;
  for (const d of list) {
    i++;
    toast(`מאתר כתובות ${i}/${list.length}…`, { ms: 0 });
    const k = addressKey(d);
    let patch = seen.get(k);
    if (patch) await S.db.updateDelivery(S.key, d.shipmentId, patch);
    else { patch = await geocodeDelivery(d, { force }); seen.set(k, patch); }
    if (patch.geoStatus === 'failed') failed++;
  }
  toast(failed ? `איתור הסתיים – ${failed} כתובות לא אותרו (מסומנות באדום)` : 'כל הכתובות אותרו ✓', { err: !!failed, ms: 5000 });
}

// ------------------------------------------------------------------ route building
async function resolvePoint(spec) {
  if (spec.type === 'gps') {
    const p = await getCurrentPosition();
    setMe(p);
    return { lat: p.lat, lng: p.lng, type: 'gps', text: 'מיקום נוכחי' };
  }
  const text = spec.text.trim();
  const { street, houseNo } = splitAddress(text.split(',')[0]);
  const city = (text.split(',')[1] || S.settings.defaultCity).trim();
  const r = await maps.geocode({ street, houseNo, city });
  if (!r) throw new Error(`לא נמצאה הכתובת: ${text}`);
  return { lat: r.lat, lng: r.lng, type: 'address', text: `${street} ${houseNo}, ${city}`.replace(/\s+,/, ',') };
}

async function buildMatrix(points, approaches) {
  const fallback = () => points.map((a) => points.map((b) => haversine(a, b) / 7));
  if (points.length > 100) return fallback();
  try {
    const m = await maps.matrix(points, approaches);
    return m.map((row, i) => row.map((v, j) => (v == null ? haversine(points[i], points[j]) / 7 : v)));
  } catch (e) {
    console.warn('matrix fallback', e);
    toast('שירות המסלולים לא זמין – משתמש במרחק אווירי', { err: true });
    return fallback();
  }
}

// Order the stop groups with the chosen engine. Google → Cloud Function; falls back to the free engine.
const pt = (p) => ({ lat: p.lat, lng: p.lng });
async function optimizeOrder(start, end, gList, engine = S.settings.optimizer) {
  if (engine === 'google' && S.db.optimize) {
    try {
      const r = await S.db.optimize({
        start: pt(start), end: end ? pt(end) : null, stops: gList.map(pt),
        serviceSeconds: +S.settings.serviceSeconds || 0, traffic: S.settings.traffic !== false,
      });
      S.db.incUsage('routeoptRequests').catch(() => {});
      S.db.incUsage('routeoptShipments', gList.length).catch(() => {});
      const seen = new Set(r.order);
      const orderIdx = [...r.order, ...gList.map((_, i) => i).filter((i) => !seen.has(i))];
      return { engine: 'google', orderIdx, line: r.polyline ? { polyline: r.polyline, distance: r.distance, duration: r.travelSeconds, total: r.totalSeconds } : null };
    } catch (e) {
      console.warn('google optimize', e);
      toast('Google לא זמין (' + (e.message || e) + ') – משתמש במנוע החינמי', { err: true, ms: 6000 });
    }
  }
  const points = [start, ...gList, ...(end ? [end] : [])];
  // Stops are approached from the curb side (right-hand traffic); start/end are unrestricted.
  const approaches = points.map((p, i) => (i === 0 || (end && i === points.length - 1) ? 'unrestricted' : 'curb'));
  const matrix = await buildMatrix(points, approaches);
  const orderIdx = solvePath(matrix, { hasEnd: !!end }).map((i) => i - 1);
  const linePts = [start, ...orderIdx.map((i) => gList[i]), ...(end ? [end] : [])];
  let line = null;
  try { line = await maps.routeLine(linePts, linePts.map((p, i) => (i === 0 || (end && i === linePts.length - 1) ? 'unrestricted' : 'curb'))); } catch (e) { console.warn('route line', e); }
  return { engine: 'osrm', orderIdx, line };
}

async function buildRoute(kind, startSpec, endSpec, mode = routeMode()) {
  const eligible = S.deliveries.filter((d) => isActive(d) && hasCoords(d));
  if (!eligible.length) throw new Error('אין כתובות פעילות מאותרות לבניית מסלול');

  toast('מחשב מסלול…', { ms: 0 });
  const start = await resolvePoint(startSpec);
  const end = endSpec ? await resolvePoint(endSpec) : null;

  const groups = new Map();
  for (const d of eligible) {
    const k = addressKey(d);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  }
  const gList = [...groups.values()].map((members) => {
    members.sort((a, b) => (a.appOrder ?? 1e9) - (b.appOrder ?? 1e9) || String(a.shipmentId).localeCompare(String(b.shipmentId)));
    return { members, lat: members[0].lat, lng: members[0].lng };
  });

  const patches = new Map();                       // shipmentId → merged patch
  const put = (id, patch) => patches.set(id, { ...(patches.get(id) || {}), ...patch });
  const dayPatch = { start, end: end || null, updatedBuiltAt: now() };
  const done = [];
  let effective = mode;

  for (const want of MODE_ENGINES[mode]) {
    toast(`מחשב מסלול ${want === 'google' ? 'חכם (Google)' : 'רגיל'}…`, { ms: 0 });
    const res = await optimizeOrder(start, end, gList, want);
    if (want === 'google' && res.engine !== 'google') {
      // Google unavailable: in "both" the regular engine still runs; in "smart" use the regular result as regular.
      if (mode === 'both') { effective = S.day?.hasSmartInitial ? 'both' : 'regular'; continue; }
      effective = 'regular';
    }
    const f = F[res.engine];
    const isInitial = !S.day?.[f.has];
    const touched = new Set();
    res.orderIdx.map((i) => gList[i]).forEach((g, gi) => {
      g.members.forEach((d, mi) => {
        const stop = gi + 1, sub = g.members.length > 1 ? mi + 1 : null;
        put(d.shipmentId, { [f.upd]: stop, [f.updSub]: sub, ...(isInitial ? { [f.init]: stop, [f.initSub]: sub } : {}) });
        touched.add(d.shipmentId);
      });
    });
    for (const d of S.deliveries) if (!touched.has(d.shipmentId) && d[f.upd] != null) put(d.shipmentId, { [f.upd]: null, [f.updSub]: null });
    Object.assign(dayPatch, { [f.line]: res.line?.polyline || null, [f.dist]: res.line?.distance ?? null, [f.dur]: res.line?.duration ?? null });
    if (isInitial) Object.assign(dayPatch, { [f.has]: true, [f.built]: now() });
    done.push({ engine: res.engine, line: res.line, initial: isInitial, stops: gList.length });
    if (mode === 'smart' && res.engine !== 'google') break;
  }
  dayPatch.routeMode = effective;
  if (dayPatch.hasInitialRoute || dayPatch.hasSmartInitial) dayPatch.initialBuiltAt ||= S.day?.initialBuiltAt || now();

  await S.db.updateMany(S.key, [...patches].map(([id, patch]) => ({ id, patch })));
  await S.db.saveDay(S.key, dayPatch);

  const skipped = S.deliveries.filter((d) => isActive(d) && !hasCoords(d)).length;
  toast(done.map((r) => `${r.engine === 'google' ? '🧠 חכם' : '🆓 רגיל'} ${r.initial ? 'ראשוני' : 'מעודכן'}: ${r.line ? fmtDist(r.line.distance) + ' · ' + fmtDur(r.line.duration) : r.stops + ' עצירות'}`).join(' | ') +
    (skipped ? ` · ${skipped} לא אותרו` : ''), { ms: 7000 });
  return effective;
}

// ------------------------------------------------------------------ location & distances
function setMe(p) {
  S.me = p;
  reportLocation(p);
  renderMap();
}

// Last known location for the admin panel – at most once a minute, only when the app already has a fix.
let lastLocSave = 0;
function reportLocation(p) {
  if (!S.user || S.blocked || now() - lastLocSave < 60000) return;
  lastLocSave = now();
  S.db.saveProfile({ lastLocation: { lat: p.lat, lng: p.lng, accuracy: Math.round(p.accuracy || 0), at: p.at || now() } }).catch(() => {});
}

async function refreshLocation() {
  const btn = $('#refreshBtn');
  btn.disabled = true;
  try {
    toast('מאתר מיקום…', { ms: 0 });
    const me = await getCurrentPosition();
    setMe(me);
    const targets = S.deliveries.filter((d) => isActive(d) && hasCoords(d));
    const dist = {};
    targets.forEach((d) => (dist[d.shipmentId] = { air: haversine(me, d) }));
    // Unique coordinates only (several parcels at one address).
    const uniq = new Map();
    targets.forEach((d) => { const k = `${d.lat.toFixed(6)},${d.lng.toFixed(6)}`; if (!uniq.has(k)) uniq.set(k, { lat: d.lat, lng: d.lng, ids: [] }); uniq.get(k).ids.push(d.shipmentId); });
    const pts = [...uniq.values()];
    toast('מחשב מרחקים…', { ms: 0 });
    let failed = 0;
    for (let i = 0; i < pts.length; i += 90) {
      const chunk = pts.slice(i, i + 90);
      const [car, foot] = await Promise.allSettled([maps.fromOrigin([me, ...chunk], 'car'), maps.fromOrigin([me, ...chunk], 'foot')]);
      chunk.forEach((p, j) => p.ids.forEach((id) => {
        if (car.status === 'fulfilled') dist[id].car = car.value[j];
        if (foot.status === 'fulfilled') dist[id].foot = foot.value[j];
      }));
      if (car.status === 'rejected' || foot.status === 'rejected') failed++;
    }
    S.dist = dist;
    S.distAt = now();
    render();
    toast(failed ? 'חלק מהמרחקים חושבו באוויר (שירות המסלולים לא זמין)' : `המרחקים עודכנו (${targets.length} יעדים)`, { err: !!failed });
  } catch (e) {
    toast(e.message, { err: true, ms: 6000 });
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------------------------ status
async function setStatus(d, status) {
  if (readonly()) return;
  // Where the status was set (if the location is fresh) – shown on the admin panel map.
  const here = S.me && now() - S.me.at < 5 * 60000 ? { lat: S.me.lat, lng: S.me.lng } : {};
  // Appended on the server (arrayUnion), so two devices changing the same delivery both keep their entry.
  const entry = { id: `${now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, status, at: now(), ...here };
  await S.db.appendHistory(S.key, d.shipmentId, { status, statusAt: now() }, entry);
  if (STATUS[status].final) toast(`${d.name || d.shipmentId}: ${STATUS[status].label}`);
  getCurrentPosition().then(setMe).catch(() => {}); // keep the last location fresh, no continuous tracking
}

function statusSheet(d) {
  openModal((m, close) => {
    m.append(el('h2', {}, `סטטוס · ${d.name || d.shipmentId}`), el('p', { class: 'muted' }, fullAddress(d)));
    const box = el('div', { class: 'status-opts' });
    for (const [key, s] of Object.entries(STATUS)) {
      box.append(el('button', {
        class: 'btn' + (d.status === key ? ' cur' : ''), type: 'button',
        onclick: async () => { closeAll(); await setStatus(d, key); },
      }, `${s.icon} ${s.label}`));
    }
    m.append(box);
    if (isFinal(d) && !d.movedTo) {
      m.append(el('div', { class: 'sheet-actions' }, el('button', { class: 'btn', type: 'button', onclick: async () => { closeAll(); await setStatus(d, 'pending'); } }, '↩ בטל – חזרה לממתין')));
    }
    if (d.history?.length) {
      m.append(el('h3', {}, 'היסטוריה'), el('div', { class: 'muted' },
        d.history.slice(-30).reverse().map((h) => el('div', {}, `${fmtStamp(h.at)} · ${STATUS[h.status]?.label || (h.status === 'moved' ? 'הועבר' : h.status)}`))));
    }
  });
}

// ------------------------------------------------------------------ rendering
function sorted(list) {
  const dk = (d, mode, f) => S.dist[d.shipmentId]?.[mode]?.[f];
  const cmp = {
    updated: (a, b) => orderKey(a.updatedStop, a.updatedSub) - orderKey(b.updatedStop, b.updatedSub) || orderKey(a.initialStop, a.initialSub) - orderKey(b.initialStop, b.initialSub),
    initial: (a, b) => orderKey(a.initialStop, a.initialSub) - orderKey(b.initialStop, b.initialSub),
    smartUpdated: (a, b) => orderKey(a.smartUpdatedStop, a.smartUpdatedSub) - orderKey(b.smartUpdatedStop, b.smartUpdatedSub) || orderKey(a.smartInitialStop, a.smartInitialSub) - orderKey(b.smartInitialStop, b.smartInitialSub),
    smartInitial: (a, b) => orderKey(a.smartInitialStop, a.smartInitialSub) - orderKey(b.smartInitialStop, b.smartInitialSub),
    app: (a, b) => (a.appOrder ?? Infinity) - (b.appOrder ?? Infinity),
    drive: (a, b) => (dk(a, 'car', 't') ?? Infinity) - (dk(b, 'car', 't') ?? Infinity),
    walk: (a, b) => (dk(a, 'foot', 't') ?? Infinity) - (dk(b, 'foot', 't') ?? Infinity),
    dist: (a, b) => (dk(a, 'car', 'd') ?? S.dist[a.shipmentId]?.air ?? Infinity) - (dk(b, 'car', 'd') ?? S.dist[b.shipmentId]?.air ?? Infinity),
  }[S.sort];
  const tie = (a, b) => (a.appOrder ?? Infinity) - (b.appOrder ?? Infinity) || String(a.shipmentId).localeCompare(String(b.shipmentId));
  return list.slice().sort((a, b) => {
    const r = cmp(a, b);
    return Number.isNaN(r) || r === 0 ? tie(a, b) : r;
  });
}

function badge(cls, label, value) {
  return value == null
    ? el('span', { class: 'badge none' }, `${label} —`)
    : el('span', { class: 'badge ' + cls }, el('small', {}, label), value);
}

function geoChip(d) {
  const map = { approx: ['approx', 'מיקום משוער (רחוב)'], failed: ['failed', 'לא אותר!'], manual: ['manual', 'סומן ידנית'], pending: ['pending', 'ממתין לאיתור'] };
  const g = map[d.geoStatus || 'pending'];
  return g ? el('span', { class: 'geo ' + g[0] }, g[1]) : null;
}

function card(d) {
  const st = STATUS[d.status] || STATUS.pending;
  const fin = isFinal(d);
  const ro = readonly();
  const dist = S.dist[d.shipmentId];
  const doneCls = d.movedTo ? 'done moved' : d.status === 'no_answer_final' ? 'done fail' : 'done ok';
  const c = el('article', { class: 'card ' + (fin ? doneCls : st.cls || ''), id: 'c-' + d.shipmentId });

  c.append(el('div', { class: 'card-top' },
    badge('app', 'אפליקציה', d.appOrder != null ? '#' + d.appOrder : null),
    showSmart() || S.day?.hasSmartInitial ? badge('sinit', 'חכם ראשוני', stopLabel(d.smartInitialStop, d.smartInitialSub)) : null,
    showSmart() ? badge('supd', 'חכם מעודכן', fin ? null : stopLabel(d.smartUpdatedStop, d.smartUpdatedSub)) : null,
    showRegular() || S.day?.hasInitialRoute ? badge('init', 'ראשוני', stopLabel(d.initialStop, d.initialSub)) : null,
    showRegular() ? badge('upd', 'מעודכן', fin ? null : stopLabel(d.updatedStop, d.updatedSub)) : null,
    el('span', { class: 'ship' }, d.shipmentId),
  ));
  c.append(el('div', { class: 'name strike' }, d.name || '—'));
  c.append(el('div', { class: 'addr' }, el('span', { class: 'strike' }, fullAddress(d)), geoChip(d)));
  if (d.ref) c.append(el('div', { class: 'ref' }, `אס' 2: ${d.ref}`));

  if (!fin && dist) {
    c.append(el('div', { class: 'dist' },
      dist.car ? el('span', {}, `🚗 ${fmtDist(dist.car.d)} · ${fmtDur(dist.car.t)}`) : null,
      dist.foot ? el('span', {}, `🚶 ${fmtDist(dist.foot.d)} · ${fmtDur(dist.foot.t)}`) : null,
      !dist.car && !dist.foot ? el('span', { class: 'air' }, `✈️ ${fmtDist(dist.air)} (אווירי)`) : null,
    ));
  }
  if (d.movedTo) c.append(el('div', { class: 'status-line' }, `➡️ הועבר ל-${fmtKey(d.movedTo)}`));
  else if (d.status && d.status !== 'pending' && d.status !== 'no_answer_temp') c.append(el('div', { class: 'status-line ' + (st.cls || '') }, `${st.icon} ${st.label}${d.statusAt ? ' · ' + fmtStamp(d.statusAt) : ''}`));
  // Every "no answer – temporary" attempt, with date and time.
  const tries = (d.history || []).filter((h) => h.status === 'no_answer_temp');
  if (tries.length && !d.movedTo) {
    c.append(el('div', { class: 'status-line temp' }, `📵 לא ענה – זמני${tries.length > 1 ? ` (${tries.length} ניסיונות)` : ''}: `,
      el('span', { class: 'tries' }, tries.map((h) => fmtStamp(h.at)).join(' · '))));
  }

  const actions = el('div', { class: 'actions' });
  if (!ro && !d.movedTo) {
    if (fin) actions.append(el('button', { class: 'btn', type: 'button', onclick: () => setStatus(d, 'pending') }, '↩ בטל'));
    if (d.status === 'no_answer_temp') actions.append(el('button', { class: 'btn temp-again', type: 'button', onclick: () => setStatus(d, 'no_answer_temp') }, '📵 שוב לא ענה'));
    actions.append(el('button', { class: 'btn', type: 'button', onclick: () => statusSheet(d) }, fin ? 'שנה סטטוס' : `${st.icon} סטטוס`));
  }
  if (!fin) {
    actions.append(
      el('a', { class: 'btn waze', href: wazeUrl(d), target: '_blank', rel: 'noopener' }, 'Waze'),
      el('a', { class: 'btn gmaps', href: gmapsUrl(d), target: '_blank', rel: 'noopener' }, 'Google'),
    );
  }
  if (!ro) actions.append(el('button', { class: 'btn edit', type: 'button', title: 'עריכה', onclick: () => editSheet(d) }, '✎'));
  c.append(actions);
  return c;
}

function nextStops() {
  const act = S.deliveries.filter(isActive);
  const byRoute = act.slice().sort((a, b) => updKey(a) - updKey(b) || (a.appOrder ?? 1e9) - (b.appOrder ?? 1e9));
  const next = byRoute[0] || null;
  let nearest = null;
  if (S.me) {
    const withD = act.filter(hasCoords).map((d) => ({ d, v: S.dist[d.shipmentId]?.car?.t ?? haversine(S.me, d) / 7 }));
    withD.sort((a, b) => a.v - b.v);
    nearest = withD[0]?.d || null;
  }
  return { next, nearest };
}

function renderNext() {
  const box = $('#nextStop');
  const { next, nearest } = nextStops();
  if (!next || readonly()) { box.hidden = true; return; }
  box.hidden = false;
  box.replaceChildren(...[
    el('div', { class: 'lbl' }, `העצירה הבאה · ${showSmart() ? 'חכם ' : ''}מעודכן ${updLabel(next) ?? '—'} · ${showSmart() ? 'חכם ' : ''}ראשוני ${initLabel(next) ?? '—'}` +
      (showSmart() && showRegular() ? ` · רגיל ${stopLabel(next.updatedStop, next.updatedSub) ?? '—'}` : '')),
    el('div', { class: 'who' }, next.name || '—'),
    el('div', { class: 'where' }, fullAddress(next)),
    el('div', { class: 'info' },
      el('span', {}, el('small', {}, 'אפליקציה '), next.appOrder != null ? '#' + next.appOrder : '—'),
      el('span', {}, el('small', {}, "אס' 2 "), next.ref || '—'),
      el('span', {}, el('small', {}, 'משלוח '), next.shipmentId),
    ),
    el('div', { class: 'row' },
      el('a', { class: 'btn waze small', href: wazeUrl(next), target: '_blank', rel: 'noopener' }, 'נווט ב-Waze'),
      el('a', { class: 'btn gmaps small', href: gmapsUrl(next), target: '_blank', rel: 'noopener' }, 'Google Maps'),
      el('button', { class: 'btn small', type: 'button', onclick: () => scrollToCard(next.shipmentId) }, 'הצג'),
    ),
    nearest && nearest.shipmentId !== next.shipmentId
      ? el('div', { class: 'alt' }, `📍 הכי קרוב אליך עכשיו: ${nearest.name || ''} – ${fullAddress(nearest)} `, el('button', { class: 'btn small ghost', style: 'color:#fff;border-color:rgba(255,255,255,.4)', type: 'button', onclick: () => scrollToCard(nearest.shipmentId) }, 'הצג'))
      : null,
  ].filter(Boolean));
}

function scrollToCard(id) {
  const c = document.getElementById('c-' + id);
  if (!c) { S.hideDone = false; $('#hideDone').checked = false; render(); return scrollToCard(id); }
  c.scrollIntoView({ behavior: 'smooth', block: 'center' });
  c.classList.add('highlight');
  setTimeout(() => c.classList.remove('highlight'), 1800);
}

// Search by name, address, shipment number, ref (אס' 2) or app order. Includes completed deliveries.
function matches(d, q) {
  const raw = S.search.trim();
  if (/^#\d+$/.test(raw)) return d.appOrder === +raw.slice(1);          // "#22" → app order only
  if (/^\d{3,}$/.test(raw)) return String(d.shipmentId).includes(raw) || String(d.ref || '').includes(raw);
  if (/^\d{1,2}$/.test(raw)) return d.appOrder === +raw || String(d.houseNo) === raw;
  return norm(`${d.name} ${d.street} ${d.houseNo} ${d.city}`).includes(q) || norm(d.ref).includes(q);
}

function setSearch(v) {
  S.search = v;
  $('#searchInput').value = v;
  $('#searchClear').hidden = !v;
  render();
}

function renderCounts() {
  const all = S.deliveries;
  const act = all.filter(isActive);
  const temp = all.filter((d) => d.status === 'no_answer_temp' && !d.movedTo).length;
  const done = all.filter((d) => ['delivered_hand', 'delivered_door'].includes(d.status)).length;
  const nf = all.filter((d) => d.status === 'no_answer_final').length;
  const failed = all.filter((d) => d.geoStatus === 'failed').length;
  const pill = (t, n) => el('span', { class: 'pill' }, t, ' ', el('b', {}, n));
  $('#counts').replaceChildren(...[
    pill('סה״כ', all.length), pill('פעילים', act.length), pill('נמסרו', done),
    temp ? pill('לא ענה זמני', temp) : null, nf ? pill('לא ענה סופי', nf) : null,
    failed ? el('span', { class: 'pill', style: 'color:var(--danger)' }, `לא אותרו `, el('b', {}, failed)) : null,
  ].filter(Boolean));
  const parts = [];
  if (S.me) parts.push(`📍 מיקום עודכן ${fmtTime(S.me.at)} (±${Math.round(S.me.accuracy || 0)} מ׳)`);
  if (showSmart() && S.day?.smartDistance) parts.push(`🧠 חכם: ${fmtDist(S.day.smartDistance)} · ${fmtDur(S.day.smartDuration)}`);
  if (showRegular() && S.day?.routeDistance) parts.push(`🆓 רגיל: ${fmtDist(S.day.routeDistance)} · ${fmtDur(S.day.routeDuration)}`);
  $('#locInfo').textContent = parts.join(' · ');
}

function render() {
  if (!S.user) return;
  const ro = readonly();
  const many = S.versions.length > 1, latest = latestVersion();
  $('#readonlyBanner').hidden = !isArchive();
  $('#readonlyText').textContent = ro
    ? `צפייה ב${fmtDate(S.date, false)}${verLabel(S.version, latest, many)} – קריאה בלבד`
    : `עריכת ${fmtDate(S.date, false)}${verLabel(S.version, latest, many)}`;
  $('#goTodayBtn').textContent = S.date === S.today ? 'לגרסה האחרונה' : 'חזרה להיום';
  $('#unlockBtn').hidden = !ro;
  $('#dayBtn').textContent = '📅 ' + fmtDate(S.date) + verLabel(S.version, latest, many);
  ['#routeBtn', '#importBtn'].forEach((s) => ($(s).disabled = ro));
  $('#hideDone').checked = S.hideDone;
  $('#sortSel').value = S.sort;

  renderCounts();
  renderNext();
  const q = norm(S.search);
  const shown = S.deliveries.filter((d) => !(S.hideDone && isFinal(d)));
  const list = sorted(q ? S.deliveries.filter((d) => matches(d, q)) : shown);
  $('#list').replaceChildren(...list.map(card));
  $('#empty').hidden = S.deliveries.length > 0;
  $('#searchInfo').hidden = !q;
  $('#searchInfo').textContent = q ? (list.length ? `${list.length} תוצאות` : 'לא נמצאו תוצאות') : '';
  renderMap();
}

// ------------------------------------------------------------------ map
function ensureMap() {
  if (S.map || !window.L) return;
  S.map = L.map('map', { zoomControl: true }).setView([32.018, 34.78], 14);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(S.map);
  S.layers = { line: L.layerGroup().addTo(S.map), stops: L.layerGroup().addTo(S.map), me: L.layerGroup().addTo(S.map) };
  S.map.on('click', onMapPick);
}

function renderMap() {
  if ($('#mapWrap').hidden || !S.map) return;
  const { line, stops, me } = S.layers;
  line.clearLayers(); stops.clearLayers(); me.clearLayers();
  if (showRegular() && S.day?.routePolyline) {
    try { L.polyline(decodePolyline(S.day.routePolyline), { color: '#2563eb', weight: 4, opacity: showSmart() ? .45 : .7, dashArray: showSmart() ? '6 8' : null }).addTo(line); } catch { /* ignore */ }
  }
  if (showSmart() && S.day?.smartPolyline) {
    try { L.polyline(decodePolyline(S.day.smartPolyline), { color: '#9333ea', weight: 5, opacity: .75 }).addTo(line); } catch { /* ignore */ }
  }
  const groups = new Map();
  S.deliveries.filter(hasCoords).filter((d) => !(S.hideDone && isFinal(d))).forEach((d) => {
    const k = addressKey(d);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  });
  const bounds = [];
  for (const members of groups.values()) {
    const d = members[0];
    const act = members.filter(isActive);
    const ref = act[0] || d;
    const label = act.length ? (ref[primary().upd] ?? ref[primary().init] ?? (ref.appOrder != null ? '#' + ref.appOrder : '?')) : '✓';
    const cls = !act.length ? 'done' : act.some((x) => x.status === 'no_answer_temp') ? 'temp' : ref[primary().upd] == null ? 'nonum' : '';
    const icon = L.divIcon({ className: '', html: `<div class="stop-marker ${cls}">${esc(label)}${members.length > 1 ? '×' + members.length : ''}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
    const popup = `<div dir="rtl" style="font-family:Rubik,sans-serif"><b>${esc(fullAddress(d))}</b><br>` +
      members.map((x) => `${esc(updLabel(x) ?? '')} ${esc(x.name || x.shipmentId)} – ${esc(STATUS[x.status]?.label || '')}`).join('<br>') +
      `<br><a href="${esc(wazeUrl(d))}" target="_blank">Waze</a> · <a href="${esc(gmapsUrl(d))}" target="_blank">Google</a></div>`;
    L.marker([d.lat, d.lng], { icon }).bindPopup(popup).addTo(stops);
    bounds.push([d.lat, d.lng]);
  }
  if (S.me) {
    L.marker([S.me.lat, S.me.lng], { icon: L.divIcon({ className: '', html: '<div class="me-marker"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(me);
    bounds.push([S.me.lat, S.me.lng]);
  }
  if (!S.mapFitted && bounds.length) { S.map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 }); S.mapFitted = true; }
}

function toggleMap(show = $('#mapWrap').hidden) {
  $('#mapWrap').hidden = !show;
  $('#mapToggle').setAttribute('aria-expanded', String(show));
  $('#mapToggle .chev').textContent = show ? 'הסתר ▴' : 'הצג ▾';
  prefs.set('mapOpen', show);
  if (show) {
    ensureMap();
    setTimeout(() => { S.map?.invalidateSize(); renderMap(); }, 50);
  }
}

function startPick(d) {
  S.pickFor = d;
  toggleMap(true);
  $('#pickHint').hidden = false;
  $('#mapWrap').scrollIntoView({ behavior: 'smooth' });
  if (hasCoords(d)) S.map.setView([d.lat, d.lng], 17);
}

async function onMapPick(e) {
  if (!S.pickFor) return;
  const d = S.pickFor;
  S.pickFor = null;
  $('#pickHint').hidden = true;
  const { lat, lng } = e.latlng;
  await S.db.updateDelivery(S.key, d.shipmentId, { lat, lng, geoStatus: 'manual' });
  // Remember for next time this address shows up.
  S.db.setGeo(addressKey(d), { lat, lng, precision: 'manual', src: 'manual', at: now() }).catch(() => {});
  const same = S.deliveries.filter((x) => x.shipmentId !== d.shipmentId && addressKey(x) === addressKey(d));
  if (same.length) await S.db.updateMany(S.key, same.map((x) => ({ id: x.shipmentId, patch: { lat, lng, geoStatus: 'manual' } })));
  toast('המיקום נשמר ✓');
}

// ------------------------------------------------------------------ edit
function editSheet(d) {
  openModal((m, close) => {
    const f = {
      name: el('input', { value: d.name || '' }),
      street: el('input', { value: d.street || '' }),
      houseNo: el('input', { value: d.houseNo || '', inputmode: 'text' }),
      city: el('input', { value: d.city || S.settings.defaultCity }),
      appOrder: el('input', { value: d.appOrder ?? '', inputmode: 'numeric' }),
      ref: el('input', { value: d.ref || '' }),
    };
    const streetField = el('label', { class: 'field' }, 'רחוב (הקלד חלק מהשם)', f.street);
    m.append(
      el('h2', {}, 'עריכת משלוח ', el('span', { class: 'muted' }, d.shipmentId)),
      el('label', { class: 'field' }, 'שם', f.name),
      el('div', { class: 'row2' }, streetField, el('label', { class: 'field' }, 'מספר בית', f.houseNo)),
      el('label', { class: 'field' }, 'עיר', f.city),
      el('div', { class: 'row2' }, el('label', { class: 'field' }, "אס' 2", f.ref), el('label', { class: 'field' }, 'סדר אפליקציה', f.appOrder)),
      el('p', { class: 'muted' }, 'מצב איתור: ', geoChip(d) || el('span', { class: 'geo manual' }, 'מדויק ✓')),
      d.importSrc?.until > now()
        ? el('button', { class: 'btn small', type: 'button', onclick: () => importInfoSheet(d) }, `📷 מקור + פרטי ייבוא (עד ${fmtStamp(d.importSrc.until).slice(0, 5)})`)
        : null,
    );
    attachAutocomplete(f.street, () => f.city.value);

    const collect = () => ({
      name: f.name.value.trim(), street: f.street.value.trim(), houseNo: f.houseNo.value.trim(),
      city: f.city.value.trim() || S.settings.defaultCity,
      appOrder: f.appOrder.value.trim() === '' ? null : parseInt(f.appOrder.value.replace('#', ''), 10) || null,
      ref: f.ref.value.trim() || null,
    });
    const save = async (recheck) => {
      const data = collect();
      const addrChanged = addressKey(data) !== addressKey(d);
      closeAll();
      await S.db.updateDelivery(S.key, d.shipmentId, data);
      if (addrChanged || recheck) {
        toast('בודק כתובת…', { ms: 0 });
        const p = await geocodeDelivery({ ...d, ...data }, { force: true });
        toast(p.geoStatus === 'failed' ? 'הכתובת לא נמצאה – נסה לתקן או לסמן על המפה' : p.geoStatus === 'approx' ? 'נמצא מיקום משוער (רחוב בלבד). אפשר לסמן מדויק על המפה' : 'הכתובת אותרה ✓', { err: p.geoStatus === 'failed', ms: 5000 });
      } else toast('נשמר ✓');
    };
    m.append(el('div', { class: 'sheet-actions' },
      el('button', { class: 'btn primary', type: 'button', onclick: () => save(false) }, 'שמור'),
      el('button', { class: 'btn', type: 'button', onclick: () => save(true) }, '🔍 שמור ובדוק שוב'),
    ), el('div', { class: 'sheet-actions' },
      el('button', { class: 'btn', type: 'button', onclick: () => { closeAll(); startPick(d); } }, '📍 סמן על המפה'),
      el('button', { class: 'btn danger', type: 'button', onclick: async () => {
        if (await confirmModal({ title: 'מחיקת משלוח', body: `למחוק את ${esc(d.shipmentId)} (${esc(d.name || '')})?`, okText: 'מחק', danger: true })) {
          closeAll(); await S.db.deleteDeliveries(S.key, [d.shipmentId]); toast('נמחק');
        }
      } }, '🗑 מחק'),
    ));
  });
}

// ------------------------------------------------------------------ import
const COLS = [
  ['appOrder', 'סדר אפליקציה'], ['shipmentId', 'מספר משלוח'], ['name', 'שם'],
  ['street', 'רחוב'], ['houseNo', 'מס׳ בית'], ['city', 'עיר'], ['ref', "אס' 2"],
];

function parseImport(text) {
  // Trim spaces only – a leading TAB means the first column (app order) is empty and must stay.
  let lines = text.split(/\r?\n/).map((l) => l.replace(/^ +| +$/g, '')).filter((l) => l.trim());
  lines = lines.filter((l) => !/^\|?\s*:?-{2,}/.test(l)); // markdown separator
  const splitLine = (l) => {
    if (l.includes('\t')) return l.split('\t');
    if (l.includes('|')) return l.replace(/^\|/, '').replace(/\|$/, '').split('|');
    return l.split(/\s*,\s*/);
  };
  let rows = lines.map((l) => splitLine(l).map((c) => c.trim()));
  let map = ['appOrder', 'shipmentId', 'name', 'street', 'houseNo', 'city', 'ref'];
  const head = rows[0]?.join(' ') || '';
  if (/משלוח|רחוב|כתובת|שם/.test(head) && !/\d{6,}/.test(head)) {
    map = rows[0].map((h) => {
      if (/משלוח/.test(h)) return 'shipmentId';
      if (/סדר|אפליקציה/.test(h)) return 'appOrder';
      if (/בית/.test(h)) return 'houseNo';
      if (/רחוב/.test(h)) return 'street';
      if (/כתובת|יעד/.test(h)) return 'address';
      if (/עיר|ישוב|יישוב/.test(h)) return 'city';
      if (/אס|אסמכתא|חבילה|ref/i.test(h)) return 'ref';
      if (/שם|לקוח/.test(h)) return 'name';
      return null;
    });
    rows = rows.slice(1);
  }
  return rows.map((cells) => {
    const iShip = map.indexOf('shipmentId'), iApp = map.indexOf('appOrder');
    if (iApp === 0 && iShip === 1 && /^\d{6,}$/.test((cells[0] || '').trim()) && !/^\d{6,}$/.test((cells[1] || '').trim())) cells = ['', ...cells];
    const r = {};
    map.forEach((k, i) => { if (k) r[k] = (cells[i] ?? '').trim(); });
    if (r.address) {
      let a = r.address.replace(/^חולון\s+/, (m) => { r.city ||= 'חולון'; return ''; });
      const parts = a.split(',');
      if (parts[1]) r.city ||= parts[1].trim();
      Object.assign(r, splitAddress(parts[0]));
      delete r.address;
    }
    const clean = (v) => (v == null || /^[-—–]*$/.test(v) || /^\(.*\)$/.test(v) ? '' : v);
    return {
      appOrder: clean(r.appOrder).replace('#', ''),
      shipmentId: clean(r.shipmentId).replace(/\s/g, ''),
      name: clean(r.name), street: clean(r.street), houseNo: clean(r.houseNo),
      city: clean(r.city) || S.settings.defaultCity, ref: clean(r.ref),
    };
  });
}

const CLAUDE_PROMPT = `אתה ממיר צילומי מסך מאפליקציית משלוחים לטבלה לייבוא ל-SmartRun.

פלט: בלוק קוד אחד בלבד, טבלה מופרדת בטאבים (TSV), 7 עמודות בכל שורה – בלי הסברים לפני הבלוק.
שורת כותרת בדיוק:
סדר אפליקציה	מספר משלוח	שם	רחוב	מספר בית	עיר	אס 2

איך קוראים כל כרטיס בצילום:
- "מסירה <שם>" → שם = הטקסט אחרי המילה "מסירה" (בלי המילה "מסירה"). לשמור בדיוק כפי שכתוב, עברית או אנגלית.
- המספר הארוך ליד אייקון המשאית (למשל 19828497) → מספר משלוח.
- שורת "יעד", למשל "#14 יעד: חולון שנקר 72":
  • סדר אפליקציה = המספר שאחרי # (כאן 14). אם אין # (למשל כוכבית *) → 0.
  • עיר = המילה הראשונה אחרי "יעד:" (חולון).
  • מספר בית = המספר בסוף השורה, כולל אות אם יש (12א).
  • רחוב = כל מה שבין העיר למספר הבית (למשל "הגדוד העברי", "ז'בוטינסקי") – עם הגרש/המקף כפי שמופיע.
- "אס' 2: <ערך>" → אס 2. אם אין שורה כזו → 0.

כללים:
- אף תא לא נשאר ריק. במקום ריק כותבים 0.
- בלי טאבים או ירידות שורה בתוך תא.
- שורה אחת לכל מספר משלוח. צילומים חופפים – לא לשכפל אותו מספר משלוח.
- שני משלוחים לאותה כתובת (אותו אדם או לא) = שתי שורות נפרדות.
- סדר השורות: כפי שמופיעים בצילומים, מלמעלה למטה.
- אם פרט לא קריא – לנחש הכי סביר ולציין אותו בדוח.

אחרי הבלוק, דוח קצר (3–5 שורות):
- כמה שורות בטבלה, ומה המספר שמופיע למעלה באפליקציה ("36 מסירות" / "הכל") – האם זה תואם.
- אילו מספרי # חסרים ברצף (לפי הגבוה ביותר שנראה).
- כמה שורות עם 0 בסדר אפליקציה.
- פרטים לא ודאיים (מספר משלוח + מה לא ברור).`;
// 📥 Import: two ways in – pasted text (as always) or screenshots read by Claude. Both end in previewSheet.
function importSheet() {
  openModal((m, close) => {
    const bar = el('div', { class: 'tabs', role: 'tablist' });
    const body = el('div');
    const show = (tab) => {
      prefs.set('importTab', tab);
      [...bar.children].forEach((b) => b.classList.toggle('cur', b.dataset.tab === tab));
      body.replaceChildren(tab === 'photos' ? photoPane() : textPane(close));
      body.querySelector('textarea')?.focus();
    };
    [['text', '📋 טקסט'], ['photos', '📷 צילומים']].forEach(([tab, label]) =>
      bar.append(el('button', { class: 'tab', type: 'button', role: 'tab', dataset: { tab }, onclick: () => show(tab) }, label)));
    m.append(el('h2', {}, '📥 ייבוא משלוחים'), bar, body);
    show(prefs.get('importTab', 'text') === 'photos' ? 'photos' : 'text');
  });
}

function textPane(close) {
  const ta = el('textarea', { placeholder: 'הדבק כאן את הטבלה (שורה לכל משלוח, עמודות מופרדות בטאב)…\nסדר אפליקציה | מספר משלוח | שם | רחוב | מס׳ בית | עיר | אס׳ 2' });
  return el('div', {},
    el('p', { class: 'muted' }, 'הדבק את הטבלה שקיבלת מ-Claude (או מ-Excel). אפשר גם עמודת "כתובת" אחת במקום רחוב + מספר. 0 = אין סדר אפליקציה.'),
    el('button', { class: 'btn small', type: 'button', onclick: async () => {
      try { await navigator.clipboard.writeText(CLAUDE_PROMPT); toast('ההוראות הועתקו – הדבק אותן ב-Claude יחד עם הצילומים ✓'); }
      catch { ta.value = CLAUDE_PROMPT; ta.select(); toast('סמן והעתק את ההוראות מהתיבה', { ms: 4000 }); }
    } }, '📋 העתק הוראות ל-Claude'),
    el('label', { class: 'field' }, 'נתונים', ta),
    el('div', { class: 'sheet-actions' },
      el('button', { class: 'btn primary', type: 'button', onclick: () => { const rows = parseImport(ta.value); if (!rows.length) return toast('לא נמצאו שורות', { err: true }); previewSheet(rows); } }, 'הצג תצוגה מקדימה ←'),
      el('button', { class: 'btn', type: 'button', onclick: close }, 'ביטול'),
    ),
  );
}

function photoPane() {
  const picked = [];                                   // [{ file, thumb }] in table order
  const input = el('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const list = el('div', { class: 'thumbs' });
  const mode = el('select', {}, Object.entries(READ_MODES).map(([v, label]) => el('option', { value: v }, label)));
  mode.value = S.settings.readMode || 'auto';
  const dbl = el('input', { type: 'checkbox' });
  const est = el('p', { class: 'muted' });
  const status = el('p', { class: 'muted' });
  const go = el('button', { class: 'btn primary', type: 'button' }, '📷 קרא צילומים ←');

  const move = (i, by) => { const [f] = picked.splice(i, 1); picked.splice(i + by, 0, f); draw(); };
  const draw = () => {
    list.replaceChildren(...picked.map((f, i) => el('div', { class: 'thumb' },
      el('img', { src: f.thumb, alt: '' }),
      el('div', { class: 'thumb-name' }, `${i + 1}. ${f.file.name}`),
      el('div', { class: 'thumb-btns' },
        el('button', { class: 'btn small', type: 'button', title: 'למעלה', disabled: i === 0, onclick: () => move(i, -1) }, '▲'),
        el('button', { class: 'btn small', type: 'button', title: 'למטה', disabled: i === picked.length - 1, onclick: () => move(i, 1) }, '▼'),
        el('button', { class: 'btn small', type: 'button', title: 'הסר', onclick: () => { URL.revokeObjectURL(f.thumb); picked.splice(i, 1); draw(); } }, '✕')))));
    const per = dbl.checked ? PER_SHOT.double : PER_SHOT[mode.value];
    est.textContent = picked.length
      ? `${picked.length} צילומים · עלות משוערת ~$${(picked.length * per).toFixed(2)} · הסדר כאן = הסדר בטבלה`
      : 'בחר את צילומי המסך מהגלריה – אפשר כמה ביחד.';
    go.disabled = !picked.length;
  };
  input.addEventListener('change', () => {
    [...input.files].forEach((file) => picked.push({ file, thumb: URL.createObjectURL(file) }));
    input.value = '';
    draw();
  });
  mode.addEventListener('change', draw);
  dbl.addEventListener('change', async () => {
    if (dbl.checked && !(await confirmModal({
      title: '🔁 קריאה כפולה',
      body: 'כל צילום ייקרא ע״י <b>שני מודלים (Sonnet + Opus)</b> וכל הבדל ביניהם יסומן בצהוב.<br>זה לוקח יותר זמן ועולה בערך פי 3 (~$0.06 לצילום במקום ~$0.02).<br>מומלץ כשמסך האפליקציה השתנה או כשהצילומים לא חדים.',
      okText: 'הפעל קריאה כפולה',
    }))) dbl.checked = false;
    draw();
  });
  go.addEventListener('click', async () => {
    go.disabled = true;
    const progress = (t) => { status.textContent = t; toast(t, { ms: 0 }); };
    try { await runPhotoImport(picked.map((f) => f.file), { mode: mode.value, double: dbl.checked }, progress); }
    catch (e) { console.error(e); toast(errText(e), { err: true, ms: 8000 }); }
    finally { go.disabled = !picked.length; status.textContent = ''; }
  });
  draw();
  return el('div', {},
    el('p', { class: 'muted' }, 'Claude קורא את צילומי המסך מאפליקציית המשלוחים ובונה את אותה טבלה. כל צילום נקרא בנפרד, ושדות לא ודאיים מסומנים בצהוב עם קישור לצילום.'),
    el('button', { class: 'btn', type: 'button', onclick: () => input.click() }, '🖼️ בחר צילומים'), input,
    list, est,
    el('label', { class: 'field' }, 'אופן קריאה', mode),
    el('label', { class: 'switch', style: 'margin-top:10px' }, dbl, el('span', {}, '🔁 קריאה כפולה (Sonnet + Opus) – להצלבה')),
    status,
    el('div', { class: 'sheet-actions' }, go),
  );
}

// ------------------------------------------------------------------ import: checks (text + screenshots)
const FIELDS = COLS.map(([k]) => k);
const FIELD_LABEL = Object.fromEntries(COLS);
const HEBREW = /[֐-׿]/;
const idShape = (id) => String(id).replace(/[0-9]/g, '9').replace(/[A-Za-z]/g, 'A');
const errText = (e) => e?.message || String(e);

// The usual shipment-number pattern of this batch (e.g. "99999999"), when most numbers share it.
function commonIdShape(ids) {
  const shapes = ids.filter(Boolean).map(idShape);
  if (shapes.length < 3) return null;
  const counts = new Map();
  shapes.forEach((s) => counts.set(s, (counts.get(s) || 0) + 1));
  const [shape, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
  return n / shapes.length >= 0.6 ? shape : null;
}

// Shipment numbers may contain letters. Only an empty number stops the import ('stop');
// 'bad' = red, probably mixed-up columns (asks once on confirm); 'warn' = yellow, unusual.
function shipmentIssue(id, shape) {
  const v = String(id || '').trim();
  if (!v) return { level: 'stop', msg: 'חסר מספר משלוח – חובה למלא' };
  if (HEBREW.test(v) || /\s/.test(v)) return { level: 'bad', msg: 'עברית/רווח במספר משלוח – עמודות מעורבבות?' };
  if (!/^[A-Za-z0-9-]{4,20}$/.test(v)) return { level: 'warn', msg: 'מספר משלוח בפורמט חריג' };
  if (shape && idShape(v) !== shape) return { level: 'warn', msg: 'פורמט שונה משאר מספרי המשלוח' };
  return null;
}

function editDistance(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return d[b.length];
}

// Street not in the city's official list → yellow, with the closest official name as a suggestion.
function streetIssue(street, list) {
  if (!street || !list?.length) return null;
  const n = norm(street);
  if (list.some((s) => norm(s) === n)) return null;
  let best = null, bestD = Infinity;
  for (const s of list) { const dd = editDistance(n, norm(s)); if (dd < bestD) { bestD = dd; best = s; } }
  const suggestion = bestD <= Math.max(2, Math.round(n.length / 3)) ? best : maps.streetSuggest(list, street, 1)[0] || null;
  return { level: 'warn', msg: 'הרחוב לא ברשימה הרשמית' + (suggestion ? ` – אולי "${suggestion}"?` : ''), suggestion };
}

// Per-field flags of a preview row: { field: [{ level, msg, suggestion? }] }.
// Model flags (uncertain / conflicting reads) disappear once the cell is edited or accepted.
function rowFlags(r, ctx) {
  const f = {};
  const add = (k, x) => (f[k] ||= []).push(x);
  const si = shipmentIssue(r.shipmentId, ctx.shape);
  if (si) add('shipmentId', si);
  if (ctx.photo) {
    const st = streetIssue(r.street, ctx.streets[r.city || S.settings.defaultCity]);
    if (st) add('street', st);
    const ni = ctx.names && nameIssue(r.name, ctx.names);
    if (ni) add('name', ni);
    const untouched = (k) => String(r[k] ?? '') === String(r.orig?.[k] ?? '');
    (r.uncertain || []).forEach((k) => untouched(k) && add(k, { level: 'warn', msg: 'Claude לא בטוח בקריאה' }));
    Object.entries(r.conflicts || {}).forEach(([k, vals]) => untouched(k) && add(k, { level: 'warn', msg: `קריאות שונות: ${vals.map((v) => v || '(ריק)').join(' / ')}` }));
  }
  (r.accepted || []).forEach((k) => { if (f[k]) f[k] = f[k].filter((x) => x.level === 'stop'); });
  Object.keys(f).forEach((k) => { if (!f[k].length) delete f[k]; });
  return f;
}
const worstLevel = (list) => (list.some((x) => x.level !== 'warn') ? 'bad' : 'warn');
const isEdited = (r) => !!r.orig && FIELDS.some((k) => String(r[k] ?? '') !== String(r.orig[k] ?? ''));

async function checkContext(rows, photo) {
  const ctx = { photo, shape: commonIdShape(rows.map((r) => r.shipmentId)), streets: {} };
  if (photo) {
    const cities = [...new Set(rows.map((r) => r.city || S.settings.defaultCity))];
    await Promise.all([
      ...cities.map(async (c) => { ctx.streets[c] = await ensureStreets(c); }),
      knownNames().then((n) => { ctx.names = n; }),
    ]);
  }
  return ctx;
}

// Known name words: the starter list + names learned from earlier confirmed imports (meta/names).
let learnedNames = null;
async function knownNames() {
  learnedNames ||= S.db.getMeta('names').then((m) => Object.keys(m?.words || {})).catch(() => []);
  return new Set([...STARTER_NAMES, ...(await learnedNames)]);
}
// After an import: learn the names nobody doubted, plus the ones the user fixed or accepted.
function learnNames(rows) {
  const words = {};
  rows.forEach((r) => { if (!r.flags?.name?.length) nameWords(r.name).forEach((w) => { words[w] = 1; }); });
  if (!Object.keys(words).length) return;
  learnedNames = null;
  S.db.setMeta('names', { words }).catch((e) => console.warn('learn names', e));
}

// Missing app-order numbers (#), with the screenshots on both sides of each gap.
function gapIssues(rows) {
  const at = new Map();
  rows.forEach((r) => { const n = parseInt(r.appOrder, 10); if (n > 0 && !at.has(n)) at.set(n, r.src?.photo ?? null); });
  if (!at.size) return [];
  const max = Math.max(...at.keys());
  const out = [];
  for (let k = 1; k <= max; k++) {
    if (at.has(k)) continue;
    let e = k;
    while (!at.has(e + 1)) e++;
    out.push({ from: k, to: e, lo: k > 1 ? k - 1 : null, hi: e + 1, pl: k > 1 ? at.get(k - 1) : null, ph: at.get(e + 1) });
    k = e;
  }
  return out;
}
function gapText(g) {
  const what = g.from === g.to ? `#${g.from}` : `#${g.from}–#${g.to}`;
  if (g.lo == null) return `חסר ${what} – לפני #${g.hi} (צילום ${g.ph}). אולי תחילת הרשימה לא צולמה`;
  if (g.pl === g.ph) return `חסר ${what} – בתוך צילום ${g.pl} (בין #${g.lo} ל-#${g.hi}). אולי # נקרא לא נכון`;
  return `חסר ${what} – צילום ${g.pl} מסתיים ב-#${g.lo} וצילום ${g.ph} מתחיל ב-#${g.hi}. כנראה לא צולם`;
}

// ------------------------------------------------------------------ import from screenshots (Claude Vision)
const READ_MODES = { auto: '🧠 אוטומטי – Sonnet + בדיקת זום לשמות ולכתובות ב-Opus', sonnet: '⚡ Sonnet בלבד (זול)', opus: '🎯 Opus בלבד (הכי מדויק)' };
const MODEL_LABEL = { sonnet: 'Sonnet', opus: 'Opus', zoom: 'Opus 🔍 זום' };
const READ_PRICE = { sonnet: [2, 10], opus: [4, 20] };           // $ per million tokens: input, output
const PER_SHOT = { auto: 0.03, sonnet: 0.02, opus: 0.04, double: 0.06 };
const IMPORT_TTL = 14 * 86400000;
const MAX_SIDE = 2576, MAX_UPLOAD = 5 * 1024 * 1024;

// Full resolution for the model (up to 2576px on the long edge). A screenshot that already fits is sent
// as is (no second JPEG compression); a larger one is scaled down and saved as JPEG 0.92.
async function prepareImage(file) {
  const bmp = await createImageBitmap(file);
  if (['image/jpeg', 'image/png'].includes(file.type) && file.size <= MAX_UPLOAD && Math.max(bmp.width, bmp.height) <= MAX_SIDE) {
    bmp.close?.();
    return file;
  }
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const c = el('canvas', { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('המרת התמונה נכשלה'))), 'image/jpeg', 0.92));
}

// Run fn over items, at most n at a time.
async function pool(items, n, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

async function readPhoto(p, model) {
  if (p.reads[model]) return p.reads[model];
  const r = await S.db.extract({ path: p.path, model });
  p.reads[model] = r;
  S.db.incUsage('extract_' + model).catch(() => {});
  if (r.usage) {
    S.db.incUsage('extractIn_' + model, r.usage.input || 0).catch(() => {});
    S.db.incUsage('extractOut_' + model, r.usage.output || 0).catch(() => {});
  }
  return r;
}

// Zoom check (automatic mode): the name + destination lines of every full card, cropped from the screenshot
// and read again by Opus in one request. Every difference from the first read is marked in yellow.
const ZOOM_FIELDS = ['name', 'city', 'street', 'houseNo'];
const ZOOM_BOX = { left: 0.26, above: 0.012, part: 0.7 };   // card text column; top of the card to ~70% of its height

async function zoomStrips(blob, cards) {
  const bmp = await createImageBitmap(blob);
  const W = bmp.width, H = bmp.height;
  const strips = [];
  for (const [i, c] of cards.entries()) {
    if (c.partial || !c.hPct || !cardKey(c.shipmentId)) continue;
    const y0 = Math.max(0, Math.round((c.yPct / 100 - ZOOM_BOX.above) * H));
    const y1 = Math.min(H, Math.round(((c.yPct + c.hPct * ZOOM_BOX.part) / 100 + ZOOM_BOX.above) * H));
    const x0 = Math.round(W * ZOOM_BOX.left);
    if (y1 - y0 < 20) continue;
    const cv = el('canvas', { width: W - x0, height: y1 - y0 });
    cv.getContext('2d').drawImage(bmp, x0, y0, W - x0, y1 - y0, 0, 0, W - x0, y1 - y0);
    const b = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.95));
    const data = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(b); });
    strips.push({ i, key: cardKey(c.shipmentId), data });
  }
  bmp.close?.();
  return strips;
}

async function zoomPhoto(p) {
  if (p.reads.zoom || !p.reads.sonnet?.cards?.length) return;
  const strips = await zoomStrips(p.blob || p.file, p.reads.sonnet.cards);
  if (!strips.length) { p.reads.zoom = { byKey: {} }; return; }
  const r = await S.db.extract({ kind: 'zoom', model: 'opus', strips: strips.map(({ i, data }) => ({ i, data })) });
  const keyOf = new Map(strips.map((s) => [s.i, s.key]));
  p.reads.zoom = { byKey: Object.fromEntries(r.cards.filter((c) => !c.unreadable && keyOf.has(c.i)).map((c) => [keyOf.get(c.i), c])) };
  S.db.incUsage('extract_zoom').catch(() => {});
  if (r.usage) {
    S.db.incUsage('extractIn_opus', r.usage.input || 0).catch(() => {});
    S.db.incUsage('extractOut_opus', r.usage.output || 0).catch(() => {});
  }
}

// Prepare, upload and read screenshots – one request per screenshot, 3 in parallel.
// Automatic mode: Sonnet reads, Opus zoom-checks the names and addresses of every screenshot;
// a full second read by Opus only for structural problems (a card without a shipment number, a gap inside one screenshot).
async function readPhotos(sess, list, progress) {
  const models = sess.mode === 'opus' ? ['opus'] : sess.double ? ['sonnet', 'opus'] : ['sonnet'];
  const zoom = sess.mode === 'auto' && !sess.double;
  let done = 0;
  progress(`מכין ${list.length} צילומים…`);
  await pool(list, 3, async (p) => {
    try {
      if (!p.path) {
        p.blob = await prepareImage(p.file);
        p.url = URL.createObjectURL(p.blob);
        p.path = await S.db.uploadImportPhoto(sess.id, p.n, p.blob);
      }
      await Promise.all(models.map((mdl) => readPhoto(p, mdl)));
      p.error = null;
    } catch (e) {
      console.warn('read photo', p.n, e);
      p.error = errText(e);
    }
    if (zoom && !p.error) {
      progress(`בודק שמות וכתובות בזום ${done + 1}/${list.length}…`);
      try { await zoomPhoto(p); p.zoomError = null; } catch (e) { console.warn('zoom photo', p.n, e); p.zoomError = errText(e); }
    }
    progress(`קורא צילומים ${++done}/${list.length}…`);
  });
  if (!zoom) return;

  const rows = buildRows(sess);
  const ctx = await checkContext(rows, true);
  const suspect = new Set();
  const NUM_FIELDS = ['shipmentId', 'appOrder', 'ref'];
  rows.forEach((r) => {
    if (r.src.partial) return;
    const flags = rowFlags(r, ctx);
    const numbers = NUM_FIELDS.some((k) => flags[k]?.length);
    // Zoom failed for this screenshot → fall back to the old rule (any flag → Opus).
    const zoomMissing = r.src.photos.some((n) => sess.photos.find((q) => q.n === n)?.zoomError);
    if (numbers || (zoomMissing && Object.keys(flags).length)) r.src.photos.forEach((n) => suspect.add(n));
  });
  // Gaps in # stay a yellow note in the preview – the delivery app often skips numbers, so they don't trigger a re-read.
  const again = sess.photos.filter((p) => suspect.has(p.n) && p.path && !p.reads.opus);
  done = 0;
  await pool(again, 3, async (p) => {
    try { await readPhoto(p, 'opus'); } catch (e) { console.warn('opus re-read', p.n, e); }
    progress(`בודק שוב ב-Opus ${++done}/${again.length}…`);
  });
}

const cardKey = (id) => String(id || '').replace(/\s/g, '').toUpperCase();
const sameVal = (k, a, b) => (k === 'shipmentId' ? cardKey(a) === cardKey(b) : k === 'appOrder' ? (+a || 0) === (+b || 0) : norm(a) === norm(b));
function cardValues(c) {
  return {
    appOrder: +c.appOrder > 0 ? String(c.appOrder) : '',
    shipmentId: String(c.shipmentId || '').replace(/\s/g, ''),
    name: c.name || '', street: c.street || '', houseNo: c.houseNo || '',
    city: c.city || S.settings.defaultCity,
    ref: c.ref && c.ref !== '0' ? c.ref : '',
  };
}

// Pair every card of `base` with the same card read by the other model (same screenshot).
function alignCards(base, other) {
  if (!other) return { pairs: base.map(() => null), extra: [] };
  if (other.length === base.length) return { pairs: other.slice(), extra: [] };
  const left = new Set(other.map((_, i) => i));
  const pairs = base.map((c) => {
    const j = [...left].find((i) => cardKey(c.shipmentId) && cardKey(other[i].shipmentId) === cardKey(c.shipmentId))
      ?? [...left].find((i) => c.appOrder > 0 && other[i].appOrder === c.appOrder);
    if (j == null) return null;
    left.delete(j);
    return other[j];
  });
  return { pairs, extra: [...left].map((i) => other[i]) };
}

// The cards of one screenshot. When both models read it, Opus wins and every difference is kept.
function photoCards(p) {
  const o = p.reads.opus?.cards, s = p.reads.sonnet?.cards;
  const base = o || s || [], other = o && s ? s : null;
  const top = o ? 'opus' : 'sonnet';
  const { pairs, extra } = alignCards(base, other);
  const out = base.map((c, i) => {
    const alt = pairs[i], v = cardValues(c);
    const reads = [{ model: top, ...v }];
    const conflicts = {};
    if (alt) {
      const av = cardValues(alt);
      reads.push({ model: 'sonnet', ...av });
      FIELDS.forEach((k) => { if (!sameVal(k, v[k], av[k])) conflicts[k] = [v[k], av[k]]; });
    }
    // Zoom check: Opus read the name + destination lines of this card again, enlarged.
    const z = p.reads.zoom?.byKey?.[cardKey(v.shipmentId)];
    if (z) {
      const zv = { ...v, ...Object.fromEntries(ZOOM_FIELDS.map((k) => [k, k === 'city' ? z.city || v.city : z[k]])) };
      reads.push({ model: 'zoom', ...zv });
      ZOOM_FIELDS.forEach((k) => {
        if (sameVal(k, v[k], zv[k])) return;
        conflicts[k] = [...new Set([...(conflicts[k] || [v[k]]), zv[k]])];
      });
    }
    return { c, reads, conflicts, uncertain: c.uncertain || [], notes: other && !alt ? ['נקרא רק ע״י Opus'] : [] };
  });
  extra.forEach((c) => out.push({ c, reads: [{ model: 'sonnet', ...cardValues(c) }], conflicts: {}, uncertain: [], notes: ['נקרא רק ע״י Sonnet'] }));
  return out.sort((a, b) => a.c.yPct - b.c.yPct);
}

// Rows in screenshot order (1 top→bottom, then 2 …). A card seen in two overlapping screenshots is one
// row; the second reading confirms it or marks the differences.
function buildRows(sess) {
  const rows = [], byId = new Map();
  for (const p of sess.photos) {
    if (!p.reads.sonnet && !p.reads.opus) continue;
    photoCards(p).forEach((pc, pos) => {
      const v = cardValues(pc.c);
      const at = { yPct: pc.c.yPct, hPct: pc.c.hPct };
      const reads = pc.reads.map((x) => ({ ...x, photo: p.n }));
      const key = cardKey(v.shipmentId);
      const ex = key && byId.get(key);
      if (!ex) {
        const row = {
          ...v, orig: { ...v }, reads, uncertain: [...pc.uncertain], conflicts: { ...pc.conflicts }, notes: [...pc.notes], accepted: [],
          src: { photo: p.n, photos: [p.n], name: p.name, pos, at: { [p.n]: at }, partial: !!pc.c.partial },
          addedLater: p.n > sess.baseCount,
        };
        rows.push(row);
        if (key) byId.set(key, row);
        return;
      }
      ex.src.photos.push(p.n);
      ex.src.at[p.n] = at;
      ex.reads.push(...reads);
      ex.addedLater &&= p.n > sess.baseCount;
      if (ex.src.partial && !pc.c.partial) {
        // The first sighting was cut at the screenshot edge – the full card wins.
        FIELDS.forEach((k) => { if (v[k]) { ex[k] = v[k]; ex.orig[k] = v[k]; } });
        Object.assign(ex, { uncertain: [...pc.uncertain], conflicts: { ...pc.conflicts } });
        Object.assign(ex.src, { photo: p.n, name: p.name, pos, partial: false });
        return;
      }
      FIELDS.forEach((k) => {
        if (!v[k] || sameVal(k, ex[k], v[k])) return;
        if (!ex[k]) { ex[k] = v[k]; ex.orig[k] = v[k]; return; }
        ex.conflicts[k] = [...new Set([...(ex.conflicts[k] || [ex[k]]), v[k]])];
      });
      // Still uncertain only if the second sighting is unsure too.
      ex.uncertain = ex.uncertain.filter((k) => pc.uncertain.includes(k));
    });
  }
  // Rows that exist only in screenshots added later (➕) go where their # belongs.
  rows.filter((r) => r.addedLater && +r.appOrder > 0).forEach((r) => {
    rows.splice(rows.indexOf(r), 1);
    let at = -1;
    rows.forEach((x, i) => { if (+x.appOrder > 0 && +x.appOrder < +r.appOrder) at = i; });
    rows.splice(at + 1, 0, r);
  });
  return rows;
}

async function runPhotoImport(files, { mode, double }, progress) {
  const sess = {
    id: `imp-${Date.now().toString(36)}`, mode, double, baseCount: files.length, ignoredGaps: [],
    photos: files.map((file, i) => ({ n: i + 1, name: file.name, file, reads: {} })),
  };
  await readPhotos(sess, sess.photos, progress);
  if (!sess.photos.some((p) => p.reads.sonnet || p.reads.opus)) throw new Error('אף צילום לא נקרא: ' + (sess.photos.find((p) => p.error)?.error || ''));
  await openPhotoPreview(sess);
  $('#toast').hidden = true;
}

async function openPhotoPreview(sess, carry = null) {
  const rows = buildRows(sess);
  if (carry) {
    // Keep what was already fixed in the table before more screenshots were added.
    rows.forEach((r) => {
      const c = carry.get(cardKey(r.orig.shipmentId));
      if (c) { Object.assign(r, c.vals); r.accepted = c.accepted; r.checked = c.checked; }
    });
  }
  previewSheet(rows, { sess, ctx: await checkContext(rows, true) });
}

// Screenshots, scrolled to the card and highlighted. `top(close)` may add an editor above them.
function shotSheet({ title, shots, top = null }) {
  openModal((m, close) => {
    m.append(el('h2', {}, title));
    if (top) m.append(top(close));
    const wrap = el('div', { class: 'shots' + (shots.length > 1 ? ' two' : '') });
    shots.forEach((s) => {
      const img = el('img', { alt: `צילום ${s.n}` });
      const scroll = el('div', { class: 'shot-scroll' }, el('div', { class: 'shot-frame' }, img,
        s.yPct != null ? el('div', { class: 'shot-mark', style: `top:${s.yPct}%;height:${Math.max(4, s.hPct || 12)}%` }) : null));
      const box = el('div', { class: 'shot' }, el('div', { class: 'shot-cap' }, `📷 צילום ${s.n}${s.name ? ' · ' + s.name : ''}`), scroll);
      img.addEventListener('load', () => { scroll.scrollTop = Math.max(0, img.clientHeight * (s.yPct || 0) / 100 - scroll.clientHeight / 3); });
      Promise.resolve(s.url || s.getUrl?.()).then((u) => {
        if (u) img.src = u;
        else box.append(el('p', { class: 'muted' }, 'הצילום כבר לא זמין (נמחק אחרי 14 יום).'));
      });
      wrap.append(box);
    });
    m.append(wrap, el('div', { class: 'sheet-actions' }, el('button', { class: 'btn', type: 'button', onclick: close }, 'סגור')));
  });
}

const rowShots = (sess, r) => r.src.photos.map((n) => {
  const p = sess.photos.find((q) => q.n === n);
  return { n, name: p?.name, url: p?.url, ...r.src.at[n] };
});

// Fix one flagged cell next to its screenshot.
function fixCellSheet(sess, x, field, done) {
  const r = x.r;
  shotSheet({
    title: `${FIELD_LABEL[field]} · שורה ${x.index + 1}${r.appOrder ? ` (#${r.appOrder})` : ''}`,
    shots: rowShots(sess, r),
    top: (close) => {
      const input = el('input', { value: r[field] ?? '', dir: field === 'shipmentId' ? 'ltr' : null });
      const flags = r.flags?.[field] || [];
      const options = [...new Set([...(r.conflicts?.[field] || []), ...flags.map((f) => f.suggestion)].filter(Boolean))];
      const box = el('div', { class: 'fix-box' },
        flags.map((f) => el('div', { class: 'fix-msg ' + (f.level === 'warn' ? 'warn' : 'bad') }, (f.level === 'warn' ? '🟡 ' : '🔴 ') + f.msg)),
        el('label', { class: 'field' }, 'הערך בטבלה', input),
        options.length ? el('div', { class: 'chips' }, options.map((v) => el('button', { class: 'btn small', type: 'button', onclick: () => { input.value = v; } }, v))) : null,
        el('div', { class: 'sheet-actions' },
          el('button', { class: 'btn primary', type: 'button', onclick: () => {
            const v = input.value.trim();
            if (v === String(r[field] ?? '')) r.accepted = [...new Set([...r.accepted || [], field])];
            r[field] = v;
            x.tds[field].textContent = v;
            close(); done();
          } }, 'שמור'),
          el('button', { class: 'btn', type: 'button', onclick: () => { r.accepted = [...new Set([...r.accepted || [], field])]; close(); done(); } }, '✓ נכון כפי שהוא')));
      if (field === 'street') attachAutocomplete(input, () => r.city);
      return box;
    },
  });
}

// ⓘ What each model read, why it was flagged, and before → after (with restore).
function rowInfoSheet({ title, sub = '', reads = [], orig = {}, cur = {}, flags = [], notes = [], shots = [], onRestore = null }) {
  openModal((m, close) => {
    const cols = reads.map((x) => `${MODEL_LABEL[x.model] || x.model} · 📷${x.photo}`);
    const tbody = el('tbody');
    FIELDS.forEach((k) => {
      const vals = reads.map((x) => x[k] ?? '');
      const differ = new Set(vals.map((v) => (k === 'appOrder' ? +v || 0 : norm(v)))).size > 1;
      const changed = String(cur[k] ?? '') !== String(orig[k] ?? '');
      tbody.append(el('tr', { class: differ ? 'differ' : '' },
        el('th', {}, FIELD_LABEL[k]),
        ...vals.map((v) => el('td', {}, v || '—')),
        el('td', { class: changed ? 'changed' : '' }, changed ? `${orig[k] || '—'} ← ${cur[k] || '—'}` : cur[k] || '—'),
        el('td', {}, changed && onRestore ? el('button', { class: 'btn small', type: 'button', onclick: () => { onRestore(k); close(); } }, '↩ שחזר') : null)));
    });
    m.append(...[
      el('h2', {}, title),
      sub ? el('p', { class: 'muted' }, sub) : null,
      flags.length || notes.length
        ? el('div', { class: 'fix-box' }, notes.map((t) => el('div', { class: 'fix-msg warn' }, '🟡 ' + t)),
          flags.map((f) => el('div', { class: 'fix-msg ' + (f.level === 'warn' ? 'warn' : 'bad') }, `${f.level === 'warn' ? '🟡' : '🔴'} ${FIELD_LABEL[f.field] || ''}: ${f.msg}`)))
        : null,
      el('div', { class: 'tbl-wrap' }, el('table', { class: 'preview info' },
        el('thead', {}, el('tr', {}, el('th', {}, 'שדה'), ...cols.map((c) => el('th', {}, c)), el('th', {}, 'בטבלה (לפני ← אחרי)'), el('th', {}, ''))), tbody)),
      el('div', { class: 'sheet-actions' },
        shots.length ? el('button', { class: 'btn', type: 'button', onclick: () => shotSheet({ title: title + ' · צילום מקורי', shots }) }, '📷 צילום מקורי') : null,
        el('button', { class: 'btn', type: 'button', onclick: close }, 'סגור')),
    ].filter(Boolean));
  });
}
const flagList = (flags) => Object.entries(flags || {}).flatMap(([field, list]) => list.map((f) => ({ field, level: f.level, msg: f.msg })));

// After import: the source screenshot + import details, kept for 14 days.
async function importInfoSheet(d) {
  const rec = await S.db.getImport(d.importSrc.importId).catch(() => null);
  const row = rec?.rows?.find((x) => String(x.shipmentId) === String(d.shipmentId));
  if (!row) return toast('פרטי הייבוא כבר לא זמינים', { err: true });
  const shots = (row.src?.photos || []).map((n) => {
    const p = rec.photos?.find((q) => q.n === n);
    return { n, name: p?.name, getUrl: () => (p ? S.db.photoUrl(p.path).catch(() => null) : null), ...(row.src.at?.[n] || {}) };
  });
  rowInfoSheet({
    title: `ⓘ ייבוא · ${d.shipmentId}`,
    sub: `יובא מצילומים ב-${fmtStamp(rec.createdAt)} · ${READ_MODES[rec.mode] || rec.mode}${rec.double ? ' · קריאה כפולה' : ''}`,
    reads: row.reads, orig: row.orig, cur: row.final, flags: row.flags, notes: row.notes, shots,
  });
}

// 🧪 Both models on the same screenshots; shows every field where they differ. Nothing is saved.
function modelTestSheet() {
  openModal((m) => {
    const input = el('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
    const out = el('div');
    const go = el('button', { class: 'btn primary', type: 'button', onclick: () => input.click() }, '🖼️ בחר צילומים והרץ');
    m.append(
      el('h2', {}, '🧪 בדיקת מודלים – Sonnet מול Opus'),
      el('p', { class: 'muted' }, 'כל צילום נקרא ע״י שני המודלים, ומוצגים כל השדות שבהם הם שונים. לא נשמר כלום והצילומים נמחקים בסוף. עלות: ~$0.06 לצילום. מומלץ 5–6 צילומים מיום שהטבלה הנכונה שלו ידועה לך.'),
      input, el('div', { class: 'sheet-actions' }, go), out,
    );
    input.addEventListener('change', async () => {
      const files = [...input.files];
      input.value = '';
      if (!files.length) return;
      go.disabled = true;
      const sess = { id: `test-${Date.now().toString(36)}`, mode: 'test', double: true, baseCount: files.length, photos: files.map((file, i) => ({ n: i + 1, name: file.name, file, reads: {} })) };
      try {
        await readPhotos(sess, sess.photos, (t) => { out.textContent = t; });
        out.replaceChildren(modelDiffReport(sess));
      } catch (e) { out.textContent = errText(e); }
      finally {
        go.disabled = false;
        S.db.deleteImportPhotos(sess.photos.map((p) => p.path).filter(Boolean)).catch(() => {});
      }
    });
  });
}

function modelDiffReport(sess) {
  let fields = 0, diffs = 0;
  const sections = sess.photos.map((p) => {
    const o = p.reads.opus?.cards, s = p.reads.sonnet?.cards;
    if (!o || !s) return el('div', { class: 'danger-box' }, `צילום ${p.n} (${p.name}): ${p.error || 'לא נקרא ע״י שני המודלים'}`);
    const { pairs, extra } = alignCards(o, s);
    const lines = [];
    o.forEach((c, i) => {
      const alt = pairs[i];
      if (!alt) { diffs++; lines.push([c.shipmentId || `#${c.appOrder}`, 'כל הכרטיס', '— לא נקרא', 'נקרא']); return; }
      FIELDS.forEach((k) => {
        fields++;
        if (!sameVal(k, c[k], alt[k])) { diffs++; lines.push([c.shipmentId || '—', FIELD_LABEL[k], String(alt[k] ?? ''), String(c[k] ?? '')]); }
      });
    });
    extra.forEach((c) => { diffs++; lines.push([c.shipmentId || `#${c.appOrder}`, 'כל הכרטיס', 'נקרא', '— לא נקרא']); });
    return el('div', {},
      el('h3', {}, `📷 ${p.n}. ${p.name} · Sonnet ${s.length} / Opus ${o.length} כרטיסים`),
      lines.length
        ? el('div', { class: 'tbl-wrap' }, el('table', { class: 'preview' },
          el('thead', {}, el('tr', {}, ['משלוח', 'שדה', 'Sonnet', 'Opus'].map((h) => el('th', {}, h)))),
          el('tbody', {}, lines.map((l) => el('tr', { class: 'differ' }, l.map((v) => el('td', {}, v || '—')))))))
        : el('p', {}, '✓ זהים בכל השדות'));
  });
  return el('div', {},
    el('p', {}, el('b', {}, `${diffs} הבדלים מתוך ${fields} שדות`), diffs ? ' – בדוק מול הטבלה הנכונה מי צדק.' : ' – Sonnet מספיק לצילומים האלה.'),
    ...sections);
}

// Preview before import. Text rows as always; screenshot rows (sess) add yellow/red cells linked to the
// screenshot, a 📷 source column, ⓘ details, an issue list, # gaps and ➕ add screenshot.
function previewSheet(rows, { sess = null, ctx = null } = {}) {
  const photoMode = !!sess;
  ctx ||= { photo: false, shape: commonIdShape(rows.map((r) => r.shipmentId)), streets: {} };
  const existing = new Map(S.deliveries.map((d) => [String(d.shipmentId), d]));
  const headerCount = photoMode ? Math.max(0, ...sess.photos.flatMap((p) => Object.values(p.reads).map((x) => x.headerCount || 0))) : 0;
  openModal((m, close) => {
    const seen = new Map();
    rows.forEach((r) => seen.set(r.shipmentId, (seen.get(r.shipmentId) || 0) + 1));
    const tbody = el('tbody');
    const table = el('table', { class: 'preview' },
      el('thead', {}, el('tr', {}, el('th', {}, 'ייבא'), ...COLS.map(([, h]) => el('th', {}, h)), el('th', {}, 'הערות'),
        photoMode ? el('th', {}, '📷') : null, photoMode ? el('th', {}, 'ⓘ') : null)),
      tbody);
    const summary = el('p', { class: 'muted' });
    const issuesBox = el('div', { class: 'issues' });

    const rowEls = rows.map((r, index) => {
      const notes = [];
      let cls = '', include = true;
      if (!r.shipmentId || !r.street) { notes.push(el('span', { class: 'tag bad' }, 'חסר מספר משלוח/רחוב')); cls = 'bad'; include = false; }
      else if ((r.appOrder && !/^#?\d{1,3}$/.test(r.appOrder)) || (r.houseNo && !/^\d/.test(r.houseNo)) || /\d{5,}/.test(r.city)) {
        notes.push(el('span', { class: 'tag bad' }, 'עמודות מוזזות? בדוק את השורה')); cls = 'bad'; include = false;
      }
      if (existing.has(r.shipmentId)) { notes.push(el('span', { class: 'tag warn' }, 'כבר קיים – יעודכן אם מסומן')); cls ||= 'dup'; include = false; }
      if (seen.get(r.shipmentId) > 1) { notes.push(el('span', { class: 'tag warn' }, photoMode ? 'כפול' : 'כפול בהדבקה')); cls ||= 'dup'; }
      (r.notes || []).forEach((t) => notes.push(el('span', { class: 'tag warn' }, t)));
      const cb = el('input', { type: 'checkbox' });
      cb.checked = r.checked ?? include;
      const tds = Object.fromEntries(COLS.map(([k]) => [k, el('td', { contenteditable: 'true', dataset: { k } }, r[k] ?? '')]));
      const idTag = el('span');
      const x = { r, index, cb, tds, idTag };
      x.info = photoMode ? el('button', { class: 'icon-mini', type: 'button', title: 'פרטים', onclick: () => openInfo(x) }, 'ⓘ') : null;
      x.tr = el('tr', { class: cls + (cb.checked ? '' : ' off') },
        el('td', {}, cb), ...COLS.map(([k]) => tds[k]), el('td', {}, notes, idTag),
        photoMode ? el('td', {}, el('button', { class: 'src-btn', type: 'button', title: r.src.name, onclick: () => openShots(x) }, `📷 ${r.src.photos.join('+')}/${sess.photos.length}`)) : null,
        photoMode ? el('td', {}, x.info) : null);
      Object.entries(tds).forEach(([k, td]) => {
        td.addEventListener('input', () => { r[k] = td.textContent.trim(); });
        td.addEventListener('blur', () => refresh());
        td.addEventListener('click', () => { if (photoMode && r.flags?.[k]) { td.blur(); fixCellSheet(sess, x, k, refresh); } });
      });
      cb.addEventListener('change', () => { x.tr.classList.toggle('off', !cb.checked); refresh(); });
      tbody.append(x.tr);
      return x;
    });

    const paintRow = (x) => {
      const r = x.r;
      r.flags = rowFlags(r, ctx);
      r.hadIssue ||= Object.keys(r.flags).length > 0 || !!r.notes?.length;
      Object.entries(x.tds).forEach(([k, td]) => {
        const fl = r.flags[k];
        td.classList.toggle('cell-warn', !!fl && worstLevel(fl) === 'warn');
        td.classList.toggle('cell-bad', !!fl && worstLevel(fl) === 'bad');
        td.title = fl ? fl.map((f) => f.msg).join('\n') + (photoMode ? '\n(לחץ לצילום)' : '') : '';
      });
      const id = r.flags.shipmentId?.find((f) => f.level !== 'stop');
      x.idTag.replaceChildren(id ? el('span', { class: 'tag ' + (id.level === 'warn' ? 'warn' : 'bad') }, id.msg) : '');
      if (x.info) x.info.hidden = !(r.hadIssue || isEdited(r));
    };
    const rowName = (x) => `שורה ${x.index + 1}${x.r.appOrder ? ` (#${x.r.appOrder})` : ''}`;
    const renderIssues = () => {
      if (!photoMode) return;
      const items = [];
      const item = (level, text, ...actions) => items.push(el('div', { class: 'issue ' + level }, el('span', {}, (level === 'warn' ? '🟡 ' : '🔴 ') + text),
        ...actions.map(([label, fn]) => el('button', { class: 'btn small', type: 'button', onclick: fn }, label))));
      sess.photos.filter((p) => p.error).forEach((p) => item('bad', `צילום ${p.n} (${p.name}) לא נקרא: ${p.error}`, ['🔁 נסה שוב', () => reread([p])]));
      if (headerCount && headerCount !== rows.length) item('warn', `באפליקציה כתוב ${headerCount} מסירות, ונקראו ${rows.length}`, ['➕ הוסף צילום', addPhotos]);
      gapIssues(rows).filter((g) => !sess.ignoredGaps.includes(g.from)).forEach((g) =>
        item('warn', gapText(g), ['➕ הוסף צילום', addPhotos], ['התעלם', () => { sess.ignoredGaps.push(g.from); renderIssues(); }]));
      rowEls.forEach((x) => {
        (x.r.notes || []).forEach((t) => item('warn', `${rowName(x)}: ${t}`, ['הצג', () => openShots(x)]));
        Object.entries(x.r.flags || {}).forEach(([k, fl]) => fl.forEach((f) =>
          item(f.level === 'warn' ? 'warn' : 'bad', `${rowName(x)} · ${FIELD_LABEL[k]}: ${f.msg}`, ['הצג', () => showCell(x, k)])));
      });
      issuesBox.replaceChildren(items.length
        ? el('details', { open: true }, el('summary', {}, `⚠️ ${items.length} לבדיקה`), el('div', { class: 'issue-list' }, items))
        : el('div', { class: 'ok-box' }, '✓ לא נמצאו בעיות – כל השדות נקראו בוודאות'));
    };
    const upd = () => {
      const opusAgain = photoMode && sess.mode === 'auto' && !sess.double ? sess.photos.filter((p) => p.reads.sonnet && p.reads.opus).length : 0;
      const zoomed = photoMode ? sess.photos.filter((p) => p.reads.zoom).length : 0;
      const zoomFailed = photoMode ? sess.photos.filter((p) => p.zoomError).length : 0;
      summary.textContent = `${rowEls.filter((x) => x.cb.checked).length} מתוך ${rows.length} שורות מסומנות לייבוא. אפשר לערוך כל תא לפני האישור.` +
        (photoMode ? ` · ${sess.photos.length} צילומים${zoomed ? ` · 🔍 ${zoomed} נבדקו בזום` : ''}${zoomFailed ? ` · ${zoomFailed} בלי זום (שגיאה)` : ''}${opusAgain ? ` · ${opusAgain} נבדקו שוב ב-Opus` : ''}${sess.double ? ' · קריאה כפולה' : ''}` : '');
    };
    function refresh() {
      ctx.shape = commonIdShape(rows.map((r) => r.shipmentId));
      rowEls.forEach(paintRow);
      renderIssues();
      upd();
    }
    const showCell = (x, k) => {
      x.tr.scrollIntoView({ block: 'center' });
      fixCellSheet(sess, x, k, refresh);
    };
    const openShots = (x) => shotSheet({ title: `📷 ${rowName(x)} · ${x.r.name || x.r.shipmentId}`, shots: rowShots(sess, x.r) });
    const openInfo = (x) => rowInfoSheet({
      title: `ⓘ ${rowName(x)} · ${x.r.shipmentId || ''}`, reads: x.r.reads, orig: x.r.orig, cur: x.r,
      flags: flagList(x.r.flags), notes: x.r.notes, shots: rowShots(sess, x.r),
      onRestore: (k) => { x.r[k] = x.r.orig[k]; x.tds[k].textContent = x.r[k]; x.r.accepted = (x.r.accepted || []).filter((a) => a !== k); refresh(); },
    });
    // Remember fixes by the originally read shipment number, so re-reading keeps them.
    const harvest = () => new Map(rowEls.map((x) => [cardKey(x.r.orig.shipmentId), {
      vals: Object.fromEntries(FIELDS.filter((k) => x.r[k] !== x.r.orig[k]).map((k) => [k, x.r[k]])),
      accepted: x.r.accepted || [], checked: x.cb.checked,
    }]));
    const reread = async (photos, isNew = false) => {
      const carry = harvest();
      try {
        await readPhotos(sess, photos, (t) => toast(t, { ms: 0 }));
        $('#toast').hidden = true;
        if (isNew && photos.every((p) => p.error)) return toast('הצילום לא נקרא: ' + photos[0].error, { err: true, ms: 7000 });
        close();
        await openPhotoPreview(sess, carry);
      } catch (e) { toast(errText(e), { err: true, ms: 7000 }); }
    };
    const addPhotos = () => {
      const inp = el('input', { type: 'file', accept: 'image/*', multiple: true });
      inp.addEventListener('change', () => {
        const start = sess.photos.length;
        const added = [...inp.files].map((file, i) => ({ n: start + i + 1, name: file.name, file, reads: {} }));
        if (!added.length) return;
        sess.photos.push(...added);
        reread(added, true);
      });
      inp.click();
    };

    const confirm = async () => {
      rowEls.forEach((x) => Object.entries(x.tds).forEach(([k, td]) => (x.r[k] = td.textContent.trim())));
      refresh();
      const chosen = rowEls.filter((x) => x.cb.checked);
      if (!chosen.length) return toast('לא סומנו שורות', { err: true });
      const empty = chosen.filter((x) => !x.r.shipmentId);
      if (empty.length) {
        empty[0].tr.scrollIntoView({ block: 'center' });
        return toast(`${empty.length} שורות מסומנות בלי מספר משלוח – יש למלא או לבטל את הסימון`, { err: true, ms: 6000 });
      }
      const red = chosen.filter((x) => Object.values(x.r.flags).flat().some((f) => f.level === 'bad'));
      if (red.length && !(await confirmModal({
        title: '🔴 אזהרה אדומה',
        body: `${red.length} שורות עם אזהרה אדומה (${red.map((x) => (x.r.appOrder ? '#' + x.r.appOrder : 'שורה ' + (x.index + 1))).join(', ')}).<br>לייבא בכל זאת?`,
        okText: 'ייבא', cancelText: 'חזור לתקן',
      }))) return;
      const rowsIn = chosen.map((x) => x.r).filter((r) => r.street);
      if (!rowsIn.length) return toast('אין שורות עם רחוב לייבוא', { err: true });
      closeAll();
      const until = now() + IMPORT_TTL;
      const docs = rowsIn.map((r) => {
        const base = {
          shipmentId: r.shipmentId, name: r.name, street: r.street, houseNo: r.houseNo,
          city: r.city || S.settings.defaultCity,
          appOrder: r.appOrder === '' ? null : parseInt(String(r.appOrder).replace('#', ''), 10) || null,
          ref: r.ref && r.ref !== '0' ? r.ref : null,
          ...(photoMode ? { importSrc: { importId: sess.id, photo: r.src.photo, photos: r.src.photos, name: r.src.name, until } } : {}),
        };
        const ex = existing.get(r.shipmentId);
        if (ex) return addressKey(ex) === addressKey(base) ? base : { ...base, geoStatus: 'pending', lat: null, lng: null };
        return {
          ...base, status: 'pending', statusAt: null, history: [], geoStatus: 'pending', lat: null, lng: null,
          initialStop: null, initialSub: null, updatedStop: null, updatedSub: null,
          smartInitialStop: null, smartInitialSub: null, smartUpdatedStop: null, smartUpdatedSub: null, importedAt: now(),
        };
      });
      if (!S.day) await S.db.saveDay(S.key, { date: S.date, version: S.version, createdAt: now(), hasInitialRoute: false });
      await S.db.putDeliveries(S.key, docs);
      if (photoMode) {
        // Import record for ⓘ after import (14 days): what was read, what was changed, and why it was flagged.
        S.db.saveImport(sess.id, {
          createdAt: now(), until, dayKey: S.key, mode: sess.mode, double: sess.double, headerCount,
          photos: sess.photos.filter((p) => p.path).map((p) => ({ n: p.n, name: p.name, path: p.path, models: Object.keys(p.reads) })),
          rows: rowsIn.map((r) => ({
            shipmentId: r.shipmentId, dayKey: S.key, src: r.src, reads: r.reads, orig: r.orig,
            final: Object.fromEntries(FIELDS.map((k) => [k, r[k] ?? ''])), edited: FIELDS.filter((k) => String(r[k] ?? '') !== String(r.orig[k] ?? '')),
            flags: flagList(r.flags), notes: r.notes || [], accepted: r.accepted || [],
          })),
        }).catch((e) => console.warn('save import record', e));
        learnNames(rowsIn);
      }
      toast(`יובאו ${docs.length} משלוחים ✓`);
      const toGeo = docs.filter((d) => d.geoStatus === 'pending').map((d) => ({ ...existing.get(d.shipmentId), ...d }));
      await geocodeMany(toGeo);
    };

    m.append(...[
      el('h2', {}, `תצוגה מקדימה – ${rows.length} שורות`),
      summary,
      photoMode ? issuesBox : null,
      el('div', { class: 'tbl-wrap' }, table),
      el('div', { class: 'sheet-actions' },
        el('button', { class: 'btn primary', type: 'button', onclick: confirm }, '✓ אשר ייבוא'),
        photoMode ? el('button', { class: 'btn', type: 'button', onclick: addPhotos }, '➕ הוסף צילום') : null,
        el('button', { class: 'btn', type: 'button', onclick: close }, 'חזור לעריכה'),
      ),
    ].filter(Boolean));
    refresh();
  });
}

// ------------------------------------------------------------------ route dialog
function pointPicker(title, { allowNone }) {
  const name = 'pp' + Math.random().toString(36).slice(2);
  const opts = [
    ...(allowNone ? [['none', 'ללא – לסיים בעצירה האחרונה']] : []),
    ['gps', '📍 המיקום הנוכחי שלי'],
    ['address', '✍️ כתובת'],
  ];
  const street = el('input', { placeholder: 'רחוב' });
  const house = el('input', { placeholder: 'מס׳' });
  const city = el('input', { value: S.settings.defaultCity, placeholder: 'עיר' });
  const addrBox = el('div', { hidden: true },
    el('div', { class: 'row2' }, el('label', { class: 'field' }, 'רחוב', street), el('label', { class: 'field' }, 'מספר', house)),
    el('label', { class: 'field' }, 'עיר', city));
  attachAutocomplete(street, () => city.value);
  const radios = opts.map(([v, label], i) => {
    const r = el('input', { type: 'radio', name, value: v });
    r.checked = i === 0;
    r.addEventListener('change', () => (addrBox.hidden = v !== 'address'));
    return el('label', {}, r, label);
  });
  const node = el('div', {}, el('h3', {}, title), el('div', { class: 'radio-list' }, radios), addrBox);
  return {
    node,
    get() {
      const v = node.querySelector(`input[name="${name}"]:checked`).value;
      if (v === 'none') return null;
      if (v === 'gps') return { type: 'gps' };
      if (!street.value.trim()) throw new Error(`יש להזין כתובת ב"${title}"`);
      return { type: 'address', text: `${street.value.trim()} ${house.value.trim()}, ${city.value.trim() || S.settings.defaultCity}` };
    },
  };
}

function routeSheet() {
  if (!S.deliveries.length) return toast('אין משלוחים – יש לייבא קודם', { err: true });
  if (hasAnyRoute()) return routeChoiceSheet();
  routeBuildSheet('initial');
}

function routeChoiceSheet() {
  openModal((m, close) => {
    const act = S.deliveries.filter(isActive).length;
    m.append(
      el('h2', {}, '🧭 כבר קיים מסלול'),
      el('p', {}, `המסלול הראשוני נבנה ${S.day.initialBuiltAt ? 'ב-' + fmtTime(S.day.initialBuiltAt) : ''} ואינו משתנה (${MODE_LABEL[routeMode()]}). נשארו ${act} משלוחים פעילים.`),
      el('div', { class: 'status-opts' },
        el('button', { class: 'btn primary', type: 'button', onclick: () => routeBuildSheet('updated') }, '🔄 בנה מסלול מעודכן (רק ממתין + לא ענה זמני)'),
        el('button', { class: 'btn', type: 'button', onclick: () => stayOnRouteSheet() }, '➡️ השאר את המסלול הקיים – מאיפה להמשיך?'),
      ),
    );
  });
}

async function stayOnRouteSheet() {
  if (!S.me) { try { toast('מאתר מיקום…', { ms: 0 }); setMe(await getCurrentPosition()); $('#toast').hidden = true; } catch { /* optional */ } }
  const { next, nearest } = nextStops();
  openModal((m, close) => {
    m.append(el('h2', {}, '➡️ המשך במסלול הקיים'));
    if (!next) m.append(el('p', {}, 'אין משלוחים פעילים 🎉'));
    else {
      m.append(el('p', {}, 'העצירה הבאה לפי המסלול המעודכן:'),
        el('p', {}, el('b', {}, `עצירה ${updLabel(next) ?? '—'} (ראשוני ${initLabel(next) ?? '—'})`), ` · ${next.name || ''} · ${fullAddress(next)}`),
        el('div', { class: 'sheet-actions' }, el('a', { class: 'btn waze', href: wazeUrl(next), target: '_blank', rel: 'noopener' }, 'נווט ב-Waze'), el('a', { class: 'btn gmaps', href: gmapsUrl(next), target: '_blank', rel: 'noopener' }, 'Google Maps')));
      if (nearest && nearest.shipmentId !== next.shipmentId) {
        m.append(el('p', { class: 'muted' }, `📍 שים לב: הכי קרוב למיקום שלך עכשיו הוא ${nearest.name || ''} – ${fullAddress(nearest)} (עצירה ${updLabel(nearest) ?? '—'}).`));
      }
    }
    m.append(el('div', { class: 'sheet-actions' }, el('button', { class: 'btn', type: 'button', onclick: close }, 'סגור')));
  });
}

function routeBuildSheet(kind) {
  openModal((m, close) => {
    const start = pointPicker('נקודת התחלה', { allowNone: false });
    const end = pointPicker('נקודת סיום', { allowNone: true });
    const pool = S.deliveries.filter(isActive);
    const missing = pool.filter((d) => !hasCoords(d));
    const approx = pool.filter((d) => d.geoStatus === 'approx');
    m.append(el('h2', {}, kind === 'initial' ? '🧭 בניית מסלול ראשוני' : '🔄 בניית מסלול מעודכן'));
    m.append(el('p', { class: 'muted' }, kind === 'initial'
      ? `המסלול הראשוני ימוספר פעם אחת (לפיו מסדרים את הרכב) ולא ישתנה. ${pool.length} משלוחים.`
      : `המסלול המעודכן כולל רק "ממתין" ו"לא ענה זמני": ${pool.length} משלוחים. המספור הראשוני נשאר.`));
    if (missing.length) m.append(el('div', { class: 'danger-box' }, `${missing.length} כתובות לא אותרו ולא ייכנסו למסלול: ${missing.map((d) => fullAddress(d)).join(' · ')}`));
    if (approx.length) m.append(el('p', { class: 'muted' }, `⚠️ ${approx.length} כתובות אותרו ברמת רחוב בלבד (מיקום משוער). כדי לדייק: ✎ ← "סמן על המפה", או הפעל איתור Google בהגדרות.`));
    // Engine choice: regular / smart / both.
    const modeName = 'mode' + Math.random().toString(36).slice(2);
    const curMode = S.day?.routeMode || S.settings.routeMode || 'both';
    const modeBox = el('div', { class: 'radio-list' }, Object.entries(MODE_LABEL).map(([v, label]) => {
      const r = el('input', { type: 'radio', name: modeName, value: v });
      r.checked = v === curMode;
      const hint = { regular: 'חינמי, בלי עומסי תנועה', smart: 'Google: תנועה אמיתית, צד הכביש, זמן עצירה', both: 'שניהם – להשוואה (עלות כמו חכם)' }[v];
      return el('label', {}, r, el('span', {}, label, el('small', { class: 'muted', style: 'display:block' }, hint)));
    }));
    m.append(el('h3', {}, 'מנוע'), modeBox, start.node, end.node);
    const go = el('button', { class: 'btn primary', type: 'button' }, 'חשב מסלול');
    go.addEventListener('click', async () => {
      let s, e;
      try { s = start.get(); e = end.get(); } catch (err) { return toast(err.message, { err: true }); }
      go.disabled = true;
      const mode = modeBox.querySelector('input:checked').value;
      try {
        const eff = await buildRoute(kind, s, e, mode);
        closeAll();
        S.sort = eff === 'regular' ? 'updated' : 'smartUpdated'; prefs.set('sort', S.sort);
        if (S.settings.routeMode !== mode) { S.settings.routeMode = mode; S.db.setMeta('settings', { routeMode: mode }).catch(() => {}); }
        render();
      }
      catch (err) { console.error(err); toast(err.message, { err: true, ms: 6000 }); go.disabled = false; }
    });
    m.append(el('div', { class: 'sheet-actions' }, go, el('button', { class: 'btn', type: 'button', onclick: close }, 'ביטול')));
  });
}

// ------------------------------------------------------------------ days: history, versions & new day
async function versionsOf(date) {
  const days = await S.db.listDays().catch(() => []);
  return days.filter((d) => (d.date || parseKey(d.key || '').date) === date)
    .map((d) => ({ ...d, version: d.version || parseKey(d.key || d.date).version }))
    .sort((a, b) => a.version - b.version);
}

// Open a date. Without a version → its latest version.
async function openDate(date, version) {
  const vs = await versionsOf(date);
  const nums = vs.map((d) => d.version);
  S.date = date;
  S.versions = nums.length ? nums : [1];
  S.version = version || Math.max(...S.versions);
  S.key = dayKey(S.date, S.version);
  S.unlocked = false;
  S.dist = {};
  S.mapFitted = false;
  subscribe();
}

async function daysSheet() {
  const days = (await S.db.listDays().catch(() => []))
    .map((d) => ({ ...d, date: d.date || parseKey(d.key).date, version: d.version || parseKey(d.key || d.date).version }));
  openModal((m, close) => {
    const input = el('input', { type: 'date', value: S.date });
    m.append(
      el('h2', {}, '📅 ימים וגרסאות'),
      el('div', { class: 'row2' }, el('label', { class: 'field' }, 'פתח תאריך', input),
        el('div', { class: 'field' }, ' ', el('button', { class: 'btn primary', type: 'button', onclick: () => { if (input.value) { closeAll(); openDate(input.value); } } }, 'פתח'))),
      el('h3', {}, 'ימים קודמים'),
    );
    if (!days.some((d) => d.date === S.today)) days.push({ date: S.today, version: 1, total: 0, active: 0 });
    const byDate = new Map();
    days.forEach((d) => { if (!byDate.has(d.date)) byDate.set(d.date, []); byDate.get(d.date).push(d); });
    const list = el('div', { class: 'days-list' });
    [...byDate.keys()].sort().reverse().forEach((date) => {
      const vs = byDate.get(date).sort((a, b) => b.version - a.version);
      const latest = vs[0].version, many = vs.length > 1;
      vs.forEach((d) => list.append(el('button', {
        class: 'btn' + (date === S.date && d.version === S.version ? ' cur' : '') + (many && d.version !== latest ? ' sub' : ''), type: 'button',
        onclick: () => { closeAll(); openDate(date, d.version); },
      }, el('span', {}, fmtDate(date) + verLabel(d.version, latest, many)),
        el('span', { class: 'muted' }, `${d.total ?? 0} משלוחים${d.active ? ` · ${d.active} פעילים` : ''}`))));
    });
    m.append(list, el('div', { class: 'sheet-actions' },
      el('button', { class: 'btn', type: 'button', onclick: () => newDaySheet() }, '🆕 יום חדש / גרסה חדשה'),
      el('button', { class: 'btn', type: 'button', onclick: close }, 'סגור')));
  });
}

async function moveActives(fromKey, toKey, items) {
  const to = parseKey(toKey);
  const docs = items.map((d) => ({
    ...d, initialStop: null, initialSub: null, updatedStop: null, updatedSub: null, movedTo: null,
    smartInitialStop: null, smartInitialSub: null, smartUpdatedStop: null, smartUpdatedSub: null,
    movedFrom: fromKey, history: [...(d.history || []), { status: 'moved', at: now(), from: fromKey }].slice(-30),
  }));
  const target = await S.db.getDay(toKey);
  if (!target) await S.db.saveDay(toKey, { date: to.date, version: to.version, createdAt: now(), hasInitialRoute: false });
  await S.db.putDeliveries(toKey, docs);
  await S.db.updateMany(fromKey, items.map((d) => ({ id: d.shipmentId, patch: { movedTo: toKey } })));
}

// Where "new day" lands for a date: its latest version if still empty, otherwise the next version.
async function nextRunFor(date) {
  const vs = await versionsOf(date);
  if (date === S.date) vs.forEach((v) => { if (v.version === S.version) v.total = S.deliveries.length; });
  if (!vs.length) return { version: 1, fresh: true };
  const last = vs[vs.length - 1];
  return (last.total || 0) > 0 ? { version: last.version + 1, fresh: true } : { version: last.version, fresh: false };
}

function newDaySheet() {
  openModal((m, close) => {
    const curKey = S.key;
    const curLabel = fmtDate(S.date, false) + verLabel(S.version, latestVersion(), S.versions.length > 1);
    const act = S.deliveries.filter(isActive);
    const input = el('input', { type: 'date', value: S.today });
    const body = el('div', {});
    m.append(el('h2', {}, '🆕 יום חדש / גרסה חדשה'),
      el('p', { class: 'muted' }, 'אם בתאריך שנבחר כבר יש עבודה – היא נשמרת כגרסה קודמת, ונפתחת גרסה חדשה (אחרון).'),
      el('label', { class: 'field' }, 'תאריך', input), body);

    const draw = async () => {
      const target = input.value;
      body.replaceChildren();
      if (!target) return;
      const run = await nextRunFor(target);
      if (input.value !== target) return;
      const tKey = dayKey(target, run.version);
      const tLabel = fmtDate(target, false) + (run.version > 1 ? ` · גרסה ${run.version} (אחרון)` : '');
      if (tKey === curKey) { body.append(el('p', {}, 'זו כבר הגרסה הפתוחה עכשיו, והיא ריקה.')); return; }
      if (act.length) body.append(el('div', { class: 'danger-box', style: 'margin-top:10px' }, `⚠️ ב${curLabel} נשארו ${act.length} משלוחים פעילים (ממתין / לא ענה זמני)!`));
      body.append(el('p', {}, 'ייפתח: ', el('b', {}, tLabel)));
      const actions = el('div', { class: 'status-opts', style: 'margin-top:6px' });
      if (act.length) {
        actions.append(el('button', { class: 'btn primary', type: 'button', onclick: async () => {
          closeAll(); await moveActives(curKey, tKey, act); toast(`${act.length} משלוחים הועברו ל-${fmtKey(tKey)}`); openDate(target, run.version);
        } }, `➡️ העבר ${act.length} פעילים ופתח ${tLabel}`));
      }
      actions.append(el('button', { class: 'btn' + (act.length ? ' danger-outline' : ' primary'), type: 'button', onclick: async () => {
        if (act.length) {
          const ok = await confirmModal({
            title: 'פתיחה ריקה',
            body: `<b style="color:var(--danger)">${act.length} משלוחים פעילים יישארו ב${esc(curLabel)} ולא יועברו.</b> הגרסה הנוכחית נשמרת בהיסטוריה.`,
            okText: 'פתח ריק', danger: true, requireWord: 'איפוס',
          });
          if (!ok) return;
        }
        closeAll();
        if (!(await S.db.getDay(tKey))) await S.db.saveDay(tKey, { date: target, version: run.version, createdAt: now(), hasInitialRoute: false });
        openDate(target, run.version);
      } }, `🆕 פתח ${tLabel} ריק${act.length ? ' (בלי להעביר)' : ''}`));
      body.append(actions);
    };
    input.addEventListener('change', draw);
    draw();
    m.append(el('div', { class: 'sheet-actions' }, el('button', { class: 'btn', type: 'button', onclick: close }, 'ביטול')));
  });
}

async function maybePromptCarryOver() {
  if (S.movePromptShown || S.date !== S.today || S.version !== latestVersion() || S.deliveries.length) return;
  S.movePromptShown = true;
  const days = await S.db.listDays(10).catch(() => []);
  const prev = days.find((d) => (d.date || '') < S.today && d.active > 0);
  if (!prev) return;
  const prevKey = prev.key || prev.date;
  const items = (await S.db.getDeliveries(prevKey)).filter(isActive);
  if (!items.length) return;
  const ok = await confirmModal({
    title: 'נשארו משלוחים מיום קודם',
    body: `ב-${esc(fmtKey(prevKey))} נשארו <b>${items.length}</b> משלוחים פעילים. להעביר אותם לכאן?`,
    okText: 'העבר',
  });
  if (ok) { await moveActives(prevKey, S.key, items); toast(`${items.length} משלוחים הועברו`); }
}

// ------------------------------------------------------------------ export, segments, settings, menu
function exportCsv() {
  const head = ['חכם ראשוני', 'חכם מעודכן', 'מסלול ראשוני', 'מסלול מעודכן', 'סדר אפליקציה', 'מספר משלוח', 'שם', 'רחוב', 'מספר בית', 'עיר', "אס' 2", 'סטטוס', 'שעת סטטוס', 'איתור', 'lat', 'lng'];
  const rows = S.deliveries.slice().sort((a, b) => orderKey(a.initialStop, a.initialSub) - orderKey(b.initialStop, b.initialSub)).map((d) => [
    stopLabel(d.smartInitialStop, d.smartInitialSub) ?? '', stopLabel(d.smartUpdatedStop, d.smartUpdatedSub) ?? '',
    stopLabel(d.initialStop, d.initialSub) ?? '', stopLabel(d.updatedStop, d.updatedSub) ?? '', d.appOrder ?? '', d.shipmentId, d.name, d.street, d.houseNo, d.city, d.ref ?? '',
    d.movedTo ? 'הועבר ' + fmtKey(d.movedTo) : STATUS[d.status]?.label ?? '', d.statusAt ? new Date(d.statusAt).toLocaleString('he-IL') : '', d.geoStatus ?? '', d.lat ?? '', d.lng ?? '',
  ]);
  const csv = '﻿' + [head, ...rows].map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = el('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })), download: `smartroute-${S.key}.csv` });
  document.body.append(a); a.click(); a.remove();
}

function segmentsSheet() {
  const stops = [];
  const seen = new Set();
  S.deliveries.filter(isActive).sort((a, b) => updKey(a) - updKey(b)).forEach((d) => {
    const k = addressKey(d);
    if (!seen.has(k)) { seen.add(k); stops.push(d); }
  });
  openModal((m, close) => {
    m.append(el('h2', {}, '🗺️ מסלול מלא ב-Google Maps'), el('p', { class: 'muted' }, 'Google Maps מקבל עד 10 יעדים בכל פעם, ולכן המסלול מחולק למקטעים. ההתחלה היא מהמיקום הנוכחי שלך.'));
    if (!stops.length) m.append(el('p', {}, 'אין עצירות פעילות.'));
    const box = el('div', { class: 'menu-list' });
    gmapsSegments(stops).forEach((s, i) => box.append(el('a', { class: 'btn gmaps', href: s.url, target: '_blank', rel: 'noopener' }, `מקטע ${i + 1}: עצירות ${s.from}–${s.to}`)));
    m.append(box, el('div', { class: 'sheet-actions' }, el('button', { class: 'btn', type: 'button', onclick: close }, 'סגור')));
  });
}

async function settingsSheet() {
  const usage = await S.db.getMeta('usage-' + new Date().toISOString().slice(0, 7)).catch(() => null);
  openModal((m, close) => {
    const city = el('input', { value: S.settings.defaultCity });
    const geocoder = el('select', {}, el('option', { value: 'osm' }, 'OpenStreetMap (חינמי, לרוב ברמת רחוב)'), el('option', { value: 'google' }, 'Google (מדויק לכתובת, דורש מפתח API)'));
    geocoder.value = S.settings.geocoder;
    const key = el('input', { value: S.settings.googleKey, placeholder: 'AIza…', dir: 'ltr' });
    const optimizer = el('select', {}, el('option', { value: 'google' }, ENGINE_LABEL.google), el('option', { value: 'osrm' }, ENGINE_LABEL.osrm));
    optimizer.value = S.settings.optimizer;
    const service = el('input', { type: 'number', min: '0', max: '1800', step: '15', value: S.settings.serviceSeconds, inputmode: 'numeric' });
    const traffic = el('input', { type: 'checkbox' });
    traffic.checked = S.settings.traffic !== false;
    const readMode = el('select', {}, Object.entries(READ_MODES).map(([v, label]) => el('option', { value: v }, label)));
    readMode.value = S.settings.readMode || 'auto';
    const shots = (mdl) => usage?.['extract_' + mdl] || 0;
    const readCost = Object.entries(READ_PRICE).reduce((sum, [mdl, [pin, pout]]) => sum + ((usage?.['extractIn_' + mdl] || 0) * pin + (usage?.['extractOut_' + mdl] || 0) * pout) / 1e6, 0);
    m.append(
      el('h2', {}, '⚙️ הגדרות'),
      el('label', { class: 'field' }, 'עיר ברירת מחדל', city),
      el('label', { class: 'field' }, 'איתור כתובות (Geocoding)', geocoder),
      el('label', { class: 'field' }, 'מפתח Google Maps API (לא חובה)', key),
      el('label', { class: 'field' }, 'מנוע סידור מסלול', optimizer),
      el('label', { class: 'field' }, 'זמן עצירה ממוצע לכל כתובת (שניות)', service),
      el('label', { class: 'switch', style: 'margin-top:10px' }, traffic, el('span', {}, 'להתחשב בעומסי תנועה (Google)')),
      el('label', { class: 'field' }, 'קריאת צילומים בייבוא (Claude)', readMode),
      el('p', { class: 'usage' }, `שימוש ב-Google החודש: ${usage?.geocode || 0} איתורים (חינם עד 10,000) · ${usage?.routeoptRequests || 0} חישובי מסלול, ${usage?.routeoptShipments || 0} משלוחים (חינם עד 5,000).`),
      el('p', { class: 'usage' }, `קריאת צילומים החודש: Sonnet ${shots('sonnet')}, Opus ${shots('opus')}, בדיקות זום ${shots('zoom')} · עלות משוערת ~$${readCost.toFixed(2)}.`),
      el('p', { class: 'muted' }, S.db.mode === 'firebase' ? `מחובר כ: ${S.user.email || S.user.name}` : 'מצב הדגמה – הנתונים בדפדפן הזה בלבד.'),
      el('p', { class: 'muted' }, 'מנהל המערכת רואה את מצב המשלוחים שלך ואת המיקום האחרון שנקלט באפליקציה (ברענון מיקום ובעדכון סטטוס בלבד).'),
    );
    const save = async () => {
      const next = { defaultCity: city.value.trim() || 'חולון', geocoder: geocoder.value, googleKey: key.value.trim(), optimizer: optimizer.value, serviceSeconds: Math.max(0, Math.min(1800, +service.value || 0)), traffic: traffic.checked, readMode: readMode.value };
      if (next.geocoder === 'google' && !next.googleKey) return toast('לאיתור Google צריך מפתח API', { err: true });
      S.settings = { ...S.settings, ...next };
      await S.db.setMeta('settings', next);
      maps.configure({ geocoderName: next.geocoder, googleKey: next.googleKey });
      closeAll(); toast('ההגדרות נשמרו ✓');
    };
    const actions = el('div', { class: 'sheet-actions' },
      el('button', { class: 'btn primary', type: 'button', onclick: save }, 'שמור'),
      el('button', { class: 'btn', type: 'button', onclick: close }, 'ביטול'));
    m.append(actions);
    const failed = S.deliveries.filter((d) => d.geoStatus !== 'ok' && d.geoStatus !== 'manual');
    if (failed.length && !readonly()) {
      m.append(el('div', { class: 'sheet-actions' }, el('button', { class: 'btn', type: 'button', onclick: async () => { closeAll(); await geocodeMany(failed, { force: true }); } }, `🔍 אתר מחדש ${failed.length} כתובות לא מדויקות`)));
    }
    if (S.db.mode === 'firebase') m.append(el('div', { class: 'sheet-actions' }, el('button', { class: 'btn danger', type: 'button', onclick: () => { closeAll(); S.db.signOut(); } }, 'התנתק')));
  });
}

// Wipe the day currently shown (deliveries + route). Always requires typing "איפוס".
async function resetDay() {
  const act = S.deliveries.filter(isActive).length;
  const body = el('div', {},
    act ? el('div', { class: 'danger-box' }, `⚠️ נשארו ${act} משלוחים פעילים (ממתין / לא ענה זמני)!`) : null,
    el('p', { html: `<b style="color:var(--danger)">כל ${S.deliveries.length} המשלוחים של ${esc(fmtDate(S.date) + verLabel(S.version, latestVersion(), S.versions.length > 1))} יימחקו, כולל המסלול הראשוני והמעודכן.</b>` }),
    act ? el('p', { class: 'muted' }, 'כדי להעביר אותם ליום אחר במקום למחוק: ☰ ← יום חדש.') : null,
  );
  const ok = await confirmModal({ title: '🗑 איפוס היום', body, okText: 'אפס', danger: true, requireWord: 'איפוס' });
  if (!ok) return;
  closeAll();
  await S.db.deleteDeliveries(S.key, S.deliveries.map((d) => d.shipmentId));
  await S.db.saveDay(S.key, { hasInitialRoute: false, routePolyline: null, routeDistance: null, routeDuration: null, start: null, end: null, initialBuiltAt: null, updatedBuiltAt: null,
    hasSmartInitial: false, smartPolyline: null, smartDistance: null, smartDuration: null, smartInitialBuiltAt: null, routeMode: null });
  S.dist = {};
  toast('היום אופס');
}

// Run both engines on the active stops (nothing is saved) and show them side by side.
async function compareSheet() {
  const eligible = S.deliveries.filter((d) => isActive(d) && hasCoords(d));
  if (eligible.length < 2) return toast('צריך לפחות 2 כתובות פעילות מאותרות', { err: true });
  let start;
  try { toast('מאתר מיקום…', { ms: 0 }); const p = await getCurrentPosition(); setMe(p); start = pt(p); }
  catch { if (S.day?.start) start = pt(S.day.start); else return toast('צריך מיקום נוכחי להשוואה', { err: true }); }
  const groups = new Map();
  eligible.forEach((d) => { const k = addressKey(d); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(d); });
  const gList = [...groups.values()].map((members) => ({ members, lat: members[0].lat, lng: members[0].lng }));
  toast(`מחשב ${gList.length} עצירות בשני המנועים…`, { ms: 0 });
  const [g, o] = [await optimizeOrder(start, null, gList, 'google'), await optimizeOrder(start, null, gList, 'osrm')];
  $('#toast').hidden = true;
  openModal((m, close) => {
    const col = (r) => el('div', { class: 'cmp-col' },
      el('h3', {}, ENGINE_LABEL[r.engine]),
      el('div', { class: 'cmp-metric' }, el('b', {}, r.line ? fmtDist(r.line.distance) : '—'), ' · ', el('b', {}, r.line ? fmtDur(r.line.duration) : '—'), el('small', {}, ' נסיעה')),
      el('ol', { class: 'cmp-list' }, r.orderIdx.map((i) => el('li', {}, fullAddress(gList[i].members[0]).replace(/, [^,]+$/, '')))));
    const same = g.engine === o.engine;
    m.append(
      el('h2', {}, '📊 השוואת מנועים'),
      el('p', { class: 'muted' }, `${gList.length} עצירות פעילות, מהמיקום הנוכחי. לא נשמר כלום – זו השוואה בלבד. זמני Google כוללים עומסי תנועה; המנוע החינמי – בלי.`),
      same ? el('div', { class: 'danger-box' }, 'Google לא היה זמין – שני הטורים מהמנוע החינמי.') : null,
      el('div', { class: 'cmp' }, col(g), col(o)),
      el('div', { class: 'sheet-actions' }, el('button', { class: 'btn', type: 'button', onclick: close }, 'סגור')),
    );
  });
}

function menuSheet() {
  openModal((m, close) => {
    const item = (label, fn, disabled = false, keepMenu = true) => el('button', { class: 'btn', type: 'button', disabled, onclick: () => { if (!keepMenu) close(); fn(); } }, label);
    m.append(el('h2', {}, 'תפריט'), el('div', { class: 'menu-list' },
      item('🆕 יום חדש', newDaySheet, readonly()),
      item('📅 ימים קודמים / בחירת תאריך', daysSheet),
      item('🗺️ מסלול מלא ב-Google Maps', segmentsSheet),
      item('📊 השוואת מנועים (Google מול חינמי)', compareSheet, !S.deliveries.length),
      item('🧪 בדיקת מודלים לקריאת צילומים', modelTestSheet),
      item('📤 ייצוא CSV', exportCsv, false, false),
      item('⚙️ הגדרות', settingsSheet),
      item('🔗 הזמן חבר (קישור הרשמה)', inviteFriendSheet),
      el('button', { class: 'btn danger-outline', type: 'button', disabled: readonly() || !S.deliveries.length, onclick: resetDay }, '🗑 איפוס היום'),
    ));
  });
}

// ------------------------------------------------------------------ referral links ("invite a friend")
// Each member shares a Registration link with their ref. Two refs with one random suffix:
// "<email name>-<suffix>" and "<short name>-<suffix>"; the member picks the main one.
// Custom refs (added by the superadmin in the admin panel) show up here too.
function inviteFriendSheet() {
  openModal((m) => {
    const body = el('div', {}, el('p', { class: 'muted' }, 'טוען…'));
    m.append(el('h2', {}, '🔗 הזמן חבר'),
      el('p', { class: 'muted' }, 'שלח את קישור ההרשמה שלך. מי שנרשם דרכו נרשם על שמך, ומנהל יחזור אליו עם קישור הצטרפות.'),
      body);

    const copy = async (text) => {
      try { await navigator.clipboard.writeText(text); toast('הקישור הועתק ✓'); }
      catch { prompt('העתק את הקישור:', text); }
    };
    const waUrl = (url) => `https://wa.me/?text=${encodeURIComponent(`היי! נרשמים ל-SmartRoute – סידור מסלול משלוחים חכם – דרך הקישור הזה:\n${url}`)}`;
    const KIND = { email: 'לפי אימייל', name: 'לפי שם', custom: 'מותאם' };

    const drawRefs = (refs) => {
      const primary = S.member?.primaryRef;
      const list = refs.slice().sort((a, b) => (b.id === primary) - (a.id === primary) || (a.createdAt || 0) - (b.createdAt || 0));
      body.replaceChildren(el('div', { class: 'ref-list' }, list.map((r) => {
        const url = registrationUrl(r.id);
        const isMain = r.id === primary;
        return el('div', { class: 'ref-card' + (isMain ? ' main' : '') + (r.active === false ? ' off' : '') },
          el('div', { class: 'ref-head' },
            el('b', { dir: 'ltr' }, r.id),
            el('span', { class: 'muted' }, ` · ${r.label || KIND[r.kind] || ''}`),
            isMain ? el('span', { class: 'ref-main' }, '⭐ הקישור הראשי') : null),
          el('div', { class: 'ref-url', dir: 'ltr' }, url),
          el('div', { class: 'muted' }, `${r.leads || 0} נרשמו דרך הקישור${r.active === false ? ' · הקישור כבוי' : ''}`),
          el('div', { class: 'sheet-actions' },
            el('button', { class: 'btn small', type: 'button', onclick: () => copy(url) }, '📋 העתק'),
            el('a', { class: 'btn small', href: waUrl(url), target: '_blank', rel: 'noopener' }, '💬 וואטסאפ'),
            isMain || r.active === false ? null : el('button', { class: 'btn small', type: 'button', onclick: async () => {
              try { await S.db.setPrimaryRef(r.id); S.member = { ...S.member, primaryRef: r.id }; drawRefs(refs); toast('הקישור הראשי עודכן ✓'); }
              catch (e) { toast('שגיאה: ' + e.message, { err: true }); }
            } }, '⭐ קבע כראשי')));
      })));
    };

    // First time: the member picks the main one of their two refs (both are created):
    // by name ("gil-<suffix>", from the Google first name) or by email ("gbitman.bd-<suffix>").
    // A non-English Google name (e.g. Hebrew) → only the email ref.
    const drawCreate = () => {
      const suffix = S.member.refSuffix;
      const refs = [{ id: refId(emailRefName(S.user.email) || 'user', suffix), kind: 'email' }];
      const shortName = nameRefName(S.user.name);
      if (shortName && refId(shortName, suffix) !== refs[0].id) refs.unshift({ id: refId(shortName, suffix), kind: 'name' });
      let primary = refs[0].id;
      const opt = (r) => {
        const radio = el('input', { type: 'radio', name: 'mainRef', value: r.id });
        radio.checked = r.id === primary;
        radio.addEventListener('change', () => (primary = r.id));
        return el('label', { class: 'ref-opt' }, radio, el('span', {}, r.kind === 'name' ? 'לפי שם: ' : 'לפי אימייל: ', el('b', { dir: 'ltr' }, r.id)));
      };
      const go = el('button', { class: 'btn primary', type: 'button' }, refs.length > 1 ? 'צור את הקישורים שלי' : 'צור את הקישור שלי');
      go.addEventListener('click', async () => {
        go.disabled = true;
        try {
          await S.db.createMyRefs(refs, primary);
          S.member = { ...S.member, primaryRef: primary };
          drawRefs(await S.db.myRefs());
        } catch (e) {
          console.error(e);
          toast('לא הצלחתי ליצור את הקישורים: ' + e.message, { err: true, ms: 6000 });
          go.disabled = false;
        }
      });
      body.replaceChildren(
        el('p', {}, refs.length > 1 ? 'יש לך שני קישורים – שניהם יעבדו. בחר איזה מהם יהיה הראשי:' : 'זה קישור ההרשמה שלך:'),
        el('div', { class: 'radio-list' }, refs.map(opt)),
        el('div', { class: 'sheet-actions' }, go));
    };

    (async () => {
      try {
        // No member record yet (e.g. it couldn't be created at sign-in) → try again now.
        if (!S.member?.refSuffix) {
          const gate = await ensureMember(S.db, S.user).catch(() => null);
          if (gate?.member) S.member = gate.member;
        }
        if (!S.member?.refSuffix) {
          body.replaceChildren(el('p', { class: 'err' }, 'לא ניתן ליצור קישורים כרגע – חשבון החבר שלך עוד לא נוצר בענן. אם כללי ההרשאות (firestore.rules) עודכנו לאחרונה, סגור ונסה שוב בעוד דקה.'));
          return;
        }
        const refs = await S.db.myRefs();
        if (refs.some((r) => r.kind === 'email' || r.kind === 'name')) drawRefs(refs);
        else drawCreate();
      } catch (e) {
        body.replaceChildren(el('p', { class: 'err' }, e.code === 'permission-denied'
          ? 'אין הרשאה לקרוא את הקישורים – כנראה שכללי ההרשאות (firestore.rules) עוד לא עודכנו בענן.'
          : 'שגיאה בטעינת הקישורים: ' + e.message));
      }
    })();
  });
}

// ------------------------------------------------------------------ membership screens
// Signed in with Google, but not a SmartRoute user (no magic link) – or the link was invalid.
function showNoUser(gate) {
  $('#loading').hidden = true;
  $('#login').hidden = true;
  $('#app').hidden = true;
  $('#searchBar').hidden = true;
  $('#noUser').hidden = false;
  $('#noUserEmail').textContent = S.user?.email || '';
  $('#noUserWhy').textContent = gate.state === 'badInvite'
    ? 'קישור ההזמנה אינו תקף (אולי הוחלף בקישור חדש). בקש מהמנהל קישור עדכני.'
    : gate.state === 'error'
      ? 'לא ניתן לבדוק את החשבון כרגע: ' + (gate.error?.message || '')
      : 'ההצטרפות ל-SmartRoute אפשרית רק עם קישור הזמנה ממנהל. אפשר להשאיר פרטים ונחזור אליך.';
}

// ------------------------------------------------------------------ subscriptions & boot
function subscribe() {
  S.unsubs.forEach((u) => u());
  S.unsubs = [];
  S.day = null; S.deliveries = [];
  render();
  const date = S.key;
  S.unsubs.push(S.db.watchDay(date, (day) => { if (date !== S.key) return; S.day = day; render(); }));
  S.unsubs.push(S.db.watchDeliveries(date, (list, meta = {}) => {
    if (date !== S.key) return;
    S.deliveries = list;
    S.synced = !meta.fromCache;
    render();
    if (meta.fromCache) return; // wait for the server before writing counters or prompting
    syncSummary();
    maybePromptCarryOver();
  }, (e) => toast('שגיאת חיבור לענן: ' + e.message, { err: true, ms: 8000 })));
}

// Keep day doc counters in sync – total/active for the history list, stats for the admin panel.
// stats ignore deliveries moved to another day (they are counted there).
function dayStats() {
  const live = S.deliveries.filter((d) => !d.movedTo);
  const count = (...st) => live.filter((d) => st.includes(d.status)).length;
  const doneAt = live.filter((d) => STATUS[d.status]?.final && d.statusAt).map((d) => d.statusAt);
  const delivered = count('delivered_hand', 'delivered_door'), noAnswer = count('no_answer_final'), temp = count('no_answer_temp');
  return {
    total: live.length, delivered, noAnswer, temp, pending: live.length - delivered - noAnswer - temp,
    moved: S.deliveries.length - live.length,
    firstDoneAt: doneAt.length ? Math.min(...doneAt) : null, lastDoneAt: doneAt.length ? Math.max(...doneAt) : null,
  };
}

function syncSummary() {
  const total = S.deliveries.length;
  const active = S.deliveries.filter(isActive).length;
  if (!total && !S.day) return;
  const stats = dayStats();
  const same = S.day?.stats && Object.keys(stats).every((k) => (S.day.stats[k] ?? null) === stats[k]);
  if (S.day?.total === total && S.day?.active === active && same) return;
  S.db.saveDay(S.key, { date: S.date, version: S.version, total, active, stats }).catch(() => {});
}

function bindUi() {
  $('#menuBtn').addEventListener('click', menuSheet);
  $('#dayBtn').addEventListener('click', daysSheet);
  $('#refreshBtn').addEventListener('click', refreshLocation);
  $('#routeBtn').addEventListener('click', routeSheet);
  $('#importBtn').addEventListener('click', importSheet);
  $('#mapToggle').addEventListener('click', () => toggleMap());
  $('#searchInput').addEventListener('input', (e) => { S.search = e.target.value; $('#searchClear').hidden = !S.search; render(); });
  $('#searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('#searchClear').addEventListener('click', () => { setSearch(''); $('#searchInput').focus(); });
  window.addEventListener('popstate', onPopState);
  history.replaceState({ smartrun: 'root' }, '');
  history.pushState({ smartrun: 'guard' }, '');
  $('#pickCancel').addEventListener('click', () => { S.pickFor = null; $('#pickHint').hidden = true; });
  $('#hideDone').addEventListener('change', (e) => { S.hideDone = e.target.checked; prefs.set('hideDone', S.hideDone); render(); });
  $('#sortSel').addEventListener('change', (e) => {
    S.sort = e.target.value; prefs.set('sort', S.sort); render();
    if (['drive', 'walk', 'dist'].includes(S.sort) && !S.distAt) toast('לחץ "רענון מיקום" כדי לחשב מרחקים', { ms: 4000 });
  });
  $('#unlockBtn').addEventListener('click', async () => {
    if (await confirmModal({ title: 'עריכת ארכיון', body: `לאפשר עריכה של ${esc(fmtDate(S.date, false) + verLabel(S.version, latestVersion(), S.versions.length > 1))}?` })) { S.unlocked = true; render(); }
  });
  $('#goTodayBtn').addEventListener('click', () => openDate(S.today));
  document.addEventListener('click', (e) => { if (e.target.closest('[data-action="import"]')) importSheet(); });
  // Date rolls over while the app stays open.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && todayStr() !== S.today) { S.today = todayStr(); render(); }
  });
}

// The admin disabled this account: the data is locked by firestore.rules, so just explain.
// reason: 'disabled' (can be re-enabled – the app reloads) or 'removed' (deleted by the superadmin).
// Every open device has its own members/{uid} listener, so all sessions are kicked out together.
function setBlocked(blocked, reason = 'disabled') {
  const was = S.blocked;
  S.blocked = blocked;
  if (blocked) {
    closeAll();
    $('#blockedMsg').replaceChildren(el('b', {}, reason === 'removed' ? '⛔ המשתמש הוסר מהמערכת.' : '⛔ החשבון הושבת על ידי מנהל המערכת.'));
    $('#blockedSub').textContent = reason === 'removed'
      ? 'כדי לחזור ל-SmartRoute צריך קישור הזמנה חדש ממנהל.'
      : 'לפרטים פנה למנהל. לאחר הפעלה מחדש האפליקציה תיפתח שוב.';
    $('#blockedReload').hidden = reason === 'removed';
  }
  $('#blocked').hidden = !blocked;
  $('#app').hidden = blocked || !S.user;
  $('#searchBar').hidden = blocked || !S.user;
  if (was && !blocked) location.reload(); // re-enabled: listeners were cut off, start fresh
}

// Signed-in user in the top bar: avatar (or initials) + first name. Click → menu.
function renderUserChip(user) {
  const chip = $('#userChip');
  const name = String(user?.name || user?.email || '').trim();
  const first = name.split(/[\s@]+/)[0] || '';
  const initials = name.split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
  chip.replaceChildren(
    user?.photo ? el('img', { class: 'uc-av', src: user.photo, alt: '', referrerpolicy: 'no-referrer' }) : el('span', { class: 'uc-av' }, initials),
    el('span', { class: 'uc-name' }, first));
  chip.title = `${name}${user?.email && user.email !== name ? ' · ' + user.email : ''}`;
  chip.hidden = !user;
}

async function boot() {
  bindUi();
  $('#blockedLogout').addEventListener('click', () => S.db.signOut());
  $('#blockedReload').addEventListener('click', () => location.reload());
  $('#noUserLogout').addEventListener('click', () => S.db.signOut());
  $('#userChip').addEventListener('click', () => menuSheet());
  // Magic link (?invite=…): remember it through the Google sign-in and say so on the login card.
  $('#inviteNote').hidden = !captureInvite();
  try {
    S.db = await createDb();
  } catch (e) {
    $('#loading').textContent = 'שגיאה בחיבור ל-Firebase: ' + e.message;
    return;
  }
  $('#demoBanner').hidden = S.db.mode !== 'demo';
  if (S.db.mode === 'demo') window.__smartroute = S; // test hook (demo only)
  maps.configure({ usage: (kind) => S.db.incUsage(kind).catch(() => {}) });

  $('#loginBtn').addEventListener('click', async () => {
    $('#loginErr').textContent = '';
    try { await S.db.signIn(); } catch (e) { $('#loginErr').textContent = e.message; }
  });

  S.db.onAuth(async (user) => {
    S.user = user;
    S.accessUnsub?.(); S.accessUnsub = null;
    $('#noUser').hidden = true;
    if (!user) {
      $('#loading').hidden = true; $('#login').hidden = false; $('#app').hidden = true; $('#searchBar').hidden = true;
      renderUserChip(null);
      setBlocked(false); S.unsubs.forEach((u) => u()); S.unsubs = []; return;
    }
    // Invite-only: only members (joined through an admin's magic link) may use SmartRoute.
    $('#login').hidden = true;
    $('#loading').hidden = false;
    const gate = await ensureMember(S.db, user);
    if (S.user !== user) return;
    if (!['ok', 'joined', 'disabled'].includes(gate.state)) return showNoUser(gate);
    S.member = gate.member;
    $('#loading').hidden = true;
    $('#app').hidden = false;
    $('#searchBar').hidden = false;
    $('#inviteNote').hidden = true;
    if (gate.state === 'joined') toast(`ברוך הבא ל-SmartRoute! 🎉${gate.inviter ? ` הצטרפת בהזמנת ${gate.inviter}.` : ''}`, { ms: 6000 });
    renderUserChip(user);
    const superUser = isSuperEmail(user.email);
    let hadMember = !!gate.member;
    S.accessUnsub = S.db.watchMember((mem) => {
      if (mem) { S.member = mem; hadMember = true; }
      if (superUser) return;
      if (!mem && hadMember) setBlocked(true, 'removed');       // deleted by the superadmin
      else setBlocked(mem?.disabled === true, 'disabled');
    });
    S.db.touchProfile(user).catch(() => {});
    const saved = await S.db.getMeta('settings').catch(() => null);
    S.settings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
    if (!S.settings.googleKey) S.settings.googleKey = DEFAULT_SETTINGS.googleKey;
    maps.configure({ geocoderName: S.settings.geocoder, googleKey: S.settings.googleKey });
    if (prefs.get('mapOpen', false)) toggleMap(true);
    await openDate(S.today);
    ensureStreets(S.settings.defaultCity);
  });
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot();
