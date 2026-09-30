// Seeds the LOCAL Firebase emulator with test personas and data (never the real project).
// Run: npm run emulators (separate window), then: npm run seed      (add --load for 25 extra users × 30 days)
// Test accounts exist only in the emulator; sign in from a page opened with ?emu=1:
//   await window.__emuSignIn('<email>', PASSWORD)
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';
const { initializeApp } = await import('firebase-admin/app');
const { getAuth } = await import('firebase-admin/auth');
const { getFirestore, Timestamp } = await import('firebase-admin/firestore');

export const PASSWORD = 'emu-test-only-1'; // emulator test accounts only
initializeApp({ projectId: 'smartrun-gbit' });
const auth = getAuth();
const db = getFirestore();
const LOAD = process.argv.includes('--load');

const israelDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
const TODAY = israelDay();
const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const H = 3600000, now = Date.now();

export const PERSONAS = {
  sa:  { email: 'gbitman.bd@gmail.com', name: 'Gil Bitman', member: { role: 'user', invitedBy: 'superadmin', refSuffix: 'aaaaaa', primaryRef: 'gil-aaaaaa' } },
  adA: { email: 'admin.a@test.local', name: 'Adi Admin', member: { role: 'admin', invitedBy: 'sa', inviteToken: 'TokenSuper0000000000001', refSuffix: 'bbbbbb' } },
  adB: { email: 'admin.b@test.local', name: 'Bar Admin', member: { role: 'admin', invitedBy: 'sa', inviteToken: 'TokenSuper0000000000001', refSuffix: 'bbbbbc' } },
  u1:  { email: 'user1@test.local', name: 'Uri One', member: { role: 'user', invitedBy: 'adA', inviteToken: 'TokenAdminA000000000001', refSuffix: 'cccccc' } },
  u2:  { email: 'user2@test.local', name: 'Tal Two', member: { role: 'user', invitedBy: 'sa', inviteToken: 'TokenSuper0000000000001', refSuffix: 'dddddd' } },
  u3:  { email: 'user3@test.local', name: 'Dan Disabled', member: { role: 'user', invitedBy: 'adA', inviteToken: 'TokenAdminA000000000001', refSuffix: 'eeeeee', disabled: true, note: 'בדיקת השבתה' } },
  str: { email: 'stranger@test.local', name: 'Sara Stranger', member: null },
  nw:  { email: 'newbie@test.local', name: 'Noa New', member: null }, // joins during the test with a magic link
};

async function wipe() {
  const { users } = await auth.listUsers(1000);
  if (users.length) await auth.deleteUsers(users.map((u) => u.uid));
  await fetch('http://127.0.0.1:8080/emulator/v1/projects/smartrun-gbit/databases/(default)/documents', { method: 'DELETE' });
}

async function batchWrite(ops) {
  for (let i = 0; i < ops.length; i += 450) {
    const b = db.batch();
    ops.slice(i, i + 450).forEach(([ref, data]) => b.set(ref, data));
    await b.commit();
  }
}

const STREETS = ['סוקולוב', 'ההסתדרות', 'שנקר', 'הנוטרים', 'ויצמן', 'קוגל', 'אילת', 'המעפילים', 'גולדה מאיר', 'פילדלפיה'];
function deliveriesFor(n, doneN, dayMs) {
  return Array.from({ length: n }, (_, i) => {
    const done = i < doneN;
    const at = dayMs + (8 * 60 + i * 9) * 60000;
    return {
      shipmentId: String(19800000 + i + Math.floor(Math.random() * 90000)), name: `לקוח ${i + 1}`,
      street: STREETS[i % STREETS.length], houseNo: String(3 + i), city: 'חולון', appOrder: i + 1, ref: null,
      lat: 32.005 + (i % 7) * 0.003, lng: 34.765 + Math.floor(i / 7) * 0.004, geoStatus: 'ok',
      status: done ? (i % 9 === 0 ? 'no_answer_final' : 'delivered_hand') : 'pending', statusAt: done ? at : null,
      history: done ? [{ id: `s${i}`, status: i % 9 === 0 ? 'no_answer_final' : 'delivered_hand', at }] : [],
      initialStop: i + 1, initialSub: null, updatedStop: done ? null : i + 1, updatedSub: null, importedAt: dayMs,
    };
  });
}
function statsOf(ds) {
  const c = (...s) => ds.filter((d) => s.includes(d.status)).length;
  const doneAt = ds.filter((d) => d.statusAt).map((d) => d.statusAt);
  const delivered = c('delivered_hand', 'delivered_door'), noAnswer = c('no_answer_final'), temp = c('no_answer_temp');
  return { total: ds.length, delivered, noAnswer, temp, pending: ds.length - delivered - noAnswer - temp, moved: 0,
    firstDoneAt: doneAt.length ? Math.min(...doneAt) : null, lastDoneAt: doneAt.length ? Math.max(...doneAt) : null };
}

