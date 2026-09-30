// Permission tests for firestore.rules + storage.rules against the local emulator.
// Run: npm run emulators (separate window), then: npm run rules
// Each case: who does what → expected allow / deny. Results: console table + results/rules.json.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, query, where, writeBatch, serverTimestamp,
} from 'firebase/firestore';
import { ref as sref, uploadBytes, getBytes } from 'firebase/storage';

const PROJECT = 'smartrun-gbit';
const env = await initializeTestEnvironment({
  projectId: PROJECT,
  firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8080 },
  storage: { rules: readFileSync(new URL('../storage.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 9199 },
});

// ---------------------------------------------------------------- personas
const P = {
  sa: { uid: 'sa', email: 'gbitman.bd@gmail.com' },           // superadmin (by email)
  adA: { uid: 'adA', email: 'admin.a@test.local' },            // admin
  adB: { uid: 'adB', email: 'admin.b@test.local' },            // admin
  adD: { uid: 'adD', email: 'admin.off@test.local' },          // admin, disabled
  u1: { uid: 'u1', email: 'user1@test.local' },                // user invited by adA
  u2: { uid: 'u2', email: 'user2@test.local' },                // user invited by sa
  u3: { uid: 'u3', email: 'user3@test.local' },                // user, disabled
  str: { uid: 'str', email: 'stranger@test.local' },           // Google account, not a member
};
const fsAs = (p) => (p ? env.authenticatedContext(p.uid, { email: p.email, email_verified: true }) : env.unauthenticatedContext()).firestore();
const stAs = (p) => (p ? env.authenticatedContext(p.uid, { email: p.email, email_verified: true }) : env.unauthenticatedContext()).storage();

const TOKEN_A = 'TokenAdminA000000000001', TOKEN_OFF = 'TokenAdminAOff000000001', TOKEN_SA = 'TokenSuper0000000000001';
const DAY = '2026-09-30';
const reg = (o = {}) => ({ name: 'ישראל ישראלי', mobile: '0501234567', ref: 'u1name-cccccc', source: 'link', createdAt: serverTimestamp(), status: 'new', ...o });

async function seed() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const m = (uid, o) => setDoc(doc(db, 'members', uid), { uid, role: 'user', disabled: false, name: uid, email: P[uid]?.email || '', joinedAt: 1, ...o });
    await m('sa', { invitedBy: 'superadmin', refSuffix: 'aaaaaa' });
    await m('adA', { role: 'admin', invitedBy: 'sa', refSuffix: 'bbbbbb' });
    await m('adB', { role: 'admin', invitedBy: 'sa', refSuffix: 'bbbbbc' });
    await m('adD', { role: 'admin', invitedBy: 'sa', refSuffix: 'bbbbbd', disabled: true });
    await m('u1', { invitedBy: 'adA', inviteToken: TOKEN_A, refSuffix: 'cccccc', primaryRef: 'u1name-cccccc' });
    await m('u2', { invitedBy: 'sa', inviteToken: TOKEN_SA, refSuffix: 'dddddd' });
    await m('u3', { invitedBy: 'adA', inviteToken: TOKEN_A, refSuffix: 'eeeeee', disabled: true });
    await setDoc(doc(db, 'invites', TOKEN_A), { owner: 'adA', ownerName: 'Admin A', active: true, createdAt: 1 });
    await setDoc(doc(db, 'invites', TOKEN_OFF), { owner: 'adA', ownerName: 'Admin A', active: false, createdAt: 1 });
    await setDoc(doc(db, 'invites', TOKEN_SA), { owner: 'sa', ownerName: 'Gil', active: true, createdAt: 1 });
    await setDoc(doc(db, 'refs', 'u1name-cccccc'), { owner: 'u1', kind: 'name', label: '', active: true, leads: 0, createdAt: 1 });
    await setDoc(doc(db, 'refs', 'gil-fb-a'), { owner: 'sa', kind: 'custom', label: 'FB A', active: true, leads: 2, createdAt: 1 });
    for (const uid of ['u1', 'u2', 'u3', 'str']) {
      await setDoc(doc(db, 'labUsers', uid), { uid, name: uid });
      await setDoc(doc(db, 'labUsers', uid, 'days', DAY), { date: DAY, key: DAY, total: 1 });
      await setDoc(doc(db, 'labUsers', uid, 'days', DAY, 'deliveries', 'd1'), { shipmentId: 'd1', status: 'pending' });
    }
    await setDoc(doc(db, 'users', 'u1'), { name: 'u1' }); // old SmartRun data – must be unreachable
    await setDoc(doc(db, 'access', 'u1'), { disabled: false });
    await setDoc(doc(db, 'registrations', 'r1'), { ...reg(), createdAt: new Date() });
    await setDoc(doc(db, 'config', 'limits'), { roles: { user: { routeOpt: 40, scanReads: 120 } }, global: { routeOpt: 40, scanReads: 120 } });
    await setDoc(doc(db, 'quota', `routeopt-${DAY}`), { requests: 1 });
  });
  await env.clearStorage();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await uploadBytes(sref(ctx.storage(), 'labUsers/u1/imports/i1/1.jpg'), new Uint8Array([1, 2, 3]), { contentType: 'image/jpeg' });
  });
}

