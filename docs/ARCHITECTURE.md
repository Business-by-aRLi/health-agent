# Health Agent — מסמך ארכיטקטורה (v0.2)

> סטטוס: **v0.1 אושר**, עם התשובות לשאלות הפתוחות (סעיף 11). שלב 1 (קליטת נתונים) ושלב 2 (סיכום יומי) נבנים.
> הסעיפים שמסומנים 🆕 נוספו בעקבות הבקשות החדשות (בדיקות דם, תרופות ותוספים, סוגי תוכניות תזונה, לוח זמנים) ו**ממתינים לאישורך** לפני שמקודדים אותם.

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
├── focus_areas text[] default {sleep,steps,heart_rate,workouts}
│                              -- 🆕 הדגשים של המשתמש. משפיע רק על מה שהסוכן מדגיש,
│                              --    לא על מה שנשמר: קולטים הכול, מדגישים מה שחשוב לו
├── notification_prefs jsonb   -- 🆕 { evening_summary_at: "21:30", pre_workout_lead_min: 90,
│                              --      morning_fallback_at: "07:00", quiet_hours: ["23:00","06:30"] }
└── created_at, updated_at

goals
├── id uuid PK, user_id FK
├── kind text                  -- 'weight' | 'body_fat' | 'steps' | 'sleep' | 'strength' | 'race' | 'custom'
├── target_value numeric, unit text, target_date date
├── status text                -- 'active' | 'achieved' | 'paused'
└── notes text

-- (nutrition_targets הוחלפה ב-nutrition_plans, ראו 4.4)
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
├── value numeric             -- ממוצע אם המקור שולח min/avg/max (דופק)
├── value_min, value_max numeric
├── unit text                  -- תמיד ביחידה קנונית: kg, bpm, ms, kcal, count
├── meta jsonb                 -- מידע ספציפי למקור
UNIQUE (user_id, source_id, metric, start_at, end_at)   -- מונע כפילויות כשהמקור שולח שוב חלון חופף
INDEX (user_id, metric, start_at desc)                  -- השאילתה הנפוצה: "מדד X לטווח תאריכים"

workouts                       -- 🆕 "כל הפרטים הפנימיים": שלוש שכבות
├── id uuid PK, user_id FK, source_id FK
├── external_id text           -- ה-UUID של HealthKit
├── activity_name text         -- כפי שהגיע: "Outdoor Run"
├── activity_type text         -- מנורמל: 'outdoor_run' | 'traditional_strength_training' ...
├── start_at, end_at, duration_s
├── active_kcal, total_kcal, distance_m, elevation_up_m, avg_hr, max_hr, min_hr numeric
├── is_indoor boolean, location text
├── metrics jsonb              -- (1) כל שדה סקלרי נוסף שהגיע, מנורמל ליחידות שלנו:
│                              --     intensity, temperature, humidity, avg_speed, cadence, power, swim strokes...
├── raw jsonb                  -- (2) האובייקט המקורי בלי הסדרות הכבדות. לא מאבדים אף שדה
├── perceived_effort int null  -- RPE 1–10, הסוכן שואל אחרי אימון
├── planned_session_id FK null -- 🆕 קישור לאימון המתוכנן (תוכנן מול בוצע)
└── notes text
UNIQUE (user_id, source_id, external_id)

workout_samples                -- (3) סדרות זמן בתוך אימון: דופק, התאוששות דופק, צעדים,
├── workout_id FK cascade      --     מרחק, אנרגיה, מהירות. כל מערך עם date נכנס לכאן
├── metric text, at timestamptz
├── value, value_min, value_max numeric, unit text
PK (workout_id, metric, at)

workout_route_points           -- מסלול GPS (ריצה, הליכה, אופניים)
├── workout_id FK cascade, at timestamptz
├── lat, lon, altitude_m, speed_mps, course_deg, h_accuracy_m, v_accuracy_m
PK (workout_id, at)