async function workHistory(uid, days, { todayDone = null } = {}) {
  const ops = [];
  for (let i = days; i >= 0; i--) {
    const date = addDays(TODAY, -i);
    if (new Date(date + 'T12:00:00').getDay() === 6) continue; // no Saturdays
    if (i === 0 && todayDone == null) continue;
    const dayMs = new Date(date + 'T00:00:00+03:00').getTime();
    const n = 20 + ((uid.length * 7 + i * 3) % 18);
    const ds = deliveriesFor(n, i === 0 ? todayDone : n, dayMs);
    const withStats = i < 20; // older days without stats → the panel counts them from the deliveries
    ops.push([db.doc(`labUsers/${uid}/days/${date}`), { date, key: date, version: 1, total: n, active: ds.filter((d) => d.status === 'pending').length,
      hasInitialRoute: true, initialBuiltAt: dayMs + 7.5 * H, updatedAt: dayMs + 12 * H, ...(withStats ? { stats: statsOf(ds) } : {}) }]);
    ds.forEach((d) => ops.push([db.doc(`labUsers/${uid}/days/${date}/deliveries/${d.shipmentId}`), d]));
  }
  await batchWrite(ops);
}

await wipe();
const uids = {};
for (const [key, p] of Object.entries(PERSONAS)) {
  const u = await auth.createUser({ uid: key, email: p.email, emailVerified: true, password: PASSWORD, displayName: p.name });
  uids[key] = u.uid;
}
const ops = [];
for (const [uid, p] of Object.entries(PERSONAS)) {
  if (p.member) ops.push([db.doc(`members/${uid}`), { uid, name: p.name, email: p.email, disabled: false, joinedAt: now - 20 * 24 * H, ...p.member }]);
  if (p.member) ops.push([db.doc(`labUsers/${uid}`), { uid, name: p.name, email: p.email, photo: '', app: 'SmartRoute', firstSeen: now - 20 * 24 * H, lastSeen: now - 5 * 60000,
    ...(uid === 'u1' || uid === 'u2' ? { lastLocation: { lat: 32.012, lng: 34.775, accuracy: 15, at: now - 5 * 60000 } } : {}) }]);
}
ops.push([db.doc('invites/TokenSuper0000000000001'), { owner: 'sa', ownerName: 'Gil Bitman', active: true, createdAt: now - 30 * 24 * H }]);
ops.push([db.doc('invites/TokenAdminA000000000001'), { owner: 'adA', ownerName: 'Adi Admin', active: true, createdAt: now - 20 * 24 * H }]);
const ref = (id, owner, kind, label = '') => ops.push([db.doc(`refs/${id}`), { owner, kind, label, active: true, leads: 0, createdAt: now - 10 * 24 * H }]);
ref('gil-aaaaaa', 'sa', 'name'); ref('gbitman.bd-aaaaaa', 'sa', 'email'); ref('gil-fb-a', 'sa', 'custom', 'Facebook A'); ref('gil-fb-b', 'sa', 'custom', 'Facebook B');
ref('uri-cccccc', 'u1', 'name');
const regs = [
  ['אורי שלום', '0521234567', 'gil-aaaaaa', 1], ['Tamar B', '0547654321', 'gil-fb-a', 3], ['שי מזרחי', '0501112233', 'gil-fb-a', 26],
  ['נוי כהן', '0587778899', '', 50], ['ליאור', '0533334444', 'uri-cccccc', 5], ['דוד פרץ', '0529990000', 'gil-fb-b', 70],
  ['רחל', '0506665555', 'gil-aaaaaa', 30], ['אנונימי', '0501231231', 'someone', 8], ['אורי שלום', '0521234567', 'gil-fb-b', 2],
  ['מיכל', '0541112222', 'GIL-FB-A', 12], ['Test Lead', '0550000001', '', 40], ['עומר', '0523334455', 'gil-fb-a', 15],
];
regs.forEach(([name, mobile, r, hoursAgo], i) => ops.push([db.doc(`registrations/r${i + 1}`),
  { name, mobile, ref: r, source: r ? 'link' : 'manual', createdAt: Timestamp.fromMillis(now - hoursAgo * H), status: i === 3 ? 'joined' : i === 5 ? 'rejected' : 'new' }]));
await batchWrite(ops);

await workHistory('u1', 30, { todayDone: 6 });
await workHistory('u2', 30, { todayDone: 3 });

if (LOAD) {
  for (let k = 1; k <= 25; k++) {
    const uid = `load${String(k).padStart(2, '0')}`;
    await batchWrite([
      [db.doc(`members/${uid}`), { uid, name: `עומס ${k}`, email: `${uid}@test.local`, role: 'user', disabled: false, invitedBy: 'adA', joinedAt: now, refSuffix: `l${String(k).padStart(5, '0')}` }],
      [db.doc(`labUsers/${uid}`), { uid, name: `עומס ${k}`, email: `${uid}@test.local`, lastSeen: now - k * 60000 }],
    ]);
    await workHistory(uid, 30, { todayDone: k % 4 === 0 ? null : k % 20 });
  }
}
console.log(`Seeded emulator: ${Object.keys(uids).length} test accounts${LOAD ? ' + 25 load users × 30 days' : ''}, today = ${TODAY}`);
process.exit(0);