// ---------------------------------------------------------------- harness
const results = [];
async function t(area, name, expect, fn) {
  let ok, error = '';
  try {
    await (expect === 'allow' ? assertSucceeds(fn()) : assertFails(fn()));
    ok = true;
  } catch (e) { ok = false; error = String(e?.message || e).split('\n')[0].slice(0, 160); }
  results.push({ area, name, expect, pass: ok, error });
  process.stdout.write(ok ? '.' : 'F');
}
const lab = (db, uid, ...p) => doc(db, 'labUsers', uid, 'days', DAY, ...p);
const join = (o = {}) => ({ uid: 'nw', role: 'user', disabled: false, name: 'New', email: 'new@test.local', joinedAt: 1, invitedBy: 'adA', inviteToken: TOKEN_A, refSuffix: 'ffffff', ...o });
const asNew = () => fsAs({ uid: 'nw', email: 'new@test.local' });

await seed();

// ---------------------------------------------------------------- SmartRoute data (labUsers)
await t('labUsers', 'user reads own day', 'allow', () => getDoc(lab(fsAs(P.u1), 'u1')));
await t('labUsers', 'user writes own delivery', 'allow', () => updateDoc(lab(fsAs(P.u1), 'u1', 'deliveries', 'd1'), { status: 'delivered_hand' }));
await t('labUsers', 'user reads another user', 'deny', () => getDoc(lab(fsAs(P.u2), 'u1')));
await t('labUsers', 'user writes another user', 'deny', () => updateDoc(lab(fsAs(P.u2), 'u1', 'deliveries', 'd1'), { status: 'x' }));
await t('labUsers', 'admin reads a user', 'allow', () => getDoc(lab(fsAs(P.adA), 'u1')));
await t('labUsers', 'admin writes a user', 'deny', () => updateDoc(lab(fsAs(P.adA), 'u1', 'deliveries', 'd1'), { status: 'x' }));
await t('labUsers', 'disabled user reads own', 'deny', () => getDoc(lab(fsAs(P.u3), 'u3')));
await t('labUsers', 'disabled user writes own', 'deny', () => updateDoc(lab(fsAs(P.u3), 'u3', 'deliveries', 'd1'), { status: 'x' }));
await t('labUsers', 'non-member reads own path', 'deny', () => getDoc(lab(fsAs(P.str), 'str')));
await t('labUsers', 'non-member writes own path', 'deny', () => setDoc(doc(fsAs(P.str), 'labUsers', 'str'), { name: 'x' }));
await t('labUsers', 'anonymous reads a user', 'deny', () => getDoc(lab(fsAs(null), 'u1')));
await t('labUsers', 'disabled admin reads a user', 'deny', () => getDoc(lab(fsAs(P.adD), 'u1')));
await t('labUsers', 'superadmin reads a user', 'allow', () => getDoc(lab(fsAs(P.sa), 'u1')));
await t('labUsers', 'superadmin deletes a user delivery', 'allow', () => deleteDoc(lab(fsAs(P.sa), 'u2', 'deliveries', 'd1')));
await t('labUsers', 'admin deletes a user delivery', 'deny', () => deleteDoc(lab(fsAs(P.adA), 'u1', 'deliveries', 'd1')));
await t('labUsers', 'user deletes own delivery', 'allow', () => deleteDoc(lab(fsAs(P.u1), 'u1', 'deliveries', 'd1')));
await t('labUsers', 'admin lists all profiles', 'allow', () => getDocs(collection(fsAs(P.adA), 'labUsers')));
await t('labUsers', 'user lists all profiles', 'deny', () => getDocs(collection(fsAs(P.u1), 'labUsers')));