sleep_sessions
├── id uuid PK, user_id FK, source_id FK
├── sleep_date date            -- היום שבו התעוררת (לא היום שבו נרדמת)
├── in_bed_start, in_bed_end, asleep_start, asleep_end timestamptz
├── total_asleep_min, rem_min, core_min, deep_min, awake_min, in_bed_min numeric
├── stages jsonb               -- רצף השלבים המלא (אם המקור שולח אותו)
UNIQUE (user_id, source_id, sleep_date)

daily_summaries                -- טבלה מחושבת: מה שהסוכן קורא רוב הזמן
├── user_id, day date          PK (user_id, day)
├── steps, active_kcal, exercise_min, workouts_count, workout_min
├── hr_min, hr_max, walking_hr
├── resting_hr, hrv_avg, sleep_min, sleep_efficiency
├── weight_kg
├── kcal_in, protein_g, carbs_g, fat_g      -- מהארוחות (שלב 4)
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
├── kcal, protein_g, carbs_g, fat_g, fiber_g numeric
└── glycemic_load_est numeric  -- 🆕 הערכה, רלוונטי לתוכנית שמירה על סוכר
```

#### 🆕 תוכניות תזונה

הסוכן **לא** בוחר תוכנית לבד. הוא מנהל ראיון קצר וממוקד (מטרה, שגרה, העדפות, בדיקות דם, תרופות), מציע תוכנית עם נימוק, ורק אחרי אישור בכפתור היא נכנסת לתוקף. אפשר לשלב כמה תוכניות: למשל גירעון מתון יחד עם הגברת חלבון.

```
nutrition_plans                -- גרסאות, לא דריסה: תמיד אפשר לראות מה היה קודם ולמה השתנה
├── id uuid PK, user_id FK
├── plan_types text[]          -- {'calorie_deficit','high_protein','glycemic_control',
│                              --  'maintenance','muscle_gain','anti_inflammatory','custom'}
├── kcal_target int, protein_g int, carbs_g int, fat_g int, fiber_g int   -- כולם nullable
├── rules jsonb                -- כללים שאי אפשר לבטא במספר יומי. דוגמה ל-glycemic_control:
│                              -- { max_carbs_per_meal_g: 45, pair_carbs_with_protein: true,
│                              --   prefer_low_gi: true, post_meal_walk_min: 10 }
│                              -- דוגמה ל-high_protein: { min_protein_per_meal_g: 30, meals_per_day: 4 }
├── rationale text             -- למה התוכנית הזו, כולל הפניה לבדיקות דם אם רלוונטי
├── status text                -- 'proposed' | 'active' | 'superseded'
├── valid_from date, valid_to date null
├── created_by text            -- 'agent' | 'user' | 'coach'
└── approved_at timestamptz
-- לכל משתמש לכל היותר תוכנית אחת active (partial unique index)
```

כל ארוחה נבדקת מול התוכנית הפעילה, ו-`meals.plan_feedback jsonb` שומר את המשוב ("ארוחה עשירה בפחמימות בלי חלבון, מומלץ להוסיף ביצה או יוגורט"). כך בסיכום הלילה אפשר להגיד "4 מתוך 5 ארוחות עמדו בכללי הסוכר".

### 🆕 4.4ב הקשר רפואי: בדיקות דם, תרופות ותוספים

```
lab_reports                    -- קובץ שהועלה (PDF או צילום) בטלגרם
├── id uuid PK, user_id FK
├── taken_on date              -- תאריך הבדיקה (לא תאריך ההעלאה)
├── lab_name text              -- מכבי / כללית / לאומית / פרטי
├── file_path text             -- bucket פרטי lab-reports
├── status text                -- 'uploaded' | 'extracted' | 'confirmed'
└── extraction_notes text      -- מה לא הצליח להיקרא

