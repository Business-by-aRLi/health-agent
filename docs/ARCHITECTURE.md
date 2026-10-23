# Health Agent — מסמך ארכיטקטורה (v0.1, לבדיקה)

> סטטוס: **טיוטה לאישור**. אין קוד עד שהמסמך הזה מאושר.

---

## 1. מטרה והיקף

סוכן אישי שמתנהג כמו **מאמן כושר ותזונאי ברמה גבוהה**. הוא קורא נתונים אמיתיים מהאייפון ומה-Apple Watch (שינה, דופק, HRV, צעדים, אימונים, משקל), מקבל דיווחי אוכל בתמונה או בהודעה קולית בטלגרם, מחבר את הכול לתמונה אחת ונותן הכוונה יומית ושבועית.

**בשלב 1 (עכשיו):** משתמשת אחת (את), iPhone + HealthKit, ממשק בטלגרם בלבד.

**מתוכנן לגדילה, לא נבנה עכשיו:** משתמשים נוספים, מאמנים שרואים מתאמנים, מקורות נוספים (Garmin, Oura, Whoop, Android Health Connect), דשבורד ווב.

**מחוץ להיקף:** אבחון רפואי, מרשמים, ייעוץ לחולים במחלות רקע. הסוכן הוא מאמן, לא רופא.

---

## 2. תרחישי שימוש

- כמשתמשת, אני רוצה שהנתונים מהשעון יגיעו ל-Supabase **לבד**, בלי לפתוח שום אפליקציה.
- כמשתמשת, אני רוצה לצלם צלחת או להקליט "אכלתי שתי ביצים וסלט" ולקבל הערכה של קלוריות ומאקרו, לאשר או לתקן אותה, ושהיא תישמר.
- כמשתמשת, אני רוצה לקבל כל בוקר בטלגרם **תדריך בוקר**: איך ישנתי, מה מצב ההתאוששות (HRV ודופק במנוחה מול הממוצע שלי), ומה כדאי לעשות היום.
- כמשתמשת, אני רוצה לשאול "למה אני עייפה השבוע?" ולקבל תשובה שמבוססת על הנתונים שלי ולא על עצות כלליות.
- כמשתמשת, אני רוצה **סיכום שבועי** עם מגמות, עמידה ביעדים ותוכנית לשבוע הבא.
- (עתידי) כמאמן, אני רוצה לראות את הנתונים של מתאמנים שאישרו לי גישה.

---

## 3. ההחלטה הכי חשובה: איך מוציאים מידע מ-HealthKit

**הבעיה:** ל-Apple Health **אין API בענן**. המידע נמצא רק על המכשיר, ורק אפליקציית iOS שקיבלה הרשאה יכולה לקרוא אותו. לכן חייב "גשר" שרץ על הטלפון.

| אפשרות | איך זה עובד | יתרונות | חסרונות |
|---|---|---|---|
| **A. Health Auto Export** (אפליקציה מה-App Store) ✅ מומלץ לשלב 1 | אוטומציית REST API ששולחת JSON בכל X דקות ל-URL שנגדיר | אפס קוד Swift, עובד ברקע, תומך בכל סוגי המדדים ובאימונים | תלות בצד שלישי, בפיצ'ר בתשלום (צריך לוודא שהמנוי מאפשר REST API), פורמט JSON שלהם |
| B. iOS Shortcuts | אוטומציה ב-Shortcuts שקוראת "Find Health Samples" ושולחת POST | חינמי | לא רץ באמת ברקע, דורש אישורים, מסורבל לכמה מדדים |
| C. אפליקציית iOS משלנו (Swift + HealthKit Background Delivery) | אפליקציה שלנו נרשמת לעדכונים ושולחת ל-Supabase | שליטה מלאה, מוצר אמיתי ל-SaaS | חשבון מפתחת ($99 לשנה), Swift, App Review. כמה שבועות עבודה |

**ההמלצה:** מתחילים ב-**A** ובונים את צד השרת כך שהחלפה ל-**C** בעתיד תהיה רק "מתאם" (adapter) נוסף, בלי לשנות את הדאטהבייס או את הסוכן.