// ---------------------------------------------------------------- old SmartRun paths: closed to everyone
await t('old SmartRun paths', 'owner reads users/own', 'deny', () => getDoc(doc(fsAs(P.u1), 'users', 'u1')));
await t('old SmartRun paths', 'owner writes users/own', 'deny', () => setDoc(doc(fsAs(P.u1), 'users', 'u1'), { name: 'x' }));
await t('old SmartRun paths', 'superadmin reads users/*', 'deny', () => getDoc(doc(fsAs(P.sa), 'users', 'u1')));
await t('old SmartRun paths', 'superadmin reads access/*', 'deny', () => getDoc(doc(fsAs(P.sa), 'access', 'u1')));

// ---------------------------------------------------------------- members: joining with a magic link
await t('members/join', 'join with an active link', 'allow', () => setDoc(doc(asNew(), 'members', 'nw'), join()));
await env.withSecurityRulesDisabled((ctx) => deleteDoc(doc(ctx.firestore(), 'members', 'nw')));
await t('members/join', 'join with an inactive link', 'deny', () => setDoc(doc(asNew(), 'members', 'nw'), join({ inviteToken: TOKEN_OFF })));
await t('members/join', 'join with a non-existent link', 'deny', () => setDoc(doc(asNew(), 'members', 'nw'), join({ inviteToken: 'NoSuchToken000000000001' })));
await t('members/join', 'join as admin', 'deny', () => setDoc(doc(asNew(), 'members', 'nw'), join({ role: 'admin' })));
await t('members/join', 'join credited to someone else', 'deny', () => setDoc(doc(asNew(), 'members', 'nw'), join({ invitedBy: 'sa' })));
await t('members/join', 'join with an extra field', 'deny', () => setDoc(doc(asNew(), 'members', 'nw'), join({ primaryRef: 'x' })));
await t('members/join', 'join already disabled=false only', 'deny', () => setDoc(doc(asNew(), 'members', 'nw'), join({ disabled: true })));
await t('members/join', 'join with a bad refSuffix', 'deny', () => setDoc(doc(asNew(), 'members', 'nw'), join({ refSuffix: 'ABC' })));
await t('members/join', 'join for another uid', 'deny', () => setDoc(doc(asNew(), 'members', 'other'), join({ uid: 'other' })));
await t('members/join', 'join without sign-in', 'deny', () => setDoc(doc(fsAs(null), 'members', 'nw'), join()));

// ---------------------------------------------------------------- members: reading & managing
await t('members', 'user reads own record', 'allow', () => getDoc(doc(fsAs(P.u1), 'members', 'u1')));
await t('members', 'disabled user reads own record (to see the message)', 'allow', () => getDoc(doc(fsAs(P.u3), 'members', 'u3')));
await t('members', 'user reads another record', 'deny', () => getDoc(doc(fsAs(P.u1), 'members', 'u2')));
await t('members', 'user lists members', 'deny', () => getDocs(collection(fsAs(P.u1), 'members')));
await t('members', 'admin lists members', 'allow', () => getDocs(collection(fsAs(P.adA), 'members')));
await t('members', 'disabled admin lists members', 'deny', () => getDocs(collection(fsAs(P.adD), 'members')));
await t('members', 'admin disables a user', 'allow', () => updateDoc(doc(fsAs(P.adA), 'members', 'u2'), { disabled: true, note: 'x', updatedAt: 2, updatedBy: 'a' }));
await t('members', 'admin disables an admin', 'deny', () => updateDoc(doc(fsAs(P.adA), 'members', 'adB'), { disabled: true }));
await t('members', 'admin disables themselves', 'deny', () => updateDoc(doc(fsAs(P.adA), 'members', 'adA'), { disabled: true }));
await t('members', 'admin makes a user admin', 'deny', () => updateDoc(doc(fsAs(P.adA), 'members', 'u1'), { role: 'admin' }));
await t('members', 'admin deletes a user', 'deny', () => deleteDoc(doc(fsAs(P.adA), 'members', 'u1')));
await t('members', 'user makes themselves admin', 'deny', () => updateDoc(doc(fsAs(P.u1), 'members', 'u1'), { role: 'admin' }));
await t('members', 'user re-enables themselves', 'deny', () => updateDoc(doc(fsAs(P.u3), 'members', 'u3'), { disabled: false }));
await t('members', 'user picks own ref as main', 'allow', () => updateDoc(doc(fsAs(P.u1), 'members', 'u1'), { primaryRef: 'u1name-cccccc', updatedAt: 3 }));
await t('members', "user picks someone else's ref", 'deny', () => updateDoc(doc(fsAs(P.u1), 'members', 'u1'), { primaryRef: 'gil-fb-a', updatedAt: 3 }));
await t('members', 'superadmin makes a user admin', 'allow', () => updateDoc(doc(fsAs(P.sa), 'members', 'u2'), { role: 'admin' }));
await t('members', 'superadmin deletes a user', 'allow', () => deleteDoc(doc(fsAs(P.sa), 'members', 'u2')));
await t('members', 'superadmin deletes themselves', 'deny', () => deleteDoc(doc(fsAs(P.sa), 'members', 'sa')));