lab_results                    -- שורה לכל ערך: זה מה שהסוכן שואל עליו
├── id uuid PK, report_id FK cascade, user_id FK
├── analyte_code text          -- קוד מנורמל: 'hba1c','glucose_fasting','ferritin','b12','vit_d',
│                              --  'tsh','ldl','hdl','triglycerides','hemoglobin','crp'...
├── analyte_name_raw text      -- בדיוק כפי שהופיע בדו"ח ("המוגלובין A1C")
├── value numeric, unit text, value_text text  -- value_text לתוצאות לא מספריות
├── ref_low, ref_high numeric  -- טווח הייחוס **מהדו"ח עצמו** (משתנה בין מעבדות)
├── flag text                  -- 'low' | 'normal' | 'high'. נגזר מטווח הדו"ח
└── taken_on date              -- משוכפל מה-report, לשאילתות מגמה מהירות
INDEX (user_id, analyte_code, taken_on desc)

medications                    -- תרופות ותוספים באותה טבלה, מופרדים ב-kind
├── id uuid PK, user_id FK
├── kind text                  -- 'medication' | 'supplement'
├── name text                  -- "אלטרוקסין", "מגנזיום ציטרט"
├── active_ingredient text     -- levothyroxine, magnesium. לבדיקת אינטראקציות
├── dose numeric, dose_unit text, frequency text, timing text   -- "בבוקר על קיבה ריקה"
├── reason text, prescribed_by text
├── started_on date, stopped_on date null
└── active boolean generated   -- stopped_on is null
```

> 🧠 **למה טבלה ל-`lab_results` ולא jsonb בדו"ח?** כי השאלה שהסוכן ישאל היא "מה המגמה של הפריטין בשנתיים האחרונות?". כשכל ערך הוא שורה עם `analyte_code` מנורמל, זו שאילתה פשוטה עם אינדקס. ב-jsonb זה היה חיפוש בתוך מסמכים. **כלל אצבע:** אם שואלים על משהו לאורך זמן, הוא שורה ולא שדה בתוך JSON.

**איך זה נכנס:** שולחים PDF או צילום בטלגרם, Claude מחלץ את הערכים (כולל טווחי הייחוס מהדו"ח), ואת מקבלת טבלה מסוכמת לאישור. רק ערכים שאושרו משפיעים על ההמלצות. תרופות ותוספים נכנסים בשיחה ("התחלתי לקחת ויטמין D 2000 יחידות").

**איך הסוכן משתמש בזה:** בכל המלצה, הקשר "הרפואי" הפעיל (ערכים חריגים מהבדיקה האחרונה ותרופות פעילות) נכנס ל-context. דוגמאות להתנהגות רצויה:
- פריטין נמוך: מעדיף מקורות ברזל, מצמיד ויטמין C, ממליץ לא לשתות קפה ותה עם הארוחה, מתחשב בעייפות באימוני סיבולת.
- HbA1c גבולי: מציע תוכנית `glycemic_control`.
- לבותירוקסין: מזכיר להפריד מסידן, ברזל וקפה (כ-4 שעות לסידן וברזל).
- מטפורמין לאורך זמן: מציע לבדוק B12 בבדיקה הבאה.
- חוסם בטא: מסביר שהדופק באימון לא יעלה כרגיל, ולכן אזורי הדופק פחות אמינים ועדיף RPE.

**גבולות קשיחים (בקוד, לא רק ב-prompt):** הסוכן **אף פעם** לא ממליץ להפסיק תרופה, לשנות מינון או להחליף תרופה. בערך חריג משמעותי (למשל המוגלובין נמוך מאוד או אשלגן חריג) ההודעה הראשונה היא "כדאי לדבר עם הרופא/ה", ורק אחר כך כל השאר. רשימת אינטראקציות ידועה נשמרת כקובץ שמנוהל ב-git (`interactions.json`), כדי שלא נסמוך רק על הזיכרון של המודל.

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

planned_sessions               -- 🆕 במקום training_plans: שורה לכל אימון מתוכנן
├── id uuid PK, user_id FK
├── planned_date date, planned_start time null   -- השעה קובעת מתי נשלח תדריך לפני אימון
├── activity_type text, title text               -- "ריצת נפח קלה 40 דק'"
├── details jsonb              -- אזורי דופק, סטים וחזרות, מרחק יעד
├── status text                -- 'planned' | 'done' | 'skipped' | 'moved'
├── workout_id FK null         -- מקושר אוטומטית לאימון שבוצע (אותו יום, אותו סוג)
├── created_by text, change_reason text          -- "הוזז כי ישנת 5 שעות"
└── updated_at

outbound_notifications         -- 🆕 מונע שליחה כפולה של תדריך
├── user_id, kind text ('evening_summary'|'pre_workout'|'morning_fallback'|'weekly_review')
├── ref_key text               -- התאריך, או ה-id של האימון
├── sent_at, telegram_message_id
UNIQUE (user_id, kind, ref_key)
```

