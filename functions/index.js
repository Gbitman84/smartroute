// SmartRoute Cloud Functions.
// optimizeRoute – Google Route Optimization proxy. The browser can't call the Route Optimization API
// directly (it needs OAuth, not an API key), so this callable function does it with the service account.
// extractShipments – reads one delivery-app screenshot (from Storage) with Claude and returns the cards as JSON.
// cleanupImports – daily: deletes import screenshots/records older than 14 days.
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { GoogleAuth } = require('google-auth-library');
const Anthropic = require('@anthropic-ai/sdk').default;

initializeApp();
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

const PROJECT = process.env.GCLOUD_PROJECT || 'smartrun-gbit';
const MAX_STOPS = 300;             // unique addresses per build (a whole day is always optimized together)
const DAILY_MAX_SHIPMENTS = 1500;  // all users together; request counts are limited per role in config/limits

// Who may call (every active member) and daily limits per role – see access.js.
const { requireMember, consumeQuota, israelDay } = require('./access');
const secs = (d) => (d ? parseFloat(String(d).replace('s', '')) : 0);
const latLng = (p) => ({ latitude: +p.lat, longitude: +p.lng });
const validPoint = (p) => p && Number.isFinite(+p.lat) && Number.isFinite(+p.lng) && Math.abs(+p.lat) <= 90 && Math.abs(+p.lng) <= 180;

exports.optimizeRoute = onCall({ region: 'europe-west1', memory: '256MiB', timeoutSeconds: 150, maxInstances: 2 }, async (req) => {
  const who = await requireMember(req); // every active SmartRoute member

  const { start, end, stops, serviceSeconds = 90, traffic = true } = req.data || {};
  if (!validPoint(start)) throw new HttpsError('invalid-argument', 'נקודת התחלה לא תקינה');
  if (end && !validPoint(end)) throw new HttpsError('invalid-argument', 'נקודת סיום לא תקינה');
  if (!Array.isArray(stops) || !stops.length || stops.length > MAX_STOPS || !stops.every(validPoint)) {
    throw new HttpsError('invalid-argument', `צריך 1–${MAX_STOPS} עצירות עם קואורדינטות`);
  }

  // Daily limits (per role + global, set in the admin panel) and the shipments cap, per Israeli calendar day.
  await consumeQuota('routeOpt', who, {
    check: (q) => ((q.shipments || 0) + stops.length > DAILY_MAX_SHIPMENTS ? 'הגעת למכסה היומית של Google Route Optimization – משתמש במנוע החינמי' : null),
    inc: { shipments: stops.length },
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

// ------------------------------------------------------------------ screenshot import (Claude Vision)
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const EXTRACT_MODELS = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
const EXTRACT_EFFORT = 'medium';        // test 30/09: 'low' misread Hebrew names (שבח→שבב); 'medium' read them right for +4% cost
const ZOOM_EFFORT = 'low';              // zoom check: a few short lines per request
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMPORT_TTL_DAYS = 14;
const FIELDS = ['appOrder', 'shipmentId', 'name', 'street', 'houseNo', 'city', 'ref'];

const EXTRACT_PROMPT = `אתה קורא צילום מסך אחד מאפליקציית משלוחים ומחזיר את כל כרטיסי המשלוח שבו כ-JSON לפי הסכמה.

איך קוראים כל כרטיס:
- "מסירה <שם>" → name = הטקסט אחרי המילה "מסירה" (בלי המילה "מסירה"), בדיוק כפי שכתוב, עברית או אנגלית.
- המספר/הקוד הארוך ליד אייקון המשאית (למשל 19828497) → shipmentId. להעתיק תו-תו כפי שמופיע – ספרות, ואם יש גם אותיות לטיניות או מקף. בלי רווחים.
- שורת "יעד", למשל "#14 יעד: חולון שנקר 72":
  • appOrder = המספר שאחרי # (כאן 14). אם אין # (למשל כוכבית *) → 0.
  • city = המילה הראשונה אחרי "יעד:" (חולון).
  • houseNo = המספר בסוף השורה, כולל אות אם יש (12א).
  • street = כל מה שבין העיר למספר הבית (למשל "הגדוד העברי", "ז'בוטינסקי") – עם הגרש/המקף כפי שמופיע.
- "אס' 2: <ערך>" → ref. אם אין שורה כזו → "".
- yPct = גובה הקצה העליון של הכרטיס בצילום, באחוזים מגובה התמונה (0 = למעלה, 100 = למטה). hPct = גובה הכרטיס באחוזים.
- partial = true אם הכרטיס חתוך בקצה העליון או התחתון של הצילום ולא כל השדות שלו נראים.
- uncertain = רשימת השדות בכרטיס הזה שלא ניתן לקרוא בוודאות (טשטוש, חיתוך, ספרות דומות כמו 1/7 או 3/8). אם הכל ברור → [].

כללים:
- כרטיס אחד בפלט לכל כרטיס בצילום, לפי הסדר מלמעלה למטה. שני משלוחים לאותה כתובת = שני כרטיסים.
- לא להמציא: שדה שלא נראה בכלל → "" (או 0 ב-appOrder), ואם הכרטיס חתוך – השדה נכנס ל-uncertain.
- headerCount = המספר שמופיע בראש המסך ליד "מסירות" (למשל "36 מסירות"). אם לא מופיע בצילום → 0.
- note = הערה קצרה רק אם יש משהו חריג בצילום (אחרת "").`;

const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headerCount', 'note', 'cards'],
  properties: {
    headerCount: { type: 'integer' },
    note: { type: 'string' },
    cards: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [...FIELDS, 'yPct', 'hPct', 'partial', 'uncertain'],
        properties: {
          appOrder: { type: 'integer' },
          shipmentId: { type: 'string' },
          name: { type: 'string' },
          street: { type: 'string' },
          houseNo: { type: 'string' },
          city: { type: 'string' },
          ref: { type: 'string' },
          yPct: { type: 'integer' },
          hPct: { type: 'integer' },
          partial: { type: 'boolean' },
          uncertain: { type: 'array', items: { type: 'string', enum: FIELDS } },
        },
      },
    },
  },
};

const clampPct = (v) => Math.max(0, Math.min(100, Math.round(+v || 0)));
const EFFORTS = ['low', 'medium', 'high'];

// Zoom check: the name + destination lines of each card, cropped by the app from the screenshot it already read.
// A second, independent read of the Hebrew text (Opus) – the app marks every difference in yellow.
const ZOOM_FIELDS = ['name', 'city', 'street', 'houseNo'];
const MAX_STRIPS = 20, MAX_STRIP_BYTES = 400 * 1024;
const ZOOM_PROMPT = `כל תמונה היא רצועה מכרטיס משלוח אחד באפליקציית משלוחים, מסומנת במספר (i).
ברצועה יש שורה "מסירה <שם>" ומתחתיה שורת "יעד", למשל "#14 יעד: חולון שנקר 72".
לכל רצועה החזר:
- name = הטקסט אחרי המילה "מסירה", בדיוק אות-אות כפי שכתוב (עברית או אנגלית). שים לב במיוחד לאותיות דומות: ב/כ, ח/ה/ת, ד/ר, ו/ז/ן, ס/ם, א/ה.
- city = המילה הראשונה אחרי "יעד:". street = מה שבין העיר למספר הבית. houseNo = המספר בסוף השורה (כולל אות אם יש).
- unreadable = true אם הרצועה חתוכה או לא ניתן לקרוא אותה, ואז השדות שלא נראים → "".
לא לנחש ולא לתקן שמות לפי מה שנראה הגיוני – להעתיק את מה שכתוב.`;
const ZOOM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['cards'],
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['i', ...ZOOM_FIELDS, 'unreadable'],
        properties: { i: { type: 'integer' }, name: { type: 'string' }, city: { type: 'string' }, street: { type: 'string' }, houseNo: { type: 'string' }, unreadable: { type: 'boolean' } },
      },
    },
  },
};