// ---------------------------------------------------------------- invites (magic links)
await t('invites', 'signed-in user opens a link', 'allow', () => getDoc(doc(fsAs(P.str), 'invites', TOKEN_A)));
await t('invites', 'anonymous opens a link', 'deny', () => getDoc(doc(fsAs(null), 'invites', TOKEN_A)));
await t('invites', 'user lists links', 'deny', () => getDocs(collection(fsAs(P.u1), 'invites')));
await t('invites', 'admin lists own links', 'allow', () => getDocs(query(collection(fsAs(P.adA), 'invites'), where('owner', '==', 'adA'))));
await t('invites', 'admin lists all links', 'deny', () => getDocs(collection(fsAs(P.adA), 'invites')));
await t('invites', 'superadmin lists all links', 'allow', () => getDocs(collection(fsAs(P.sa), 'invites')));
await t('invites', 'admin creates own link', 'allow', () => setDoc(doc(fsAs(P.adA), 'invites', 'TokenNewAdminA000000001'), { owner: 'adA', active: true }));
await t('invites', 'admin creates a link for another admin', 'deny', () => setDoc(doc(fsAs(P.adA), 'invites', 'TokenForB00000000000001'), { owner: 'adB', active: true }));
await t('invites', 'user creates a link', 'deny', () => setDoc(doc(fsAs(P.u1), 'invites', 'TokenUser00000000000001'), { owner: 'u1', active: true }));
await t('invites', 'admin turns off own link', 'allow', () => updateDoc(doc(fsAs(P.adA), 'invites', TOKEN_A), { active: false }));
await t('invites', "admin turns off the superadmin's link", 'deny', () => updateDoc(doc(fsAs(P.adA), 'invites', TOKEN_SA), { active: false }));
await t('invites', 'superadmin creates a link for an admin', 'allow', () => setDoc(doc(fsAs(P.sa), 'invites', 'TokenForB00000000000002'), { owner: 'adB', active: true }));

