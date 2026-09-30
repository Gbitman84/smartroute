// Data layer. Firebase (Firestore + Google sign-in) is the source of truth.
// Without a Firebase config it falls back to a DEMO backend in this browser only.
import { firebaseConfig, appInfo } from './firebase-config.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2';
const ROOT = appInfo?.dataRoot || 'labUsers';   // SmartRoute user data: labUsers/{uid}/...
const safeId = (s) => String(s).replace(/\//g, '_').slice(0, 700);
const monthKey = () => new Date().toISOString().slice(0, 7);

// ---------------------------------------------------------------- Firebase
async function firebaseBackend(config) {
  const [{ initializeApp }, auth, fs] = await Promise.all([
    import(`${FB}/firebase-app.js`),
    import(`${FB}/firebase-auth.js`),
    import(`${FB}/firebase-firestore.js`),
  ]);
  const app = initializeApp(config);
  const a = auth.getAuth(app);
  const db = fs.initializeFirestore(app, {
    ignoreUndefinedProperties: true,
    localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
  });
  // ?emu=1 → local Firebase emulators (tests only; see tests/README.md). Never set in real use.
  if (new URLSearchParams(location.search).has('emu')) {
    auth.connectAuthEmulator(a, 'http://127.0.0.1:9099', { disableWarnings: true });
    fs.connectFirestoreEmulator(db, '127.0.0.1', 8080);
    // Test hook: sign in a seeded emulator test account (tests/seed.mjs) without the Google popup.
    window.__emuSignIn = (email, password) => auth.signInWithEmailAndPassword(a, email, password);
  }
  let uid = null;
  const u = (...p) => [db, ROOT, uid, ...p];
  const dayRef = (date) => fs.doc(...u('days', date));
  const delCol = (date) => fs.collection(...u('days', date, 'deliveries'));
  const delRef = (date, id) => fs.doc(...u('days', date, 'deliveries', safeId(id)));

  async function commitChunks(ops) {
    for (let i = 0; i < ops.length; i += 400) {
      const b = fs.writeBatch(db);
      ops.slice(i, i + 400).forEach((op) => op(b));
      await b.commit();
    }
  }

  return {
    mode: 'firebase',
    onAuth(cb) {
      auth.getRedirectResult(a).catch(() => {});
      return auth.onAuthStateChanged(a, (user) => { uid = user?.uid || null; cb(user ? { uid: user.uid, name: user.displayName, email: user.email, photo: user.photoURL } : null); });
    },
    async signIn() {
      const provider = new auth.GoogleAuthProvider();
      try { await auth.signInWithPopup(a, provider); }
      catch (e) {
        if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(e.code)) await auth.signInWithRedirect(a, provider);
        else throw e;
      }
    },
    signOut: () => auth.signOut(a),

    async listDays(max = 120) {
      const snap = await fs.getDocs(fs.query(fs.collection(...u('days')), fs.orderBy('date', 'desc'), fs.limit(max)));
      return snap.docs.map((d) => d.data());
    },
    async getDay(date) { const s = await fs.getDoc(dayRef(date)); return s.exists() ? s.data() : null; },
    saveDay: (key, patch) => fs.setDoc(dayRef(key), { date: key.slice(0, 10), ...patch, key, updatedAt: Date.now() }, { merge: true }),
    watchDay: (date, cb) => fs.onSnapshot(dayRef(date), (s) => cb(s.exists() ? s.data() : null)),
    watchDeliveries: (date, cb, onErr) => fs.onSnapshot(delCol(date), { includeMetadataChanges: true },
      (snap) => cb(snap.docs.map((d) => d.data()), { fromCache: snap.metadata.fromCache, pending: snap.metadata.hasPendingWrites }), onErr),
    async getDeliveries(date) { const s = await fs.getDocs(delCol(date)); return s.docs.map((d) => d.data()); },
    putDeliveries: (date, arr) => commitChunks(arr.map((d) => (b) => b.set(delRef(date, d.shipmentId), d, { merge: true }))),
    updateDelivery: (date, id, patch) => fs.updateDoc(delRef(date, id), patch),
    // Status change + one history entry, appended on the server so concurrent devices don't overwrite each other.
    appendHistory: (date, id, patch, entry) => fs.updateDoc(delRef(date, id), { ...patch, history: fs.arrayUnion(entry) }),
    updateMany: (date, list) => commitChunks(list.map(({ id, patch }) => (b) => b.update(delRef(date, id), patch))),
    deleteDeliveries: (date, ids) => commitChunks(ids.map((id) => (b) => b.delete(delRef(date, id)))),

    async getMeta(name) { const s = await fs.getDoc(fs.doc(...u('meta', name))); return s.exists() ? s.data() : null; },
    setMeta: (name, data) => fs.setDoc(fs.doc(...u('meta', name)), data, { merge: true }),
    async getGeo(key) { const s = await fs.getDoc(fs.doc(...u('geocache', safeId(key)))); return s.exists() ? s.data() : null; },
    setGeo: (key, val) => fs.setDoc(fs.doc(...u('geocache', safeId(key))), val),
    incUsage: (kind, n = 1) => fs.setDoc(fs.doc(...u('meta', 'usage-' + monthKey())), { [kind]: fs.increment(n), month: monthKey() }, { merge: true }),

    // Profile (the root <dataRoot>/{uid} doc) – read by the admin panel: who, last seen, last location.
    async touchProfile(user) {
      const ref = fs.doc(db, ROOT, uid);
      const cur = await fs.getDoc(ref).catch(() => null);
      const firstSeen = cur?.exists() ? cur.data().firstSeen : null;
      return fs.setDoc(ref, { uid, name: user.name || '', email: user.email || '', photo: user.photo || '', app: appInfo?.name || 'SmartRoute', lastSeen: Date.now(), firstSeen: firstSeen || Date.now() }, { merge: true });
    },
    saveProfile: (patch) => fs.setDoc(fs.doc(db, ROOT, uid), { ...patch, lastSeen: Date.now() }, { merge: true }),
    // Membership (members/{uid}): invite-only sign-up, role, enabled/disabled – see js/members.js.
    async getMember() { const s = await fs.getDoc(fs.doc(db, 'members', uid)); return s.exists() ? s.data() : null; },
    watchMember: (cb) => fs.onSnapshot(fs.doc(db, 'members', uid), (s) => cb(s.exists() ? s.data() : null), () => {}),
    createMember: (data) => fs.setDoc(fs.doc(db, 'members', uid), data),
    async getInvite(token) { const s = await fs.getDoc(fs.doc(db, 'invites', token)); return s.exists() ? s.data() : null; },
    // Personal referral codes (refs/{ref}, doc id = the ref).
    async myRefs() {
      const s = await fs.getDocs(fs.query(fs.collection(db, 'refs'), fs.where('owner', '==', uid)));
      return s.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
    // Create refs + set the main one in one batch (fails as a whole if a ref is already taken).
    async createMyRefs(refs, primaryRef) {
      const b = fs.writeBatch(db);
      refs.forEach((r) => b.set(fs.doc(db, 'refs', r.id), { owner: uid, kind: r.kind, label: r.label || '', active: true, leads: 0, createdAt: Date.now() }));
      b.update(fs.doc(db, 'members', uid), { primaryRef, updatedAt: Date.now() });
      await b.commit();
    },
    setPrimaryRef: (primaryRef) => fs.updateDoc(fs.doc(db, 'members', uid), { primaryRef, updatedAt: Date.now() }),
    // Google Route Optimization through the optimizeRoute Cloud Function.
    async optimize(payload) {
      const f = await import(`${FB}/firebase-functions.js`);
      const call = f.httpsCallable(f.getFunctions(app, appInfo?.functionsRegion || 'europe-west1'), 'optimizeRoute', { timeout: 160000 });
      return (await call(payload)).data;
    },

    // Screenshot import: photos live in Storage for 14 days, Claude reads them via extractShipments.
    async uploadImportPhoto(importId, n, blob) {
      const st = await storage();
      const path = `${ROOT}/${uid}/imports/${importId}/${n}.jpg`;
      await st.uploadBytes(st.ref(st.getStorage(app), path), blob, { contentType: blob.type || 'image/jpeg' });
      return path;
    },
    async photoUrl(path) { const st = await storage(); return st.getDownloadURL(st.ref(st.getStorage(app), path)); },
    async deleteImportPhotos(paths) { const st = await storage(); await Promise.all(paths.map((p) => st.deleteObject(st.ref(st.getStorage(app), p)).catch(() => {}))); },
    async extract(payload) {
      const f = await import(`${FB}/firebase-functions.js`);
      const call = f.httpsCallable(f.getFunctions(app, appInfo?.functionsRegion || 'europe-west1'), 'extractShipments', { timeout: 190000 });
      return (await call(payload)).data;
    },
    saveImport: (id, data) => fs.setDoc(fs.doc(...u('imports', id)), data, { merge: true }),
    async getImport(id) { const s = await fs.getDoc(fs.doc(...u('imports', id))); return s.exists() ? s.data() : null; },
  };
}
let storageMod = null;
const storage = () => (storageMod ||= import(`${FB}/firebase-storage.js`));

// ---------------------------------------------------------------- Demo (this browser only)
function demoBackend() {
  const KEY = 'smartroute.demo.v1';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  let st = Object.assign({ days: {}, meta: {}, geo: {} }, load());
  const dayW = new Map(), delW = new Map(), photos = new Map();
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* ignore */ } };
  const day = (date) => (st.days[date] ||= { doc: null, deliveries: {} });
  const notify = (date) => {
    queueMicrotask(() => {
      const d = st.days[date];
      (dayW.get(date) || []).forEach((cb) => cb(d?.doc ? clone(d.doc) : null));
      (delW.get(date) || []).forEach((cb) => cb(d ? clone(Object.values(d.deliveries)) : [], { fromCache: false, pending: false }));
    });
  };
  const watch = (map, date, cb) => {
    if (!map.has(date)) map.set(date, new Set());
    map.get(date).add(cb); notify(date);
    return () => map.get(date).delete(cb);
  };
  const write = (date, fn) => { fn(day(date)); save(); notify(date); return Promise.resolve(); };

  return {
    mode: 'demo',
    onAuth(cb) { setTimeout(() => cb({ uid: 'demo', name: 'מצב הדגמה', email: '' }), 0); return () => {}; },
    signIn: async () => {}, signOut: async () => {},
    listDays: async () => Object.values(st.days).map((d) => d.doc).filter(Boolean).sort((a, b) => b.date.localeCompare(a.date)),
    getDay: async (date) => (st.days[date]?.doc ? clone(st.days[date].doc) : null),
    saveDay: (key, patch) => write(key, (d) => { d.doc = { date: key.slice(0, 10), ...(d.doc || {}), ...clone(patch), key, updatedAt: Date.now() }; }),
    watchDay: (date, cb) => watch(dayW, date, cb),
    watchDeliveries: (date, cb) => watch(delW, date, cb),
    getDeliveries: async (date) => clone(Object.values(st.days[date]?.deliveries || {})),
    putDeliveries: (date, arr) => write(date, (d) => arr.forEach((x) => { d.deliveries[x.shipmentId] = { ...(d.deliveries[x.shipmentId] || {}), ...clone(x) }; })),
    updateDelivery: (date, id, patch) => write(date, (d) => { if (d.deliveries[id]) Object.assign(d.deliveries[id], clone(patch)); }),
    appendHistory: (date, id, patch, entry) => write(date, (d) => {
      const x = d.deliveries[id];
      if (x) Object.assign(x, clone(patch), { history: [...(x.history || []), clone(entry)] });
    }),
    updateMany: (date, list) => write(date, (d) => list.forEach(({ id, patch }) => { if (d.deliveries[id]) Object.assign(d.deliveries[id], clone(patch)); })),
    deleteDeliveries: (date, ids) => write(date, (d) => ids.forEach((id) => delete d.deliveries[id])),
    getMeta: async (name) => (st.meta[name] ? clone(st.meta[name]) : null),
    setMeta: async (name, data) => { st.meta[name] = { ...(st.meta[name] || {}), ...clone(data) }; save(); },
    getGeo: async (key) => st.geo[key] || null,
    setGeo: async (key, val) => { st.geo[key] = val; save(); },
    incUsage: async (kind, n = 1) => { const k = 'usage-' + monthKey(); st.meta[k] ||= { month: monthKey() }; st.meta[k][kind] = (st.meta[k][kind] || 0) + n; save(); },
    touchProfile: async () => {}, saveProfile: async () => {},
    // Demo membership: always a member (?demo=1&nouser=1 → "user doesn't exist"; add &invite=… to test joining).
    getMember: async () => (new URLSearchParams(location.search).has('nouser') ? null : (st.member ||= { uid: 'demo', role: 'user', disabled: false, refSuffix: 'd87d32', invitedBy: 'demo-admin' })),
    watchMember: (cb) => { setTimeout(() => cb(st.member || null), 0); return () => {}; },
    createMember: async (data) => { st.member = clone(data); save(); },
    getInvite: async (token) => (token ? { owner: 'demo-admin', ownerName: 'מנהל הדגמה', active: true } : null),
    myRefs: async () => clone(st.refs || []),
    async createMyRefs(refs, primaryRef) {
      st.refs = [...(st.refs || []), ...refs.map((r) => ({ ...r, owner: 'demo', active: true, leads: r.kind === 'name' ? 3 : 1, createdAt: Date.now() }))];
      st.member = { ...(st.member || {}), primaryRef }; save();
    },
    setPrimaryRef: async (primaryRef) => { st.member = { ...(st.member || {}), primaryRef }; save(); },
    // Screenshot import: photos stay in memory only. Reading needs the Cloud Function (Firebase);
    // for local UI tests a page may define window.__smartrouteMockExtract(payload, blob).
    async uploadImportPhoto(importId, n, blob) { const path = `demo/imports/${importId}/${n}.jpg`; photos.set(path, blob); return path; },
    photoUrl: async (path) => (photos.has(path) ? URL.createObjectURL(photos.get(path)) : null),
    deleteImportPhotos: async (paths) => paths.forEach((p) => photos.delete(p)),
    async extract(payload) {
      if (typeof window.__smartrouteMockExtract !== 'function') throw new Error('קריאת צילומים דורשת חיבור ל-Firebase (לא זמין במצב הדגמה)');
      return window.__smartrouteMockExtract(payload, photos.get(payload.path));
    },
    saveImport: async (id, data) => { (st.imports ||= {})[id] = { ...(st.imports[id] || {}), ...clone(data) }; save(); },
    getImport: async (id) => (st.imports?.[id] ? clone(st.imports[id]) : null),
  };
}

export async function createDb() {
  // ?demo=1 → local test mode (this browser only), without touching the cloud.
  const forceDemo = new URLSearchParams(location.search).has('demo');
  if (!forceDemo && firebaseConfig && firebaseConfig.apiKey) {
    try { return await firebaseBackend(firebaseConfig); }
    catch (e) { console.error('Firebase init failed', e); throw e; }
  }
  return demoBackend();
}