async function askClaude({ modelId, effort, system, schema, content }) {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
  let res;
  try {
    res = await client.beta.messages.create({
      model: modelId,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      output_config: { effort, format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content }],
    });
  } catch (e) {
    console.error('extract failed', modelId, e.status, e.message);
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new HttpsError('failed-precondition', 'מפתח Anthropic לא תקין');
    if (e instanceof Anthropic.RateLimitError) throw new HttpsError('resource-exhausted', 'עומס זמני אצל Anthropic – נסה שוב בעוד דקה');
    if (e instanceof Anthropic.BadRequestError) throw new HttpsError('invalid-argument', 'Claude: ' + e.message);
    throw new HttpsError('unavailable', 'Claude לא זמין: ' + (e.message || e));
  }
  if (res.stop_reason === 'refusal') throw new HttpsError('aborted', 'Claude סירב לקרוא את הצילום');
  if (res.stop_reason === 'max_tokens') throw new HttpsError('aborted', 'התשובה נקטעה – נסה צילום עם פחות כרטיסים');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try { return { res, out: JSON.parse(text) }; } catch { throw new HttpsError('internal', 'תשובה לא תקינה מ-Claude'); }
}

async function zoomRead(who, { strips, model = 'opus', effort }) {
  const modelId = EXTRACT_MODELS[model];
  if (!modelId) throw new HttpsError('invalid-argument', 'מודל לא מוכר');
  if (!Array.isArray(strips) || !strips.length || strips.length > MAX_STRIPS) throw new HttpsError('invalid-argument', `צריך 1–${MAX_STRIPS} רצועות`);
  const ok = strips.every((s) => Number.isInteger(s?.i) && typeof s.data === 'string' && s.data.length <= MAX_STRIP_BYTES * 1.4 && /^[A-Za-z0-9+/=]+$/.test(s.data));
  if (!ok) throw new HttpsError('invalid-argument', 'רצועה לא תקינה');

  await consumeQuota('scanReads', who, { inc: { ['zoom_' + model]: 1 } });

  const content = strips.flatMap((s) => [
    { type: 'text', text: `רצועה i=${s.i}:` },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: s.data } },
  ]);
  content.push({ type: 'text', text: 'קרא את כל הרצועות.' });
  const { res, out } = await askClaude({ modelId, effort: EFFORTS.includes(effort) ? effort : ZOOM_EFFORT, system: ZOOM_PROMPT, schema: ZOOM_SCHEMA, content });
  const ids = new Set(strips.map((s) => s.i));
  return {
    model, kind: 'zoom', modelId: res.model,
    cards: (out.cards || []).filter((c) => ids.has(c.i)).map((c) => ({
      i: c.i, unreadable: !!c.unreadable, ...Object.fromEntries(ZOOM_FIELDS.map((f) => [f, String(c[f] ?? '').trim()])),
    })),
    usage: { input: res.usage?.input_tokens || 0, output: res.usage?.output_tokens || 0 },
  };
}

