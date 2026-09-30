// Public registration form: name + mobile + ref → registrations/{id} (no sign-in needed).
// ?ref=<code> fills the ref and locks it. The admin panel lists the requests (Registrations).
// firestore.rules validate every field; the checks here are for friendly messages.
import { firebaseConfig } from './firebase-config.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2';
const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const demo = params.has('demo');

const urlRef = (params.get('ref') || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);
if (urlRef) {
  $('#regRef').value = urlRef;
  $('#regRef').readOnly = true;
  $('#regRefHint').textContent = 'הקוד נוסף אוטומטית מהקישור.';
}

// "050-123 4567", "+972 50 1234567" → "0501234567"
function normMobile(v) {
  let d = String(v || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+972')) d = '0' + d.slice(4);
  else if (d.startsWith('972')) d = '0' + d.slice(3);
  return d.replace(/\D/g, '');
}

let dbPromise = null;
function firestore() {
  return (dbPromise ||= Promise.all([import(`${FB}/firebase-app.js`), import(`${FB}/firebase-firestore.js`)])
    .then(([{ initializeApp }, fs]) => ({ fs, db: fs.getFirestore(initializeApp(firebaseConfig, 'registration')) })));
}

$('#regForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#regErr');
  err.textContent = '';
  if ($('#regWebsite').value) return; // bots fill the hidden field
  const name = $('#regName').value.trim().replace(/\s+/g, ' ');
  const mobile = normMobile($('#regMobile').value);
  const ref = urlRef || $('#regRef').value.trim().slice(0, 40);
  if (name.length < 2) { err.textContent = 'נא למלא שם מלא.'; $('#regName').focus(); return; }
  if (!/^05\d{8}$/.test(mobile)) { err.textContent = 'נא למלא מספר נייד ישראלי תקין (05X-XXXXXXX).'; $('#regMobile').focus(); return; }

  const btn = $('#regSubmit');
  btn.disabled = true;
  btn.textContent = 'שולח…';
  try {
    if (!demo) {
      const { fs, db } = await firestore();
      await fs.addDoc(fs.collection(db, 'registrations'), {
        name: name.slice(0, 60), mobile, ref, source: urlRef ? 'link' : 'manual', createdAt: fs.serverTimestamp(), status: 'new',
      });
    }
    $('#regForm').hidden = true;
    $('#regDone').hidden = false;
  } catch (e2) {
    console.error(e2);
    err.textContent = 'השליחה נכשלה. נסה שוב בעוד רגע.';
    btn.disabled = false;
    btn.textContent = 'שלח';
  }
});
