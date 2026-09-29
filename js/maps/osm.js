// OpenStreetMap-based services: Nominatim (geocoding), OSRM (matrix/route), data.gov.il (street list).

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OSRM_CAR = 'https://router.project-osrm.org';
const OSRM_FOOT = 'https://routing.openstreetmap.de/routed-foot';
const OSRM_CAR_ALT = 'https://routing.openstreetmap.de/routed-car';
const STREETS_RESOURCE = '9ad3862c-8391-4b2f-84a4-2d4c68625f4b';

// Nominatim usage policy: max 1 request per second.
let lastNominatim = 0;
async function nominatim(params) {
  const wait = lastNominatim + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatim = Date.now();
  const qs = new URLSearchParams({ format: 'jsonv2', limit: '1', countrycodes: 'il', addressdetails: '1', 'accept-language': 'he', ...params });
  const res = await fetch(`${NOMINATIM}?${qs}`);
  if (!res.ok) throw new Error('Nominatim ' + res.status);
  return res.json();
}

function toResult(hit, wantedHouse) {
  if (!hit) return null;
  const hn = hit.address?.house_number;
  const precision = hn && (!wantedHouse || String(hn).replace(/\D/g, '') === String(wantedHouse).replace(/\D/g, '')) ? 'house' : 'street';
  return { lat: +hit.lat, lng: +hit.lon, precision, label: hit.display_name };
}

export async function geocode({ street, houseNo, city }) {
  const s = `${houseNo || ''} ${street || ''}`.trim();
  let hits = await nominatim({ street: s, city: city || '' });
  if (!hits.length) hits = await nominatim({ q: `${street} ${houseNo || ''}, ${city || ''}` });
  return toResult(hits[0], houseNo);
}

export async function geocodeText(text) {
  const hits = await nominatim({ q: text });
  return toResult(hits[0], null);
}

function coordStr(points) {
  return points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
}

async function osrm(base, service, points, params = {}) {
  const qs = new URLSearchParams(params);
  const res = await fetch(`${base}/${service}/v1/driving/${coordStr(points)}?${qs}`);
  const data = await res.json();
  if (data.code !== 'Ok') throw new Error('OSRM ' + (data.message || data.code));
  return data;
}

// approaches: per point 'curb' (arrive on the right-hand side of the road) or 'unrestricted'.
const approachParam = (approaches) => (approaches ? { approaches: approaches.join(';') } : {});

// Full duration matrix (seconds) for route optimization. One-way streets and turn
// restrictions come from the OSM road graph; 'curb' adds side-of-road awareness.
export async function matrix(points, approaches) {
  const params = { annotations: 'duration', ...approachParam(approaches) };
  try {
    const d = await osrm(OSRM_CAR, 'table', points, params);
    return d.durations;
  } catch {
    const d = await osrm(OSRM_CAR_ALT, 'table', points, params);
    return d.durations;
  }
}

// Distances/durations from origin (points[0]) to every other point. mode: 'car' | 'foot'
export async function fromOrigin(points, mode) {
  const bases = mode === 'foot' ? [OSRM_FOOT] : [OSRM_CAR_ALT, OSRM_CAR];
  let lastErr;
  for (const base of bases) {
    try {
      const d = await osrm(base, 'table', points, { sources: '0', annotations: 'duration,distance' });
      return points.slice(1).map((_, i) => ({ t: d.durations[0][i + 1], d: d.distances[0][i + 1] }));
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// Encoded polyline of the driving route through the points in order.
export async function routeLine(points, approaches) {
  const d = await osrm(OSRM_CAR, 'route', points, { overview: 'full', geometries: 'polyline', ...approachParam(approaches) });
  return { polyline: d.routes[0].geometry, distance: d.routes[0].distance, duration: d.routes[0].duration };
}

// Official street list for a city (data.gov.il).
export async function streets(city) {
  const filters = JSON.stringify({ 'שם_ישוב': city });
  let res = await fetch(`https://data.gov.il/api/3/action/datastore_search?resource_id=${STREETS_RESOURCE}&limit=5000&filters=${encodeURIComponent(filters)}`);
  let data = await res.json();
  let recs = data?.result?.records || [];
  if (!recs.length) {
    res = await fetch(`https://data.gov.il/api/3/action/datastore_search?resource_id=${STREETS_RESOURCE}&limit=5000&q=${encodeURIComponent(city)}`);
    data = await res.json();
    recs = (data?.result?.records || []).filter((r) => String(r['שם_ישוב']).trim() === city.trim());
  }
  const names = [...new Set(recs.map((r) => String(r['שם_רחוב']).trim().replace(/\s+/g, ' ')).filter(Boolean))];
  return names.sort((a, b) => a.localeCompare(b, 'he'));
}
