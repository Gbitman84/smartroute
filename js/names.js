// Name check for screenshot import: a Hebrew name word that isn't known, while a look-alike spelling
// (one letter swapped for a similar-looking one, e.g. ב↔ח, ה↔א) is known → probably a misread → yellow + suggestion.
// Known = a starter list of common Israeli first names and surnames + names learned from confirmed imports
// (meta/names, only names nobody doubted or that the user fixed/accepted).

// Letters that look alike on the delivery app's screen font.
const LOOKALIKE = {
  'ב': 'כחפ', 'כ': 'בפ', 'פ': 'כב', 'ח': 'התב', 'ה': 'חתא', 'ת': 'חה', 'א': 'ה',
  'ד': 'רך', 'ר': 'דך', 'ך': 'רד', 'ו': 'זןי', 'ז': 'ו', 'ן': 'ו', 'י': 'ו',
  'ס': 'םט', 'ם': 'ס', 'ט': 'ס', 'ג': 'נ', 'נ': 'גכ', 'ע': 'צ', 'צ': 'ע',
};

const FIRST = `אברהם יצחק יעקב משה אהרן אהרון דוד שלמה יוסף בנימין דניאל מיכאל גבריאל רפאל אליהו שמואל חיים מאיר
יהודה שמעון לוי ראובן נתן אריה צבי עמוס אבי אבנר אביב אורי אורן אור אלון אליעזר אלעד אמיר אסף ארז בועז ברק גיא גיל
גלעד דן דור הראל זיו חגי טל יאיר יגאל יובל יונתן יואב יוסי יורם ירון ישראל כפיר ליאור מתן נדב נועם ניר עדי עידו עומר
עמית ערן פנחס רון רועי רז שגיא שחר שי שלום תומר איתי איתן אליאור בן עוז אופיר מרדכי ציון זיוה נאוה שרה רבקה רחל לאה
מרים חנה אסתר רות נעמי דבורה יהודית אביגיל אורית אורלי איילת אילנה אלה אתי בתיה גאולה גלית דליה דנה הדס הילה ורד
חגית חווה טובה יעל יפה כרמית לימור ליאת מאיה מיכל מירב נגה נוי נועה נורית סיגל סמדר עדנה ענת עינב פנינה צביה קרן
רונית רוני שולמית שושנה שירה שירלי תמר תהילה אושרת אפרת מלכה ורדה זהבה ברכה שמחה מזל`;

const LAST = `כהן לוי מזרחי פרץ ביטון דהן אברהם פרידמן אגבריה אזולאי מלכה חדד גבאי קליין עמר יוסף אוחיון חזן גולן שפירא ששון
אדרי אלון דוד חיים בן דוד שלום ליבוביץ אשכנזי כץ רוזנברג אוחנה סויסה בוזגלו מימון נחום יעקב שמעוני טל ברק שרעבי חסון
אלמוג רביבו אלבז בכר זכאי טוויטו מלול סעדה עטיה פרג' קדוש רחמים שטרן שושן גרינברג ויס וייס גולדשטיין רוזן הורוביץ
ברגר זילברמן לנדאו פישר קפלן שוורץ וולף מנשה אליהו נסים יצחק שמואלי אהרוני גבריאלי ישראלי רפאלי בירנבאום גבע גל
גלבוע דגן הדר ויסמן זהבי חביב טייב יונה כרמי לב מור נוי סגל עוזרי צור קרמר רום שגב שחר שמש תמיר אלקיים בוסקילה
גואטה דאהן זוהר חורי טנא יפרח כנפו לוזון מויאל נגר סבג עזרא פינטו קוהן רוקח שבתאי תורג'מן אבוטבול אבוקסיס אלמליח
בן שושן דנינו הלל ויזל חן יונס כלפון לוגסי מרציאנו נקש סיבוני עייש פנחסי צרפתי קורן ריינר שלו תבור`;

const toWords = (s) => s.split(/\s+/).map((w) => w.trim()).filter(Boolean);
export const STARTER_NAMES = new Set([...toWords(FIRST), ...toWords(LAST)]);

const HEB_WORD = /^[א-ת'"׳״-]{2,}$/;
const FINAL = { 'כ': 'ך', 'מ': 'ם', 'נ': 'ן', 'פ': 'ף', 'צ': 'ץ' };
const fixFinal = (w) => (FINAL[w.at(-1)] ? w.slice(0, -1) + FINAL[w.at(-1)] : w);

// Hebrew words of a name that are worth learning / checking.
export const nameWords = (name) => toWords(String(name || '').replace(/[()]/g, ' ')).filter((w) => HEB_WORD.test(w));

// Look-alike spellings of one word that are known, closest first (one letter changed).
function lookalikes(word, known) {
  const hits = [];
  [...word].forEach((ch, i) => {
    for (const alt of LOOKALIKE[ch] || '') {
      const v = fixFinal(word.slice(0, i) + alt + word.slice(i + 1));
      if (v !== word && known.has(v) && !hits.includes(v)) hits.push(v);
    }
  });
  return hits;
}

// → { level: 'warn', msg, suggestion } or null.
export function nameIssue(name, known) {
  for (const w of nameWords(name)) {
    if (known.has(w)) continue;
    const alt = lookalikes(w, known)[0];
    if (alt) {
      const suggestion = String(name).replace(w, alt);
      return { level: 'warn', msg: `שם לא מוכר – אולי "${suggestion}"? (אותיות דומות)`, suggestion };
    }
  }
  return null;
}