> 🧠 **מושג שכדאי להכיר: Adapter Pattern.** כל מקור מידע (Health Auto Export, Garmin, אפליקציה משלנו) מדבר בפורמט אחר. במקום שהסוכן יכיר את כולם, לכל מקור כותבים **מתאם** שמתרגם את הפורמט שלו ל**מודל קנוני** אחד ("דגימת דופק", "אימון", "שינה"). הסוכן והדאטהבייס מכירים רק את המודל הקנוני. מקור חדש = מתאם חדש, ושום דבר אחר לא משתנה. ככה מקבלים סקיילביליות בלי לבנות היום את כל החיבורים.

---

## 4. מודל נתונים

כל טבלה כוללת `user_id` מהיום הראשון, גם כשיש משתמשת אחת. זה מה שמאפשר לגדול לריבוי משתמשים בלי מיגרציה כואבת.

### 4.1 משתמשים והקשר אישי

```
profiles                      -- 1:1 עם auth.users
├── id uuid PK → auth.users.id
├── display_name text
├── timezone text default 'Asia/Jerusalem'   -- קובע מתי מתחיל "יום"
├── birth_date date, sex text, height_cm numeric
├── activity_level text
├── dietary_prefs jsonb        -- צמחוני, כשרות, אלרגיות, מאכלים שלא אוהבת
├── injuries_notes text        -- פציעות ומגבלות
├── locale text default 'he-IL'
└── created_at, updated_at

goals
├── id uuid PK, user_id FK
├── kind text                  -- 'weight' | 'body_fat' | 'steps' | 'sleep' | 'strength' | 'race' | 'custom'
├── target_value numeric, unit text, target_date date
├── status text                -- 'active' | 'achieved' | 'paused'
└── notes text

nutrition_targets              -- יעדים שהסוכן קובע ואת מאשרת. גרסאות, לא דריסה
├── id uuid PK, user_id FK
├── kcal int, protein_g int, carbs_g int, fat_g int, fiber_g int
├── valid_from date, valid_to date null
├── rationale text             -- למה הסוכן בחר את היעד הזה
└── created_by text            -- 'agent' | 'user' | 'coach'
```

### 4.2 מקורות מידע (שכבת החיבורים)

```
data_sources
├── id uuid PK, user_id FK
├── provider text              -- 'health_auto_export' | 'ios_app' | 'garmin' | 'oura' | 'whoop' | 'health_connect'
├── label text                 -- "האייפון שלי"
├── ingest_token_hash text     -- למקורות שדוחפים אלינו (push). שומרים רק hash
├── oauth_tokens_encrypted     -- למקורות שאנחנו מושכים מהם (pull). בעתיד, דרך Supabase Vault
├── last_synced_at timestamptz
├── status text                -- 'active' | 'revoked' | 'error'
└── created_at

ingest_events                  -- כל payload גולמי שהגיע. לדיבוג ולהרצה מחדש
├── id bigint PK, user_id FK, source_id FK
├── received_at timestamptz
├── payload jsonb
├── status text                -- 'pending' | 'processed' | 'failed'
├── error text
└── stats jsonb                -- כמה דגימות נכנסו, כמה כפילויות
-- נשמר 30 יום ואז נמחק ב-cron
```

> 🧠 **למה לשמור payload גולמי?** אם המתאם מכיל באג (למשל יחידות לא נכונות), אפשר לתקן אותו ולהריץ מחדש על המידע המקורי במקום לאבד אותו. זה דפוס שנקרא **raw → normalized pipeline**.

### 4.3 המודל הקנוני (מידע בריאותי)