> 🧠 **למה שורה לכל אימון ולא jsonb של שבוע?** כי בשיחת הלילה את תגידי "תזיז את הריצה של מחר לחמישי". עם שורות זה `update` של שורה אחת, יש היסטוריה (`change_reason`), ואפשר לקשר אימון שבוצע לאימון שתוכנן. כשכל השבוע יושב ב-jsonb אחד, כל שינוי הוא "קרא הכול, שנה, כתוב הכול", וזה מקור לבאגים.

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
profiles 1─* nutrition_plans, planned_sessions 1─0..1 workouts
profiles 1─* lab_reports 1─* lab_results
profiles 1─* medications
workouts 1─* workout_samples, workout_route_points
profiles 1─* daily_summaries        (נגזרת מכל השאר)
profiles 1─* coach_memory, goals, messages, outbound_notifications
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
| 🆕 `lab_reports`, `lab_results`, `medications` | בעלת המידע **בלבד**. גם בעתיד מאמן לא רואה אותם, אלא אם נוסף scope `medical` מפורש | בעלת המידע + service role |

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
- **Storage:** buckets פרטיים `meal-photos` ו-`lab-reports` 🆕, נתיב `{user_id}/{id}.{ext}`, עם RLS על `storage.objects`. הקבצים נגישים רק דרך signed URLs קצרי חיים.
- **LLM:** שולחים למודל רק את מה שהוא צריך (סיכומים, לא raw). מפתחות API נשמרים ב-Edge Function secrets.

---

## 6. API Surface (Supabase Edge Functions)

### `POST /functions/v1/ingest-healthkit`
- **Auth:** `Authorization: Bearer <ingest_token>` → hash → מוצאים `data_source` ו-`user_id`. בלי JWT.
- **Input:** ה-JSON של Health Auto Export (`data.metrics[]`, `data.workouts[]`).
- **מה קורה:** (1) שמירה ב-`ingest_events`; (2) המתאם `adapters/health-auto-export.ts` ממיר למודל הקנוני ומנרמל יחידות; (3) קריאה **אחת** ל-RPC `ingest_canonical_batch`, שמבצע את כל ה-upserts בטרנזקציה אחת ומחשב מחדש את `daily_summaries` לימים שהושפעו.
- **Output:** `200 { samples, workouts, sleep_sessions, days_affected }`.
- **שגיאות:** 401 טוקן לא תקין; 413 payload גדול מדי; 422 פורמט לא מוכר (ה-payload נשמר עם `failed` להרצה מחדש).
- **אידמפוטנטיות:** שליחה חוזרת של אותו payload לא יוצרת כפילויות, בזכות ה-UNIQUE constraints.
- **סטטוס:** ✅ פרוס (`verify_jwt = false`, אימות עצמי לפי טוקן). מדריך החיבור: [`setup-health-auto-export.md`](setup-health-auto-export.md).

### `POST /functions/v1/telegram-webhook`
- **Auth:** secret token של טלגרם.
- **Input:** Telegram Update (טקסט, תמונה, קול, callback של כפתורים).
- **מה קורה:**
  - `/start <code>`: קישור `chat_id` למשתמשת.
  - **תמונה** → הורדה → Storage → מודל ראייה מעריך את הארוחה → נשמר כ-`estimated` → נשלחת הודעה עם כפתורים `✅ נכון` / `✏️ לתקן`.
  - **קול** → תמלול (Whisper, כמו ב-SmartBiz) → מטופל כטקסט.
  - **טקסט** → לולאת הסוכן (סעיף 7).