exports.extractShipments = onCall({ region: 'europe-west1', memory: '512MiB', timeoutSeconds: 180, maxInstances: 4, secrets: [ANTHROPIC_API_KEY] }, async (req) => {
  const who = await requireMember(req); // every active SmartRoute member

  if (req.data?.kind === 'zoom') return zoomRead(who, req.data);
  const { path, model = 'sonnet', effort } = req.data || {};
  const modelId = EXTRACT_MODELS[model];
  if (!modelId) throw new HttpsError('invalid-argument', 'מודל לא מוכר');
  // Only the caller's own import folder.
  const prefix = `labUsers/${req.auth.uid}/imports/`;
  if (typeof path !== 'string' || !path.startsWith(prefix) || path.includes('..')) throw new HttpsError('invalid-argument', 'נתיב צילום לא תקין');

  // Daily limits per role + global (admin panel ⚙️), counted per model too.
  await consumeQuota('scanReads', who, { inc: { [model]: 1 } });

  const file = getStorage().bucket().file(path);
  let meta, buf;
  try { [[meta], [buf]] = await Promise.all([file.getMetadata(), file.download()]); }
  catch { throw new HttpsError('not-found', 'הצילום לא נמצא באחסון'); }
  if (buf.length > MAX_IMAGE_BYTES) throw new HttpsError('invalid-argument', 'הצילום גדול מדי');
  const mediaType = ['image/jpeg', 'image/png', 'image/webp'].includes(meta.contentType) ? meta.contentType : 'image/jpeg';

  const { res, out } = await askClaude({
    modelId,
    effort: EFFORTS.includes(effort) ? effort : EXTRACT_EFFORT,
    system: EXTRACT_PROMPT,
    schema: EXTRACT_SCHEMA,
    content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } },
      { type: 'text', text: 'קרא את כל כרטיסי המשלוח בצילום הזה.' },
    ],
  });

  return {
    model,
    modelId: res.model,
    headerCount: out.headerCount || 0,
    note: out.note || '',
    cards: (out.cards || []).map((c) => ({
      ...Object.fromEntries(FIELDS.map((f) => [f, f === 'appOrder' ? (+c[f] || 0) : String(c[f] ?? '').trim()])),
      yPct: clampPct(c.yPct), hPct: clampPct(c.hPct) || 12, partial: !!c.partial,
      uncertain: (c.uncertain || []).filter((f) => FIELDS.includes(f)),
    })),
    usage: { input: res.usage?.input_tokens || 0, output: res.usage?.output_tokens || 0 },
  };
});

// Daily: delete import screenshots + records older than 14 days and unlink them from deliveries.
exports.cleanupImports = onSchedule({ schedule: 'every day 03:30', timeZone: 'Asia/Jerusalem', region: 'europe-west1' }, async () => {
  const db = getFirestore();
  const cutoff = Date.now() - IMPORT_TTL_DAYS * 86400000;
  let records = 0, files = 0;

  for (const user of await db.collection('labUsers').listDocuments()) {
    const old = await user.collection('imports').where('createdAt', '<', cutoff).get();
    for (const doc of old.docs) {
      const imp = doc.data();
      // Clear importSrc on the deliveries this import created (they may have moved or been deleted – ignore).
      const updates = (imp.rows || []).filter((r) => r.dayKey && r.shipmentId).map((r) =>
        user.collection('days').doc(r.dayKey).collection('deliveries').doc(String(r.shipmentId).replace(/\//g, '_'))
          .update({ importSrc: FieldValue.delete() }).catch(() => {}));
      await Promise.all(updates);
      await doc.ref.delete();
      records++;
    }
  }

  // Screenshots: by file age, so test uploads (model comparison) without a record are removed too.
  const [all] = await getStorage().bucket().getFiles({ prefix: 'labUsers/' });
  for (const f of all) {
    if (!f.name.includes('/imports/')) continue;
    if (new Date(f.metadata.timeCreated).getTime() < cutoff) { await f.delete().catch(() => {}); files++; }
  }
  console.log(`cleanupImports: ${records} records, ${files} files`);
});