```
health_samples                 -- סדרות זמן: דופק, HRV, צעדים, משקל, אנרגיה פעילה ועוד
├── id bigint PK (identity)
├── user_id FK, source_id FK
├── metric text                -- 'heart_rate' | 'resting_heart_rate' | 'hrv_sdnn' | 'steps' | 'active_energy'
│                              --  | 'body_mass' | 'body_fat_pct' | 'vo2max' | 'respiratory_rate' | 'spo2' ...
├── start_at timestamptz, end_at timestamptz
├── value numeric
├── unit text                  -- תמיד ביחידה קנונית: kg, bpm, ms, kcal, count
├── meta jsonb                 -- מידע ספציפי למקור
UNIQUE (user_id, source_id, metric, start_at, end_at)   -- מונע כפילויות כשהמקור שולח שוב חלון חופף
INDEX (user_id, metric, start_at desc)                  -- השאילתה הנפוצה: "מדד X לטווח תאריכים"

workouts
├── id uuid PK, user_id FK, source_id FK
├── external_id text           -- ה-UUID של HealthKit
├── activity_type text         -- 'running' | 'strength' | 'walking' | 'yoga' ...
├── start_at, end_at, duration_s int
├── active_kcal, distance_m, avg_hr, max_hr numeric
├── hr_zones jsonb             -- זמן בכל אזור דופק
├── perceived_effort int null  -- RPE 1–10, הסוכן שואל אחרי אימון
└── notes text
UNIQUE (user_id, source_id, external_id)

sleep_sessions
├── id uuid PK, user_id FK, source_id FK
├── sleep_date date            -- היום שבו התעוררת (לא היום שבו נרדמת)
├── in_bed_start, in_bed_end, asleep_start, asleep_end timestamptz
├── total_asleep_min, rem_min, core_min, deep_min, awake_min int
UNIQUE (user_id, source_id, sleep_date)

daily_summaries                -- טבלה מחושבת: מה שהסוכן קורא רוב הזמן
├── user_id, day date          PK (user_id, day)
├── steps, active_kcal, exercise_min
├── resting_hr, hrv_avg, sleep_min, sleep_efficiency
├── weight_kg
├── kcal_in, protein_g, carbs_g, fat_g      -- מהארוחות
├── recovery_score numeric     -- ציון שלנו: HRV ודופק במנוחה מול baseline של 28 יום
├── baselines jsonb            -- ממוצע וסטיית תקן של 28 יום לכל מדד
└── computed_at
```

> 🧠 **למה `daily_summaries` נפרדת?** הסוכן הוא מודל שפה, ואסור לשפוך לו 20,000 דגימות דופק. אנחנו מסכמים מראש ב-SQL לשורה אחת ליום, והסוכן מקבל רק מספרים קומפקטיים. ככה הוא זול יותר, מהיר יותר ומדויק יותר. זה נקרא **pre-aggregation**.

### 4.4 תזונה

```
meals
├── id uuid PK, user_id FK
├── eaten_at timestamptz
├── meal_type text             -- 'breakfast' | 'lunch' | 'dinner' | 'snack'
├── input_kind text            -- 'photo' | 'voice' | 'text'
├── media_path text            -- Supabase Storage, bucket פרטי
├── transcript text            -- תמלול ההודעה הקולית
├── status text                -- 'estimated' | 'confirmed' | 'corrected'
├── total_kcal, protein_g, carbs_g, fat_g, fiber_g numeric
└── confidence numeric         -- כמה הסוכן בטוח בהערכה (0–1)

meal_items
├── id uuid PK, meal_id FK (cascade), user_id FK
├── name_he text, quantity numeric, unit text   -- "2 ביצים", "150 גרם"
└── kcal, protein_g, carbs_g, fat_g numeric
```

### 4.5 הסוכן: שיחה וזיכרון

```
telegram_links
├── user_id FK, chat_id bigint UNIQUE
├── link_code text, link_code_expires_at        -- קוד חד-פעמי לחיבור
└── linked_at

conversations / messages
├── messages: id, user_id, role ('user'|'assistant'|'tool'), content jsonb, created_at
└── telegram_message_id bigint                  -- למניעת עיבוד כפול

coach_memory                   -- דברים שהסוכן צריך לזכור לטווח ארוך
├── id, user_id
├── category text              -- 'preference' | 'injury' | 'schedule' | 'insight' | 'commitment'
├── content text               -- "מתאמנת רק בבוקר", "ברך שמאל רגישה בריצה"
├── source_message_id FK null
├── active boolean
└── created_at, updated_at

training_plans
├── id, user_id, week_start date
├── plan jsonb                 -- ימים, סוג אימון, עצימות, נפח
├── rationale text
└── status text
```

### 4.6 הכנה למאמנים (רק הטבלה, בלי לוגיקה בשלב 1)

```
coach_clients
├── coach_id FK → profiles, client_id FK → profiles
├── status text                -- 'pending' | 'active' | 'revoked'
├── scopes text[]              -- {'workouts','sleep','nutrition','weight'}: לא הכול חייב להיות גלוי
└── granted_at
PK (coach_id, client_id)
```

