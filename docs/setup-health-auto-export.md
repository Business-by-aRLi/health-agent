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

לפי [המדריך הרשמי](https://help.healthyapps.dev/en/health-auto-export/automations/rest-api/). יוצרים **שתי** אוטומציות: מדדים ואימונים. כל אוטומציה מקבלת סוג מידע אחד.

**הדרך:** תפריט צד (☰) → **Automations** → **New Automation** → Automation Type: **REST API**

### אוטומציה א׳: מדדים

| שדה | ערך |
|---|---|
| Automation Name | `Health Agent - Metrics` |
| URL | `https://hwcgxyreboaqjoxrofgw.supabase.co/functions/v1/ingest-healthkit` |
| Request Timeout | הארוך ביותר שיש |
| Headers → Add Headers | שמאל: `Authorization` · ימין: `Bearer hk_...` (עם רווח אחרי Bearer) |
| Data Type | **Health Metrics** → לבחור: Step Count, Heart Rate, Resting Heart Rate, Heart Rate Variability, Walking Heart Rate Average, Active Energy, Apple Exercise Time, Walking + Running Distance, Sleep Analysis, Weight, VO2 Max, Respiratory Rate, Blood Oxygen Saturation |
| Export Format | **JSON** |
| Export Version | **Version 2** |
| Date Range | **Since Last Sync** |
| Summarize Data | **ON** |
| Time Grouping | **Hours** |
| Batch Requests | **ON** |
| Sync Cadence | `15` + `Minutes` |

> 🧠 **למה Summarize ON + Hours?** צעדים נמדדים גם בשעון וגם בטלפון. כשהאפליקציה מסכמת, HealthKit מנכה את הכפילויות ביניהם. דופק לפי שעה (min/avg/max) מספיק לתמונה יומית. הדופק המפורט של אימונים מגיע באוטומציה ב׳.

### אוטומציה ב׳: אימונים

אותו URL ואותו Header, ובנוסף:

| שדה | ערך |
|---|---|
| Automation Name | `Health Agent - Workouts` |
| Data Type | **Workouts** |
| Include Route Data | **ON** |
| Include Workout Metrics | **ON** |
| Time Grouping | **Minutes** (המדריך הרשמי דורש Minutes או Seconds כשמדדי אימון פעילים) |
| Export Format / Version | JSON / Version 2 |
| Date Range | Since Last Sync |
| Batch Requests | **ON** |
| Sync Cadence | `1` + `Hours` (מסלולים כבדים, ולכן פחות תכוף) |

### אוטומציה ב׳2: שינה (חובה)

> 🧠 **למה צריך אוטומציה נפרדת לשינה?** Since Last Sync שולח רק נתונים עם תאריך מאוחר מהסנכרון הקודם. השעון מעביר את נתוני הלילה לטלפון רק אחרי הקימה, אבל עם התאריך של הלילה. סנכרון שרץ ב-23:45 "מסמן" את הלילה כמטופל, והשינה שמגיעה בבוקר עם תאריך מוקדם יותר מדולגת. כך נעלמו הלילות של 23–25.10. הפתרון: אוטומציה שתמיד שולחת את הימים האחרונים מחדש. השרת שומר לילה אחד לכל תאריך, ולכן שליחה חוזרת מעדכנת ולא יוצרת כפילות.

אותו URL ואותו Header, ובנוסף:

| שדה | ערך |
|---|---|
| Automation Name | `Health Agent - Sleep` |
| Data Type | **Health Metrics** → רק **Sleep Analysis** (מדדים אחרים כאן ייכנסו פעמיים, גם לפי שעה וגם לפי יום) |
| Export Format / Version | JSON / Version 2 |
| Date Range | טווח קבוע של כמה ימים אחרונים (למשל **Previous 7 Days** / Last 7 Days), **לא** Since Last Sync |
| Summarize Data | **ON** |
| Time Grouping | **Days** |
| Batch Requests | **ON** |
| Sync Cadence | `1` + `Hours` |

### אוטומציה ג׳ (בהמשך): מעקב מחזור

Cycle Tracking הוא **סוג מידע נפרד** באפליקציה. נוסיף אותו רק אחרי שהשתיים הראשונות עובדות, כי צריך לוודא את פורמט ה-JSON שלו מול המתאם. ראו סעיף 3ב.

### כדי שהסנכרון ירוץ ברקע

- **Settings → General → Background App Refresh**: מופעל, גם ל-Health Auto Export.
- להוסיף את ה-**widget** של Automations למסך הבית. לפי המדריך הרשמי זה עוזר להרצה ברקע.
- iOS לא נותן גישה למידע בריאותי כשהטלפון נעול, ולכן הסנכרון רץ כשהטלפון פתוח. ב-Low Power Mode הוא עלול להתעכב.
- תקלות מופיעות במסך האוטומציה תחת **View Activity Logs**.

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

ואז יוצרים אוטומציה שלישית עם Data Type: **Cycle Tracking** (אותו URL ו-Header). אחרי הייצוא הראשון שלחי לי את ה-`warnings`, כי את פורמט ה-JSON של סוג המידע הזה עוד צריך לאמת מול המתאם. כיבוי: `cycle_tracking_enabled = false`.

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