// ---------------------------------------------------------------- refs
const myRef = (o = {}) => ({ owner: 'u1', kind: 'email', label: '', active: true, leads: 0, createdAt: 1, ...o });
await t('refs', 'user creates own email ref', 'allow', () => setDoc(doc(fsAs(P.u1), 'refs', 'user1-cccccc'), myRef()));
await t('refs', 'user creates a ref with a wrong suffix', 'deny', () => setDoc(doc(fsAs(P.u1), 'refs', 'user1-zzzzzz'), myRef()));
await t('refs', 'user takes an existing ref', 'deny', () => setDoc(doc(fsAs(P.u1), 'refs', 'u1name-cccccc'), myRef({ kind: 'name' })));
await t('refs', 'user creates a custom ref', 'deny', () => setDoc(doc(fsAs(P.u1), 'refs', 'promo-cccccc'), myRef({ kind: 'custom' })));
await t('refs', 'user creates a ref with leads', 'deny', () => setDoc(doc(fsAs(P.u1), 'refs', 'lead-cccccc'), myRef({ leads: 5 })));
await t('refs', 'user creates a ref for someone else', 'deny', () => setDoc(doc(fsAs(P.u1), 'refs', 'x-cccccc'), myRef({ owner: 'u2' })));
await t('refs', 'disabled user creates a ref', 'deny', () => setDoc(doc(fsAs(P.u3), 'refs', 'u3-eeeeee'), myRef({ owner: 'u3' })));
await t('refs', 'superadmin adds a custom ref', 'allow', () => setDoc(doc(fsAs(P.sa), 'refs', 'gil-fb-c'), { owner: 'sa', kind: 'custom', label: 'FB C', active: true, leads: 0, createdAt: 1 }));
await t('refs', 'admin adds a custom ref', 'deny', () => setDoc(doc(fsAs(P.adA), 'refs', 'adA-promo'), { owner: 'adA', kind: 'custom', active: true, leads: 0 }));
await t('refs', 'admin updates lead count', 'allow', () => updateDoc(doc(fsAs(P.adA), 'refs', 'gil-fb-a'), { leads: 3 }));
await t('refs', 'admin changes a ref label', 'deny', () => updateDoc(doc(fsAs(P.adA), 'refs', 'gil-fb-a'), { label: 'x' }));
await t('refs', 'user updates own lead count', 'deny', () => updateDoc(doc(fsAs(P.u1), 'refs', 'u1name-cccccc'), { leads: 99 }));
await t('refs', 'user lists own refs', 'allow', () => getDocs(query(collection(fsAs(P.u1), 'refs'), where('owner', '==', 'u1'))));
await t('refs', "user reads someone else's ref", 'deny', () => getDoc(doc(fsAs(P.u1), 'refs', 'gil-fb-a')));
await t('refs', 'superadmin turns a ref off', 'allow', () => updateDoc(doc(fsAs(P.sa), 'refs', 'gil-fb-a'), { active: false }));

// ---------------------------------------------------------------- registrations (public form)
await t('registrations', 'anonymous sends a valid request', 'allow', () => setDoc(doc(collection(fsAs(null), 'registrations')), reg()));
await t('registrations', 'anonymous: mobile not 05XXXXXXXX', 'deny', () => setDoc(doc(collection(fsAs(null), 'registrations')), reg({ mobile: '12345' })));
await t('registrations', 'anonymous: name of 1 character', 'deny', () => setDoc(doc(collection(fsAs(null), 'registrations')), reg({ name: 'א' })));
await t('registrations', 'anonymous: name of 61 characters', 'deny', () => setDoc(doc(collection(fsAs(null), 'registrations')), reg({ name: 'א'.repeat(61) })));
await t('registrations', 'anonymous: extra field', 'deny', () => setDoc(doc(collection(fsAs(null), 'registrations')), { ...reg(), admin: true }));
await t('registrations', 'anonymous: status other than new', 'deny', () => setDoc(doc(collection(fsAs(null), 'registrations')), reg({ status: 'joined' })));
await t('registrations', 'anonymous: client-set time', 'deny', () => setDoc(doc(collection(fsAs(null), 'registrations')), reg({ createdAt: Date.now() })));
await t('registrations', 'anonymous: ref of 41 characters', 'deny', () => setDoc(doc(collection(fsAs(null), 'registrations')), reg({ ref: 'x'.repeat(41) })));
await t('registrations', 'anonymous reads requests', 'deny', () => getDocs(collection(fsAs(null), 'registrations')));
await t('registrations', 'user reads requests', 'deny', () => getDocs(collection(fsAs(P.u1), 'registrations')));
await t('registrations', 'admin reads requests', 'allow', () => getDocs(collection(fsAs(P.adA), 'registrations')));
await t('registrations', 'admin sets status + note', 'allow', () => updateDoc(doc(fsAs(P.adA), 'registrations', 'r1'), { status: 'contacted', note: 'x', handledBy: 'a', handledAt: 1 }));
await t('registrations', 'admin edits the name', 'deny', () => updateDoc(doc(fsAs(P.adA), 'registrations', 'r1'), { name: 'x' }));
await t('registrations', 'admin deletes a request', 'deny', () => deleteDoc(doc(fsAs(P.adA), 'registrations', 'r1')));
await t('registrations', 'superadmin deletes a request', 'allow', () => deleteDoc(doc(fsAs(P.sa), 'registrations', 'r1')));