### קשרים

```
auth.users 1─1 profiles
profiles 1─* data_sources 1─* (health_samples | workouts | sleep_sessions | ingest_events)
profiles 1─* meals 1─* meal_items
profiles 1─* daily_summaries        (נגזרת מכל השאר)
profiles 1─* coach_memory, goals, nutrition_targets, training_plans, messages
profiles *─* profiles  דרך coach_clients   (עתידי)
```

---

## 5. אבטחה (RLS)

**העיקרון:** מידע בריאותי הוא "מידע בעל רגישות מיוחדת" לפי חוק הגנת הפרטיות (תיקון 13). גם בשלב האישי בונים כאילו זה כבר מוצר.

| טבלה | SELECT | INSERT/UPDATE/DELETE |
|---|---|---|
| כל טבלאות הנתונים | `auth.uid() = user_id` | `auth.uid() = user_id` |
| `health_samples`, `workouts`, `sleep_sessions`, `daily_summaries` | בעלת המידע, ו**בעתיד** מאמן עם `coach_clients.status='active'` וה-scope המתאים | **רק service role** (Edge Functions). הלקוח לא כותב דגימות ישירות |
| `ingest_events`, `data_sources.ingest_token_hash` | בעלת המידע (בלי עמודת ה-hash) | service role בלבד |
| `coach_clients` | שני הצדדים | רק המתאמן/ת יכול/ה לאשר או לבטל |

```sql
-- דפוס בסיסי (single-tenant per user)
create policy "own rows" on public.health_samples
  for select to authenticated using (user_id = auth.uid());

-- דפוס עתידי למאמן (לא מופעל בשלב 1)
create policy "coach reads permitted clients" on public.workouts
  for select to authenticated using (
    exists (select 1 from public.coach_clients cc
            where cc.client_id = workouts.user_id
              and cc.coach_id = auth.uid()
              and cc.status = 'active'
              and 'workouts' = any(cc.scopes)));
```

**נקודות אבטחה נוספות:**
- **Ingest token:** Health Auto Export יודע לשלוח רק header סטטי. לכן כל `data_source` מקבל טוקן אקראי ארוך, ובדאטהבייס נשמר רק ה-hash (SHA-256). אם הטוקן דולף, מבטלים את המקור ומנפיקים חדש.
- **Telegram webhook:** מאמתים את ה-header `X-Telegram-Bot-Api-Secret-Token`. רק `chat_id` מקושר מקבל מענה, וכל השאר מקבלים "לא מוכר".
- **Storage:** bucket פרטי `meal-photos`, נתיב `{user_id}/{meal_id}.jpg`, עם RLS על `storage.objects`.
- **LLM:** שולחים למודל רק את מה שהוא צריך (סיכומים, לא raw). מפתחות API נשמרים ב-Edge Function secrets.

---

## 6. API Surface (Supabase Edge Functions)

### `POST /functions/v1/ingest-healthkit`
- **Auth:** `Authorization: Bearer <ingest_token>` → hash → מוצאים `data_source` ו-`user_id`. בלי JWT.
- **Input:** ה-JSON של Health Auto Export (`data.metrics[]`, `data.workouts[]`).
- **מה קורה:** (1) שמירה ב-`ingest_events`; (2) המתאם `adapters/health-auto-export.ts` ממיר למודל הקנוני ומנרמל יחידות; (3) upsert עם `on conflict do nothing`; (4) סימון הימים שהושפעו לחישוב מחדש.
- **Output:** `200 { inserted, duplicates, days_affected }`.
- **שגיאות:** 401 טוקן לא תקין; 413 payload גדול מדי; 422 פורמט לא מוכר (ה-payload נשמר עם `failed` להרצה מחדש).
- **אידמפוטנטיות:** שליחה חוזרת של אותו payload לא יוצרת כפילויות, בזכות ה-UNIQUE constraints.

