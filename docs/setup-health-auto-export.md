# חיבור האייפון: Health Auto Export → Supabase

זמן משוער: 10 דקות. צריך: את האפליקציה Health Auto Export (עם מנוי שכולל REST API), ואת הדשבורד של Supabase.

> שמות ההגדרות באפליקציה עשויים להשתנות מעט בין גרסאות. העיקרון קבוע: **REST API, פורמט JSON, header של Authorization**.

---

## 1. הנפקת טוקן קליטה (פעם אחת)

ב-Supabase: **SQL Editor** → New query → הדביקי והריצי:

```sql
-- מוצאים את ה-id של המשתמש שלך
select id, email from auth.users;

-- מנפיקים מקור + טוקן (החליפי את ה-uuid)
select * from public.create_ingest_source(
  '00000000-0000-0000-0000-000000000000'::uuid,
  'health_auto_export',
  'האייפון שלי'
);
```

התוצאה מחזירה `source_id` ו-`ingest_token` (מתחיל ב-`hk_`).
**העתיקי את הטוקן עכשיו.** הוא לא נשמר אצלנו, רק ה-hash שלו. אם הוא אבד או דלף:

```sql
select public.rotate_ingest_token('<source_id>'::uuid);  -- הישן מפסיק לעבוד מיד
```

> 🧠 **למה ב-SQL Editor ולא בצ'אט?** הטוקן הוא סיסמה לכתיבת מידע בריאותי לחשבון שלך. ככה הוא עובר ישירות מהדאטהבייס אלייך ולא נשמר בשום היסטוריית שיחה.

---

## 2. הגדרת אוטומציות באפליקציה

ב-Health Auto Export: **Automations → New Automation → REST API**. יוצרים **שתיים**: אחת למדדים ואחת לאימונים.

### אוטומציה א׳: Health Metrics

| הגדרה | ערך |
|---|---|
| URL | `https://hwcgxyreboaqjoxrofgw.supabase.co/functions/v1/ingest-healthkit` |
| Headers | `Authorization` = `Bearer hk_...` (הטוקן מסעיף 1, עם המילה Bearer ורווח) |
| Export Format | JSON |
| Export Version | הגרסה העדכנית (v2) |
| Data Type | Health Metrics |
| Metrics | Step Count, Heart Rate, Resting Heart Rate, Heart Rate Variability, Walking Heart Rate Average, Active Energy, Apple Exercise Time, Walking + Running Distance, **Sleep Analysis**, Weight, VO2 Max, Respiratory Rate, Blood Oxygen. אפשר גם הכול: מדד לא מוכר נשמר כמו שהוא |
| Aggregate / Summarize | **מופעל**, קיבוץ לפי **שעות** (Hours) |
| Sync Cadence | כל 15–30 דקות |
| Date Range | מאז הסנכרון האחרון / היום |

> 🧠 **למה aggregated לפי שעה?** צעדים נמדדים גם בשעון וגם בטלפון. כש-HAE מסכם, HealthKit מנכה את הכפילויות בין המכשירים, ולכן הסכום היומי נכון. דופק לפי שעה (min/avg/max) מספיק לתמונה יומית. הדופק המפורט של **אימונים** מגיע בנפרד, דקה-דקה, באוטומציה ב׳.

### אוטומציה ב׳: Workouts

אותו URL ואותו Header, ובנוסף:

| הגדרה | ערך |
|---|---|
| Data Type | Workouts |
| Include Route Data | ✅ (מסלול GPS) |
| Include Workout Metrics | ✅ (דופק, התאוששות דופק, צעדים, מרחק בתוך האימון) |
| Sync Cadence | כל 30 דקות |

---

## 3. בדיקה ראשונה

1. באפליקציה: בחרי באוטומציה → **Manual Export / Run Now**, לטווח של היום.
2. ב-Supabase: **Table Editor → `ingest_events`**. אמורה להופיע שורה עם `status = processed`, ובעמודה `stats` כמה דגימות, אימונים ולילות נכנסו.
3. **`daily_summaries`**: שורה להיום, עם צעדים, דופק ושינה.

**שלחי לי את ה-`stats` וה-`warnings` מהשורה הראשונה.** המתאם נכתב לפי התיעוד של HAE ונבדק על נתונים לדוגמה. ה-payload האמיתי מהטלפון שלך הוא הבדיקה האמיתית, ואם יש שדה שלא זוהה הוא יופיע ב-`warnings`. ה-payload הגולמי שמור, כך שאחרי תיקון אפשר להריץ אותו מחדש.

---

## 3ב. מעקב מחזור (אופציונלי, רק לפרופיל נשי)

כשהמעקב כבוי (ברירת המחדל), נתוני מחזור **לא נקלטים בכלל**, גם אם האפליקציה שולחת אותם. להפעלה, ב-SQL Editor:

```sql
update public.profiles
   set sex = 'female', cycle_tracking_enabled = true
 where id = '<ה-id שלך>'::uuid;
```

ואז באוטומציה א׳ מוסיפים את מדדי **Cycle Tracking**: Menstrual Flow, Cervical Mucus Quality, Ovulation Test Result, Basal Body Temperature (ואת מה שמתועד אצלך). כיבוי: `cycle_tracking_enabled = false`.

> הדאטהבייס עצמו לא מאפשר להפעיל מעקב בפרופיל שלא הוגדר כאישה (constraint). זו שכבת הגנה שלא תלויה בקוד.

## 4. ייבוא היסטוריה (backfill)

כדי שלסוכן יהיה baseline (ממוצע אישי של 28 יום) מהיום הראשון:

- Manual Export עם **טווח של חודש בכל פעם**, מהחודש הישן לחדש.
- סדר כרונולוגי חשוב: ה-baseline של כל יום מחושב מהימים שלפניו.
- שלושה חודשים מספיקים להתחלה. אפשר להוסיף עוד בהמשך.

---

## 5. תקלות נפוצות

| קוד | משמעות | מה עושים |
|---|---|---|
| `401 missing_token` | ה-header חסר | לבדוק ש-Header הוא `Authorization` והערך מתחיל ב-`Bearer ` |
| `401 invalid_token` | טוקן שגוי או ישן | להעתיק מחדש, או להנפיק עם `rotate_ingest_token` |
| `413 payload_too_large` | ייצוא גדול מדי (מעל 25MB) | לקצר את טווח התאריכים |
| `422 unrecognized_format` | ה-JSON לא בפורמט של HAE | לוודא Export Format = JSON |
| `500 write_failed` | שגיאה בכתיבה | לבדוק את `ingest_events.error` ולשלוח לי |

לוגים של הפונקציה: Supabase → **Edge Functions → ingest-healthkit → Logs**.
