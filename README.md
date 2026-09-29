# SmartRoute (LAB) – ניסוי Google Route Optimization

עותק של SmartRun לניסוי מנוע המסלולים של Google. **SmartRun (העבודה היומית) לא מושפע.**

| | SmartRun | SmartRoute (LAB) |
|---|---|---|
| כתובת | https://gbitman84.github.io/smartrun/ | https://gbitman84.github.io/smartroute/ |
| נתונים ב-Firestore | `users/{uid}` | `labUsers/{uid}` (נפרד לגמרי) |
| מנוע מסלול | חינמי (OSRM) | Google Route Optimization, עם גיבוי אוטומטי לחינמי |
| צבע סרגל עליון | אפור כהה | סגול + תג LAB |

פרויקט Firebase, כניסה, תקציב ומכסות: משותפים (`smartrun-gbit`).

## איך זה עובד
- האתר שולח את העצירות (קואורדינטות בלבד) לפונקציית ענן `optimizeRoute` (europe-west1).
- הפונקציה פונה ל-Route Optimization API עם Service Account (אין מפתח בדפדפן), ומחזירה סדר + קו מסלול.
- מה נלקח בחשבון: עומסי תנועה לפי שעה, צד הכביש של כל כתובת (`sideOfRoad`), זמן עצירה לכל כתובת (ברירת מחדל 90 שניות, בהגדרות), פניות אסורות וכיווני תנועה.
- ☰ ← **📊 השוואת מנועים**: מריץ את Google ואת המנוע החינמי על העצירות הפעילות, ומציג ק״מ, זמן וסדר זה לצד זה. לא נשמר דבר.
- ⚙️ הגדרות: בחירת מנוע, זמן עצירה, ועומסי תנועה.

## הגנות עלות
- **Google:** עד 3 בקשות בדקה. מצבי batch ו-long-running חסומים (0).
- **בפונקציה:** עד 40 חישובים ו-1,500 משלוחים ביום (שעון ישראל). מעבר לזה, מעבר אוטומטי למנוע החינמי.
- **פונקציה:** רק החשבון gbitman.bd@gmail.com מורשה.
- **תקציב:** ₪20 לחודש, עם התראות ב-50% וב-100%.
- **מחיר:** 5,000 משלוחים בחודש בחינם, ואחר כך כ-$10 לכל 1,000.

## פריסה
```bash
npx -y firebase-tools@latest deploy --only functions,firestore:rules --project smartrun-gbit
```
`firestore.rules` חייב להיות זהה בשני הפרויקטים. הוא מכיל את `users` ואת `labUsers`.
