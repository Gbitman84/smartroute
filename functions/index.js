// SmartRoute – Google Route Optimization proxy.
// The browser can't call the Route Optimization API directly (it needs OAuth, not an API key),
// so this callable function does it with the function's service account.
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { GoogleAuth } = require('google-auth-library');

initializeApp();
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

const PROJECT = process.env.GCLOUD_PROJECT || 'smartrun-gbit';
const ALLOWED_EMAILS = ['gbitman.bd@gmail.com'];
const MAX_STOPS = 300;             // unique addresses per build (a whole day is always optimized together)
const DAILY_MAX_REQUESTS = 40;      // hard daily cap (Google has only per-minute quotas for this API)
const DAILY_MAX_SHIPMENTS = 1500;

const israelDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
const secs = (d) => (d ? parseFloat(String(d).replace('s', '')) : 0);
const latLng = (p) => ({ latitude: +p.lat, longitude: +p.lng });
const validPoint = (p) => p && Number.isFinite(+p.lat) && Number.isFinite(+p.lng) && Math.abs(+p.lat) <= 90 && Math.abs(+p.lng) <= 180;

exports.optimizeRoute = onCall({ region: 'europe-west1', memory: '256MiB', timeoutSeconds: 150, maxInstances: 2 }, async (req) => {
  const email = req.auth?.token?.email;
  if (!req.auth || !ALLOWED_EMAILS.includes(email)) throw new HttpsError('permission-denied', 'אין הרשאה');

  const { start, end, stops, serviceSeconds = 90, traffic = true } = req.data || {};
  if (!validPoint(start)) throw new HttpsError('invalid-argument', 'נקודת התחלה לא תקינה');
  if (end && !validPoint(end)) throw new HttpsError('invalid-argument', 'נקודת סיום לא תקינה');
  if (!Array.isArray(stops) || !stops.length || stops.length > MAX_STOPS || !stops.every(validPoint)) {
    throw new HttpsError('invalid-argument', `צריך 1–${MAX_STOPS} עצירות עם קואורדינטות`);
  }

  // Daily cap, counted per Israeli calendar day.
  const qref = getFirestore().doc(`quota/routeopt-${israelDay()}`);
  await getFirestore().runTransaction(async (tx) => {
    const q = (await tx.get(qref)).data() || { requests: 0, shipments: 0 };
    if (q.requests + 1 > DAILY_MAX_REQUESTS || q.shipments + stops.length > DAILY_MAX_SHIPMENTS) {
      throw new HttpsError('resource-exhausted', 'הגעת למכסה היומית של Google Route Optimization – משתמש במנוע החינמי');
    }
    tx.set(qref, { requests: FieldValue.increment(1), shipments: FieldValue.increment(stops.length), updatedAt: Date.now() }, { merge: true });
  });

  // Route Optimization rejects fractional seconds ("nanos must be unset") – use whole-second timestamps.
  const now = Math.floor(Date.now() / 1000) * 1000;
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const body = {
    model: {
      globalStartTime: iso(now + 60 * 1000),
      globalEndTime: iso(now + 16 * 3600 * 1000),
      shipments: stops.map((p, i) => ({
        label: String(i),
        deliveries: [{ arrivalWaypoint: { location: { latLng: latLng(p) }, sideOfRoad: true }, duration: `${Math.max(0, Math.min(1800, +serviceSeconds || 0))}s` }],
      })),
      vehicles: [{
        travelMode: 'DRIVING',
        startWaypoint: { location: { latLng: latLng(start) } },
        ...(end ? { endWaypoint: { location: { latLng: latLng(end) } } } : {}),
        costPerHour: 60,
        costPerKilometer: 1,
      }],
    },
    considerRoadTraffic: !!traffic,
    populatePolylines: true,
    timeout: stops.length > 80 ? '90s' : '30s',
  };

  const client = await auth.getClient();
  let res;
  try {
    res = await client.request({
      url: `https://routeoptimization.googleapis.com/v1/projects/${PROJECT}:optimizeTours`,
      method: 'POST',
      data: body,
    });
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    console.error('optimizeTours failed', msg);
    throw new HttpsError('internal', 'Google Route Optimization: ' + msg);
  }

  const route = res.data.routes?.[0] || {};
  const m = route.metrics || {};
  return {
    order: (route.visits || []).map((v) => v.shipmentIndex || 0),
    skipped: (res.data.skippedShipments || []).map((s) => s.index || 0),
    polyline: route.routePolyline?.points || null,
    distance: m.travelDistanceMeters || 0,
    travelSeconds: secs(m.travelDuration),
    totalSeconds: secs(m.totalDuration),
    visitSeconds: secs(m.visitDuration),
    shipments: stops.length,
  };
});
