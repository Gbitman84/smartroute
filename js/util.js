// Shared helpers: dates, text normalization, formatting, DOM.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Local calendar date as YYYY-MM-DD.
export function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fmtDate(ymd, withRel = true) {
  const [y, m, d] = ymd.split('-');
  const date = new Date(+y, +m - 1, +d);
  const days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  const rel = withRel ? relDay(ymd) : '';
  return `${rel ? rel + ' · ' : ''}יום ${days[date.getDay()]} ${d}/${m}/${y}`;
}

function relDay(ymd) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const [y, m, d] = ymd.split('-');
  const diff = Math.round((t - new Date(+y, +m - 1, +d)) / 86400000);
  return { 0: 'היום', 1: 'אתמול', 2: 'שלשום', [-1]: 'מחר' }[diff] || '';
}

export function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}

export function fmtDist(m) {
  if (m == null) return '—';
  return m < 1000 ? `${Math.round(m / 10) * 10} מ׳` : `${(m / 1000).toFixed(1)} ק״מ`;
}

export function fmtDur(s) {
  if (s == null) return '—';
  const min = Math.max(1, Math.round(s / 60));
  return min < 60 ? `${min} דק׳` : `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')} ש׳`;
}

// Normalization used for matching street names and grouping identical addresses.
export function norm(s) {
  return String(s ?? '')
    .replace(/[֑-ׇ]/g, '') // niqqud
    .replace(/["'`׳״\-–.,()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function addressKey(d) {
  return `${norm(d.street)}|${norm(d.houseNo)}|${norm(d.city)}`;
}

export function fullAddress(d) {
  return `${(d.street || '').trim()} ${(d.houseNo || '').trim()}, ${(d.city || '').trim()}`.replace(/\s+,/, ',').trim();
}

// Split "שנקר 72" / "72 שנקר" / "ז'בוטינסקי 12א" into street + house number.
export function splitAddress(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  let m = t.match(/^(.*?)[\s,]+(\d+[א-ת]?(?:\/\d+)?)$/);
  if (m) return { street: m[1].trim(), houseNo: m[2] };
  m = t.match(/^(\d+[א-ת]?)\s+(.*)$/);
  if (m) return { street: m[2].trim(), houseNo: m[1] };
  return { street: t, houseNo: '' };
}

export function haversine(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function decodePolyline(str, precision = 5) {
  let index = 0, lat = 0, lng = 0;
  const out = [], factor = 10 ** precision;
  while (index < str.length) {
    for (const which of [0, 1]) {
      let result = 0, shift = 0, b;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta; else lng += delta;
    }
    out.push([lat / factor, lng / factor]);
  }
  return out;
}

export function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('הדפדפן לא תומך במיקום'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: Date.now() }),
      (e) => reject(new Error(e.code === 1 ? 'אין הרשאת מיקום – אשר גישה למיקום בדפדפן' : 'לא הצלחתי לקבל מיקום (' + e.message + ')')),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 }
    );
  });
}

// localStorage for UI prefs only (never data).
export const prefs = {
  get(k, def) { try { const v = localStorage.getItem('smartroute.pref.' + k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem('smartroute.pref.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};