// ---------------------------------------------------------------- settings & usage
await t('config/quota', 'admin reads limits', 'allow', () => getDoc(doc(fsAs(P.adA), 'config', 'limits')));
await t('config/quota', 'user reads limits', 'deny', () => getDoc(doc(fsAs(P.u1), 'config', 'limits')));
await t('config/quota', 'admin changes limits', 'deny', () => setDoc(doc(fsAs(P.adA), 'config', 'limits'), { roles: {} }));
await t('config/quota', 'superadmin changes limits', 'allow', () => setDoc(doc(fsAs(P.sa), 'config', 'limits'), { roles: { user: { routeOpt: 1 } }, global: {} }));
await t('config/quota', 'admin reads usage', 'allow', () => getDoc(doc(fsAs(P.adA), 'quota', `routeopt-${DAY}`)));
await t('config/quota', 'user reads usage', 'deny', () => getDoc(doc(fsAs(P.u1), 'quota', `routeopt-${DAY}`)));
await t('config/quota', 'superadmin writes usage', 'deny', () => setDoc(doc(fsAs(P.sa), 'quota', `routeopt-${DAY}`), { requests: 0 }));

// ---------------------------------------------------------------- storage (import screenshots)
const img = new Uint8Array([255, 216, 255]);
await t('storage', 'user uploads own screenshot', 'allow', () => uploadBytes(sref(stAs(P.u1), 'labUsers/u1/imports/i2/1.jpg'), img, { contentType: 'image/jpeg' }));
await t('storage', 'user reads own screenshot', 'allow', () => getBytes(sref(stAs(P.u1), 'labUsers/u1/imports/i1/1.jpg')));
await t('storage', 'disabled user uploads', 'deny', () => uploadBytes(sref(stAs(P.u3), 'labUsers/u3/imports/i1/1.jpg'), img, { contentType: 'image/jpeg' }));
await t('storage', 'non-member uploads', 'deny', () => uploadBytes(sref(stAs(P.str), 'labUsers/str/imports/i1/1.jpg'), img, { contentType: 'image/jpeg' }));
await t('storage', "user uploads to someone else's folder", 'deny', () => uploadBytes(sref(stAs(P.u1), 'labUsers/u2/imports/i1/1.jpg'), img, { contentType: 'image/jpeg' }));
await t('storage', 'user uploads a non-image', 'deny', () => uploadBytes(sref(stAs(P.u1), 'labUsers/u1/imports/i3/1.txt'), img, { contentType: 'text/plain' }));
await t('storage', "user reads someone else's screenshot", 'deny', () => getBytes(sref(stAs(P.u2), 'labUsers/u1/imports/i1/1.jpg')));
await t('storage', "superadmin reads a user's screenshot", 'allow', () => getBytes(sref(stAs(P.sa), 'labUsers/u1/imports/i1/1.jpg')));

// ---------------------------------------------------------------- batch sizes (every write re-checks membership)
await t('batch', 'user imports 100 deliveries in one batch', 'allow', async () => {
  const db = fsAs(P.u1); const b = writeBatch(db);
  for (let i = 0; i < 100; i++) b.set(doc(db, 'labUsers', 'u1', 'days', DAY, 'deliveries', `b${i}`), { shipmentId: `b${i}`, status: 'pending' });
  return b.commit();
});
await t('batch', 'superadmin deletes 100 documents in one batch', 'allow', async () => {
  const db = fsAs(P.sa); const b = writeBatch(db);
  for (let i = 0; i < 100; i++) b.delete(doc(db, 'labUsers', 'u1', 'days', DAY, 'deliveries', `b${i}`));
  return b.commit();
});

// ---------------------------------------------------------------- report
console.log('\n');
const failed = results.filter((r) => !r.pass);
for (const area of [...new Set(results.map((r) => r.area))]) {
  const rs = results.filter((r) => r.area === area);
  console.log(`${area}: ${rs.filter((r) => r.pass).length}/${rs.length}`);
}
console.log(`\nTOTAL ${results.length - failed.length}/${results.length} passed`);
failed.forEach((r) => console.log(`  ✗ [${r.area}] ${r.name} – expected ${r.expect}${r.error ? ' – ' + r.error : ''}`));
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
writeFileSync(new URL('./results/rules.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
await env.cleanup();
process.exit(failed.length ? 1 : 0);