### `POST /functions/v1/telegram-webhook`
- **Auth:** secret token של טלגרם.
- **Input:** Telegram Update (טקסט, תמונה, קול, callback של כפתורים).
- **מה קורה:**
  - `/start <code>`: קישור `chat_id` למשתמשת.
  - **תמונה** → הורדה → Storage → מודל ראייה מעריך את הארוחה → נשמר כ-`estimated` → נשלחת הודעה עם כפתורים `✅ נכון` / `✏️ לתקן`.
  - **קול** → תמלול (Whisper, כמו ב-SmartBiz) → מטופל כטקסט.
  - **טקסט** → לולאת הסוכן (סעיף 7).
- **חשוב:** טלגרם מצפה לתשובה מהירה ושולח שוב אם לא קיבל. לכן מחזירים 200 מיד וממשיכים לעבד ברקע (`EdgeRuntime.waitUntil`). מונעים עיבוד כפול לפי `update_id`.

### `POST /functions/v1/coach-scheduled`
- **Auth:** service role בלבד (נקרא מ-`pg_cron` דרך `pg_net`).
- **Input:** `{ kind: 'morning_brief' | 'weekly_review' | 'missing_meal_nudge', user_id }`.
- **מה קורה:** מריץ את הסוכן עם prompt ייעודי ושולח לטלגרם.

### פונקציות SQL (RPC)
- `recompute_daily_summary(user_id, day)`: מחשבת שורה ב-`daily_summaries` כולל baselines של 28 יום ו-recovery score.
- `get_trend(user_id, metric, from, to, bucket)`: מחזירה מגמה מקובצת לפי יום או שבוע.

---

## 7. הסוכן: איך הוא "חושב"

> 🧠 **מושג: Tool Use / Agent Loop.** הסוכן לא מקבל את כל הדאטהבייס ב-prompt. הוא מקבל **כלים** (פונקציות) ומחליט לבד מה לשלוף. כשאת שואלת "למה אני עייפה?", הוא קורא ל-`get_daily_summaries(14 days)` ול-`get_sleep(7 days)`, רואה ש-HRV ירד ב-18% מה-baseline ושישנת בממוצע 5:50, ורק אז עונה. ככה התשובות מבוססות נתונים ולא המצאה.