- **חשוב:** טלגרם מצפה לתשובה מהירה ושולח שוב אם לא קיבל. לכן מחזירים 200 מיד וממשיכים לעבד ברקע (`EdgeRuntime.waitUntil`). מונעים עיבוד כפול לפי `update_id`.

### `POST /functions/v1/coach-scheduled` 🆕
- **Auth:** service role בלבד. `pg_cron` קורא לה **כל 15 דקות** דרך `pg_net`.
- **מה קורה:** הפונקציה שואלת את הדאטהבייס מה "הגיע זמנו" לכל משתמש, לפי `notification_prefs` ו-timezone:
  - **סיכום לילה** (ברירת מחדל 21:30): איך היה היום מול התוכנית (צעדים, אימון, תזונה מול התוכנית הפעילה), ומה מחר (אימון מתוכנן, שעה, דגשים). מסתיים בשאלה פתוחה: "רוצה לשנות משהו למחר?". מכאן ממשיכים בשיחה רגילה, והסוכן יכול להזיז או לשנות `planned_sessions`.
  - **תדריך לפני אימון:** `pre_workout_lead_min` דקות (ברירת מחדל 90) לפני `planned_start`. כולל שינה והתאוששות מהלילה, התאמת עצימות אם צריך ("HRV נמוך ב-20%, נוריד לאזור 2"), ומה לאכול לפני.
  - **בוקר בלי אימון מתוכנן:** הודעה קצרה ב-`morning_fallback_at`, או בכלל לא, לפי בחירה.
  - **סיכום שבועי:** ביום ובשעה שנקבעו.
- **מניעת כפילויות:** לפני שליחה, `insert into outbound_notifications ... on conflict do nothing returning`. אם לא חזרה שורה, ההודעה כבר נשלחה.

> 🧠 **למה cron כל 15 דקות ולא cron לכל הודעה?** כי לכל משתמש יש שעות אחרות, ושעת האימון משתנה מיום ליום. במקום לנהל מאות jobs, יש job אחד שבודק "למי הגיע הזמן". זה נקרא **polling scheduler**, והוא פשוט, עמיד לשינויים וסקיילבילי.

### פונקציות SQL (RPC)
- `ingest_canonical_batch(source_id, batch)`: כל הכתיבה של קליטת נתונים, בטרנזקציה אחת. זמינה רק ל-service role.
- `recompute_daily_summary(user_id, day)`: מחשבת שורה ב-`daily_summaries` כולל baselines של 28 יום ו-recovery score.
- `get_trend(user_id, metric, from, to, bucket)`: מחזירה מגמה מקובצת לפי יום או שבוע.

---

## 7. הסוכן: איך הוא "חושב"

> 🧠 **מושג: Tool Use / Agent Loop.** הסוכן לא מקבל את כל הדאטהבייס ב-prompt. הוא מקבל **כלים** (פונקציות) ומחליט לבד מה לשלוף. כשאת שואלת "למה אני עייפה?", הוא קורא ל-`get_daily_summaries(14 days)` ול-`get_sleep(7 days)`, רואה ש-HRV ירד ב-18% מה-baseline ושישנת בממוצע 5:50, ורק אז עונה. ככה התשובות מבוססות נתונים ולא המצאה.

