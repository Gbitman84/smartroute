// Who may call the SmartRoute functions, and how often.
// - Every active SmartRoute member may use every function (members/{uid} exists and is not disabled);
//   the superadmin (by email, same as firestore.rules) always may.
// - Daily limits per role come from config/limits, set by the superadmin in the admin panel:
//     { roles: { super: {routeOpt, scanReads}, admin: {...}, user: {...}, <future roles>... },
//       global: {routeOpt, scanReads} }
//   A number caps the day (0 = blocked); an empty value = no role cap (the global cap still applies).
// - Usage is counted per Israeli calendar day in quota/<kind>-<day>: the total, users.<uid> and roles.<role>.
const { HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const SUPERADMIN = 'gbitman.bd@gmail.com';
const KINDS = {
  routeOpt: { doc: 'routeopt', total: 'requests', label: 'בניית מסלול חכם' },
  scanReads: { doc: 'extract', total: 'reads', label: 'קריאת צילומים' },
};
// Starting values: every role gets what the superadmin had (40 smart routes, 120 screenshot reads a day).
const DEFAULT_LIMITS = {
  roles: { super: { routeOpt: 40, scanReads: 120 }, admin: { routeOpt: 40, scanReads: 120 }, user: { routeOpt: 40, scanReads: 120 } },
  global: { routeOpt: 40, scanReads: 120 },
};

const israelDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
const capOf = (v) => (v === '' || v == null || !Number.isFinite(+v) ? Infinity : Math.max(0, Math.floor(+v)));

// Pure: may one more `kind` call happen? usage = { total, byUser, byRole }.
function checkLimit(kind, role, usage, limits = DEFAULT_LIMITS) {
  const roleLimits = limits?.roles?.[role] ?? limits?.roles?.user ?? {};
  const roleCap = capOf(roleLimits[kind]);
  const globalCap = capOf(limits?.global?.[kind]);
  if ((usage.byUser || 0) + 1 > roleCap) return { ok: false, reason: 'role', cap: roleCap };
  if ((usage.total || 0) + 1 > globalCap) return { ok: false, reason: 'global', cap: globalCap };
  return { ok: true };
}

let cached = null, cachedAt = 0;
async function getLimits() {
  if (cached && Date.now() - cachedAt < 60000) return cached;
  const snap = await getFirestore().doc('config/limits').get().catch(() => null);
  const data = snap?.exists ? snap.data() : null;
  cached = data?.roles ? { roles: { ...DEFAULT_LIMITS.roles, ...data.roles }, global: { ...DEFAULT_LIMITS.global, ...(data.global || {}) } } : DEFAULT_LIMITS;
  cachedAt = Date.now();
  return cached;
}

// → { uid, email, role } for an active member, otherwise permission-denied.
async function requireMember(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'יש להתחבר');
  const { uid } = req.auth;
  const email = String(req.auth.token?.email || '').toLowerCase();
  if (email === SUPERADMIN && req.auth.token?.email_verified) return { uid, email, role: 'super' };
  const m = await getFirestore().doc(`members/${uid}`).get();
  if (!m.exists || m.data().disabled === true) throw new HttpsError('permission-denied', 'אין הרשאה – המשתמש אינו פעיל ב-SmartRoute');
  return { uid, email, role: m.data().role || 'user' };
}

// Check the caller's role limit + the global cap and count one use, in one transaction.
// extra: { check(q) → error message | null, inc: {field: n} } for kind-specific caps (e.g. shipments).
async function consumeQuota(kind, who, extra = {}) {
  const k = KINDS[kind];
  const limits = await getLimits();
  const ref = getFirestore().doc(`quota/${k.doc}-${israelDay()}`);
  await getFirestore().runTransaction(async (tx) => {
    const q = (await tx.get(ref)).data() || {};
    const usage = { total: q[k.total] || 0, byUser: q.users?.[who.uid] || 0, byRole: q.roles?.[who.role] || 0 };
    const res = checkLimit(kind, who.role, usage, limits);
    if (!res.ok) {
      throw new HttpsError('resource-exhausted', res.reason === 'role'
        ? `הגעת למגבלה היומית של התפקיד שלך (${k.label}: ${res.cap} ביום)`
        : `הגעת למכסה היומית הכללית (${k.label})`);
    }
    const extraErr = extra.check?.(q);
    if (extraErr) throw new HttpsError('resource-exhausted', extraErr);
    const inc = { [k.total]: FieldValue.increment(1), updatedAt: Date.now() };
    for (const [f, n] of Object.entries(extra.inc || {})) inc[f] = FieldValue.increment(n);
    tx.set(ref, { ...inc, users: { [who.uid]: FieldValue.increment(1) }, roles: { [who.role]: FieldValue.increment(1) } }, { merge: true });
  });
}

module.exports = { SUPERADMIN, KINDS, DEFAULT_LIMITS, checkLimit, getLimits, requireMember, consumeQuota, israelDay };