### מבנה ה-prompt
1. **System (קבוע, ב-cache):** הפרסונה (מאמן כושר ותזונאי בכיר, ישיר, מבוסס ראיות, מדבר עברית), עקרונות מקצועיים (progressive overload, periodization, חלבון 1.6–2.2 גרם לק"ג, עדיפות לשינה, גירעון קלורי מתון), **גבולות בטיחות**.
2. **Context (דינמי, קומפקטי):** פרופיל, יעדים פעילים, יעדי תזונה, `coach_memory` פעיל, 7 הימים האחרונים מ-`daily_summaries`, תוכנית השבוע.
3. **History:** 20 ההודעות האחרונות.

### כלים
| כלי | מה עושה |
|---|---|
| `get_daily_summaries(from, to)` | מדדים יומיים |
| `get_workouts(from, to, type?)` | אימונים |
| `get_sleep(from, to)` | שינה |
| `get_trend(metric, from, to, bucket)` | מגמות ארוכות |
| `get_meals(from, to)` | ארוחות |
| `log_meal(items[], eaten_at, meal_type)` | רישום או תיקון ארוחה |
| `remember(category, content)` / `forget(id)` | ניהול זיכרון ארוך טווח |
| `propose_nutrition_targets(...)` | הצעת יעדים. נכנסת לתוקף רק אחרי אישור בכפתור |
| `save_training_plan(week_start, plan)` | שמירת תוכנית אימונים |

### בחירת מודל
- **שיחה רגילה והערכת ארוחות מתמונה:** Claude Sonnet. מאזן טוב בין איכות, מהירות ומחיר, ותומך בתמונות.
- **סיכום שבועי ובניית תוכנית:** Claude Opus. חשיבה עמוקה יותר, פעם בשבוע, כך שהעלות זניחה.
- המודלים מוגדרים ב-env ולא בקוד, כדי שיהיה קל להחליף.
- **Prompt caching** על ה-system prompt וההקשר הקבוע חוסך עלות משמעותית בשיחות חוזרות.

### גבולות בטיחות (חלק מה-system prompt ומהקוד)
- **לא מאבחן.** במקרה של דופק במנוחה חריג לאורך כמה ימים, כאב בחזה, סחרחורת או עילפון, הסוכן ממליץ לפנות לרופא ולא ממשיך "לאמן".
- **רצפת קלוריות:** לא ממליץ על פחות מ-BMR וגם לא על גירעון של יותר מ-~20–25% בלי השגחה. בדיקה בקוד, לא רק ב-prompt.
- רגישות לדפוסי אכילה: בלי שיפוטיות ובלי שפה של "אכלת רע".
- תמיד אומר כשהוא **מעריך** (קלוריות מתמונה) ולא יודע בוודאות.

---

## 8. Data Flow: שלושה תרחישים מרכזיים

**(א) סנכרון רקע מהשעון**
> Apple Watch → HealthKit באייפון → Health Auto Export (כל 15–30 דק') → `POST ingest-healthkit` → אימות טוקן → `ingest_events` → adapter → upsert ל-`health_samples`/`workouts`/`sleep_sessions` → `recompute_daily_summary` לימים שהושפעו.

**(ב) צילום ארוחה**
> תמונה בטלגרם → `telegram-webhook` → 200 מיידי → הורדה מטלגרם → Storage → Claude vision עם הקשר (יעדי תזונה, מה נאכל היום) → `meals` (`estimated`) → "זיהיתי: חזה עוף ~150 גרם, אורז ~1 כוס, סלט. בערך 620 קק"ל, 45 גרם חלבון. נשארו לך היום 55 גרם חלבון." [✅ נכון] [✏️ לתקן] → אישור → `confirmed` → עדכון `daily_summaries`.

**(ג) תדריך בוקר**
> `pg_cron` 07:00 Asia/Jerusalem → `coach-scheduled(morning_brief)` → הסוכן קורא את השינה של הלילה, את ה-recovery מול ה-baseline ואת התוכנית להיום → "ישנת 7:10, HRV 8% מעל הממוצע שלך. יום טוב לאימון הכוח שתוכנן. יעד חלבון: 120 גרם." → טלגרם.

---

## 9. מבנה תיקיות

```
health-agent/
├── docs/
│   ├── ARCHITECTURE.md            ← המסמך הזה
│   └── setup-health-auto-export.md  -- מדריך הגדרה באייפון
├── supabase/
│   ├── config.toml
│   ├── migrations/                -- כל שינוי סכימה הוא קובץ SQL ממוספר
│   │   ├── 0001_profiles_sources.sql
│   │   ├── 0002_health_data.sql
│   │   ├── 0003_nutrition.sql
│   │   ├── 0004_agent.sql
│   │   ├── 0005_rls.sql
│   │   └── 0006_cron.sql
│   ├── seed.sql
│   └── functions/
│       ├── _shared/
│       │   ├── adapters/          -- מתאם לכל מקור; כולם מחזירים CanonicalBatch
│       │   │   ├── types.ts       -- המודל הקנוני ב-TypeScript
│       │   │   └── health-auto-export.ts
│       │   ├── agent/
│       │   │   ├── system-prompt.he.md
│       │   │   ├── tools.ts       -- הגדרת הכלים + המימוש שלהם
│       │   │   ├── loop.ts        -- לולאת tool-use
│       │   │   └── safety.ts      -- בדיקות קשיחות (רצפת קלוריות, דגלים אדומים)
│       │   ├── telegram.ts
│       │   ├── supabase.ts        -- service client
│       │   └── units.ts           -- המרות יחידות
│       ├── ingest-healthkit/index.ts
│       ├── telegram-webhook/index.ts
│       └── coach-scheduled/index.ts
└── tests/
    └── fixtures/                  -- payloads אמיתיים (אנונימיים) לבדיקת המתאמים
```

> **למה Edge Functions ולא n8n כאן?** n8n מצוין לחיבור מערכות (כמו ב-Migdalor), אבל לולאת סוכן עם כלים, היסטוריה וזיכרון היא **לוגיקה**, ונוח יותר לבדוק אותה, לנהל לה גרסאות ב-git ולדבג אותה כקוד TypeScript. אפשר להוסיף n8n בהמשך לאינטגרציות צד (למשל WhatsApp).

---

## 10. מקרי קצה

- **אזורי זמן:** כל הזמנים נשמרים ב-UTC (`timestamptz`). "יום" מחושב לפי `profiles.timezone`. שינה שחוצה חצות משויכת ליום ההתעוררות. גם בנסיעה לחו"ל ה-timezone נשאר כפי שהוגדר, אלא אם משנים אותו.
- **כפילויות:** Health Auto Export שולח חלונות חופפים. ה-UNIQUE constraints וה-`on conflict do nothing` פותרים את זה.
- **כמה מקורות לאותו מדד:** צעדים מגיעים גם מהאייפון וגם מהשעון. HealthKit כבר מנכה כפילויות במדדים מצטברים כשמייצאים aggregated, ולכן נייצא aggregated לצעדים ולאנרגיה ו-raw לדופק ו-HRV. צריך לוודא זאת מול payload אמיתי.
- **פערים בנתונים:** אם השעון לא נטען, הסוכן מקבל `null` ולא אפס, ונאמר לו במפורש לא להסיק מסקנות מחוסר מידע.
- **יחידות:** HealthKit יכול לשלוח lb או kg, ו-kJ או kcal. ממירים ליחידה קנונית במתאם עם טבלת המרות אחת.
- **Payload ענק בסנכרון ראשון:** היסטוריה של שנים. נעשה backfill חד-פעמי בקבוצות של חודש ונשאיר את ה-cron רק לנתונים חדשים.
- **הערכת קלוריות שגויה:** תמיד מסומנת כ-`estimated` עד אישור, עם `confidence`.
- **עברית:** תמלול Whisper בעברית טוב אבל לא מושלם, ולכן הסוכן חוזר על מה שהבין לפני שהוא רושם.
- **עלויות LLM:** מגבלה יומית של הודעות או טוקנים למשתמש, כבר עכשיו, כדי שזה יעבוד גם ב-SaaS.

---

## 11. שאלות פתוחות (צריך החלטה שלך)

1. **Health Auto Export:** את מוכנה לרכוש את האפליקציה (פיצ'ר ה-REST API בתשלום)? או שמעדיפה לקפוץ ישר לאפליקציית iOS משלך (C)?
2. **Supabase:** פרויקט חדש ייעודי (מומלץ, כי מידע בריאותי לא צריך לשבת ליד ה-CRM) או פרויקט קיים?
3. **אילו מדדים חשובים לך?** הצעה: שינה, HRV, דופק במנוחה, צעדים, אנרגיה פעילה, אימונים, משקל, VO2max. יש עוד? (מחזור חודשי? משמעותי מאוד לאימון ולתזונה אצל נשים, אבל רגיש. אופציונלי.)
4. **ספק LLM:** Claude לסוכן (מומלץ, בגלל tool use ועברית) ו-OpenAI Whisper לתמלול בלבד. מקובל?
5. **מטרות נוכחיות:** ירידה בשומן? כוח? סיבולת? זה קובע את הפרסונה ואת ברירות המחדל.
6. **תדירות פרואקטיבית:** תדריך בוקר כל יום + סיכום שבועי ביום ראשון בערב? תזכורת אם לא דיווחת ארוחה עד 14:00?

---

## 12. סדר מימוש

| שלב | מה | תוצאה שאפשר לבדוק |
|---|---|---|
| **0** | פרויקט Supabase, טלגרם בוט (BotFather), Health Auto Export מותקן | — |
| **1** | מיגרציות 0001–0002 + RLS + `ingest-healthkit` + מתאם + fixtures | נתונים מהשעון מופיעים בטבלאות |
| **2** | `recompute_daily_summary` + baselines + recovery score | שורה יומית נכונה ב-`daily_summaries` |
| **3** | `telegram-webhook` בסיסי + קישור + לולאת סוכן עם כלי קריאה | אפשר לשאול "איך ישנתי השבוע?" |
| **4** | ארוחות: תמונה וקול → הערכה → אישור | רישום תזונה מלא |
| **5** | זיכרון, יעדי תזונה, תוכנית אימונים, בטיחות | הסוכן "מכיר" אותך |
| **6** | `pg_cron`: תדריך בוקר + סיכום שבועי | הסוכן יוזם |
| **עתיד** | דשבורד ווב (כולל design system), מאמנים, מקורות נוספים, אפליקציית iOS | — |

אין UI ווב בשלב 1, ולכן גם אין שלב design system כרגע. הוא ייכנס כשנגיע לדשבורד.