### מבנה ה-prompt
1. **System (קבוע, ב-cache):** הפרסונה (מאמן כושר ותזונאי בכיר, ישיר, מבוסס ראיות, מדבר עברית), עקרונות מקצועיים (progressive overload, periodization, חלבון 1.6–2.2 גרם לק"ג, עדיפות לשינה, גירעון קלורי מתון), **גבולות בטיחות**.
2. **Context (דינמי, קומפקטי):** פרופיל ו-`focus_areas`, יעדים פעילים, **תוכנית התזונה הפעילה וכלליה**, `coach_memory` פעיל, 7 הימים האחרונים מ-`daily_summaries`, אימונים מתוכננים ל-7 הימים הבאים, 🆕 **הקשר רפואי**: תרופות ותוספים פעילים וערכים חריגים מהבדיקה האחרונה לכל `analyte`.
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
| `propose_nutrition_plan(types[], targets, rules, rationale)` 🆕 | הצעת תוכנית. נכנסת לתוקף רק אחרי אישור בכפתור |
| `get_workout_detail(id)` 🆕 | סדרות דופק, מסלול, ספליטים של אימון אחד |
| `plan_sessions(sessions[])` / `move_session(id, date, time, reason)` 🆕 | בנייה ושינוי של תוכנית האימונים בשיחה |
| `get_lab_history(analyte_codes[])` 🆕 | מגמת ערכי דם |
| `get_medications()` / `upsert_medication(...)` 🆕 | ניהול תרופות ותוספים |
| `check_interactions(context)` 🆕 | בדיקה מול `interactions.json`: תרופה↔תוסף, תרופה↔מזון, תזמון |

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
- 🆕 **תרופות:** אף פעם לא ממליץ להפסיק, לשנות מינון או להחליף. ממליץ על תוסף חדש רק אחרי בדיקת אינטראקציות, ותמיד עם "לבדוק מול הרופא/ה או הרוקח/ת".
- 🆕 **ערכי דם חריגים משמעותית:** קודם "פני לרופא/ה", רק אחר כך התאמות תזונה.

---

## 8. Data Flow: שלושה תרחישים מרכזיים

**(א) סנכרון רקע מהשעון**
> Apple Watch → HealthKit באייפון → Health Auto Export (כל 15–30 דק') → `POST ingest-healthkit` → אימות טוקן → `ingest_events` → adapter → upsert ל-`health_samples`/`workouts`/`sleep_sessions` → `recompute_daily_summary` לימים שהושפעו.

**(ב) צילום ארוחה**
> תמונה בטלגרם → `telegram-webhook` → 200 מיידי → הורדה מטלגרם → Storage → Claude vision עם הקשר (יעדי תזונה, מה נאכל היום) → `meals` (`estimated`) → "זיהיתי: חזה עוף ~150 גרם, אורז ~1 כוס, סלט. בערך 620 קק"ל, 45 גרם חלבון. נשארו לך היום 55 גרם חלבון." [✅ נכון] [✏️ לתקן] → אישור → `confirmed` → עדכון `daily_summaries`.

**(ג) סיכום לילה ושיחה על מחר** 🆕
> `pg_cron` (כל 15 דק') → 21:30 שלך → `coach-scheduled` → "היום: 9,800 צעדים, אימון כוח 52 דק', חלבון 104/120 גרם. 3/4 ארוחות לפי כללי התוכנית. מחר: ריצה קלה 40 דק' ב-07:00. רוצה לשנות משהו?" → את: "מחר אני מתחילה מוקדם בעבודה, אפשר בערב?" → הסוכן: `move_session(..., '18:30', 'שינוי לו״ז')` → "הזזתי ל-18:30. התדריך יגיע ב-17:00."

**(ד) תדריך לפני אימון** 🆕
> 90 דק' לפני `planned_start` → הסוכן קורא שינה, HRV ודופק במנוחה מול ה-baseline, והאם יש תרופה שמשפיעה על הדופק → "ישנת 7:10, HRV בטווח שלך. נשארים בתוכנית: 40 דק' באזור 2 (128–140). שעה לפני: בננה ויוגורט." → טלגרם.

**(ה) העלאת בדיקת דם** 🆕
> PDF בטלגרם → Storage (`lab-reports`) → Claude קורא את המסמך → `lab_reports` + `lab_results` (`extracted`) → "מצאתי 24 ערכים, 3 מחוץ לטווח: פריטין 12 (נמוך), ויטמין D 18 (נמוך), LDL 142 (גבוה). לאשר?" → אישור → `confirmed` → הסוכן מציע לעדכן את תוכנית התזונה בהתאם.

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
│   │   ├── 0001_core.sql          -- profiles, data_sources, updated_at triggers   ✅
│   │   ├── 0002_health_data.sql   -- ingest_events, samples, workouts, sleep    ✅
│   │   ├── 0003_daily_summaries.sql -- סיכום יומי + baselines + recovery        ✅
│   │   ├── 0004_ingest_rpc.sql    -- ingest_canonical_batch                    ✅
│   │   ├── 0005_nutrition.sql     -- meals, nutrition_plans
│   │   ├── 0006_medical.sql       -- labs, medications
│   │   ├── 0007_agent.sql         -- telegram, messages, memory, planned_sessions
│   │   └── 0008_cron.sql
│   │   (ה-RLS נכתב באותה מיגרציה שיוצרת את הטבלה, כדי שלא תהיה רגע טבלה בלי הגנה)
│   ├── seed.sql
│   └── functions/
│       ├── _shared/
│       │   ├── adapters/          -- מתאם לכל מקור; כולם מחזירים CanonicalBatch
│       │   │   ├── types.ts       -- המודל הקנוני ב-TypeScript
│       │   │   └── health-auto-export.ts
│       │   ├── agent/
│       │   │   ├── interactions.json  -- 🆕 אינטראקציות ידועות, מנוהל ב-git
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

### החלטות (23.10.2026)
1. **Health Auto Export:** נרכש לפיילוט. ✅
2. **Supabase:** פרויקט חדש ייעודי, `hwcgxyreboaqjoxrofgw`. ✅
3. **מדדים בפוקוס:** שינה, צעדים, דופק, **אימונים עם כל הפרטים**. קולטים הכול ומדגישים את אלה. בעתיד כל מתאמן בוחר את הפוקוס שלו (`profiles.focus_areas`). ✅
4. **LLM:** Claude לסוכן, Whisper לתמלול. ✅
5. **מטרות:** מעקב רציף וירידה קלה במשקל. מוגדר כ-`goals` שקל לשנות בשיחה, ולא כקוד. ✅
6. **תדירות:** סיכום לילה + "מה מחר" עם שיחה לשינוי התוכנית; תדריך בוקר לפני אימון מתוכנן; מעקב ארוחות מול תוכנית תזונה (גירעון / סוכר / חלבון / ...) שהסוכן מגבש בשיחה. ✅

### שאלות חדשות 🆕
1. **מחזור חודשי:** לקלוט מ-HealthKit (אם מתועד) ולהתחשב בו? יש לו השפעה אמיתית על התאוששות, רעב ושימור נוזלים.
2. **מצבים רפואיים:** להוסיף גם טבלת `health_conditions` (למשל תת-פעילות של בלוטת התריס או תנגודת לאינסולין), או להסתפק במה שעולה מהתרופות והבדיקות?
3. **שעת סיכום הלילה:** 21:30 מתאים? ושבועי: מוצאי שבת?

---

## 12. סדר מימוש

| שלב | מה | תוצאה שאפשר לבדוק |
|---|---|---|
| **0** | פרויקט Supabase ✅, טלגרם בוט (BotFather), Health Auto Export מותקן | — |
| **1** ✅ | מיגרציות 0001–0002, 0004 + RLS + `ingest-healthkit` + מתאם + בדיקות | נתונים מהשעון מופיעים בטבלאות |
| **2** ✅ | `recompute_daily_summary` + baselines + recovery score | שורה יומית נכונה ב-`daily_summaries` |
| **3** | `telegram-webhook` בסיסי + קישור + לולאת סוכן עם כלי קריאה | אפשר לשאול "איך ישנתי השבוע?" |
| **4** | תוכניות תזונה (ראיון → הצעה → אישור) + ארוחות מתמונה וקול → משוב מול התוכנית | רישום תזונה מלא |
| **5** 🆕 | בדיקות דם (PDF → חילוץ → אישור), תרופות ותוספים, `interactions.json` | הסוכן מתחשב בהקשר הרפואי |
| **6** | זיכרון, `planned_sessions`, שינוי תוכנית בשיחה, בטיחות | הסוכן "מכיר" אותך |
| **7** | `pg_cron`: סיכום לילה, תדריך לפני אימון, סיכום שבועי | הסוכן יוזם |
| **עתיד** | דשבורד ווב (כולל design system), מאמנים, מקורות נוספים, אפליקציית iOS | — |

אין UI ווב בשלב 1, ולכן גם אין שלב design system כרגע. הוא ייכנס כשנגיע לדשבורד.
