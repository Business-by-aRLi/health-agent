-- =====================================================================
-- domain: מטרות, תזונה, הקשר רפואי, אימונים מתוכננים.
-- הטבלאות כאן הן "הידע" של הסוכן. בניגוד לנתוני השעון, המשתמש כן כותב
-- אותן (דרך הסוכן, ובעתיד דרך הדשבורד), ולכן ה-RLS נותן לבעלים גישה מלאה.
--
-- 🧠 policy אחת "for all" במקום ארבע (select/insert/update/delete): כשהכלל
--    זהה לכל הפעולות ("רק השורות שלך"), אחת מספיקה וקל יותר לקרוא אותה.
-- =====================================================================

-- ---------------------------------------------------------------------
-- goals: מטרות. גמישות בכוונה, כי המטרות משתנות בשיחה ולא בקוד.
-- ---------------------------------------------------------------------
create table public.goals (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  kind         text not null,                -- 'weight' | 'body_fat' | 'steps' | 'sleep' | 'strength' | 'race' | 'custom'
  title        text not null,                -- "ירידה קלה במשקל"
  target_value numeric,
  unit         text,
  target_date  date,
  status       text not null default 'active' check (status in ('active', 'achieved', 'paused', 'dropped')),
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index goals_user_idx on public.goals (user_id, status);

-- ---------------------------------------------------------------------
-- nutrition_plans: גרסאות. לכל היותר תוכנית אחת active למשתמש.
-- ---------------------------------------------------------------------
create table public.nutrition_plans (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  plan_types  text[] not null check (plan_types <@ array[
                'calorie_deficit', 'high_protein', 'glycemic_control', 'maintenance',
                'muscle_gain', 'anti_inflammatory', 'custom']::text[] and cardinality(plan_types) > 0),
  kcal_target integer check (kcal_target between 800 and 6000),   -- רצפה קשיחה: אף תוכנית מתחת ל-800
  protein_g   integer,
  carbs_g     integer,
  fat_g       integer,
  fiber_g     integer,
  rules       jsonb not null default '{}'::jsonb,
  rationale   text,
  status      text not null default 'proposed' check (status in ('proposed', 'active', 'superseded', 'rejected')),
  valid_from  date,
  valid_to    date,
  created_by  text not null default 'agent' check (created_by in ('agent', 'user', 'coach')),
  approved_at timestamptz,
  created_at  timestamptz not null default now(),
  constraint nutrition_plans_active_approved check (status <> 'active' or approved_at is not null)
);
-- 🧠 partial unique index: הייחודיות חלה רק על שורות active. אפשר הרבה superseded, רק active אחת.
create unique index nutrition_plans_one_active on public.nutrition_plans (user_id) where status = 'active';

-- ---------------------------------------------------------------------
-- meals + meal_items
-- ---------------------------------------------------------------------
create table public.meals (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  eaten_at      timestamptz not null,
  meal_type     text check (meal_type in ('breakfast', 'lunch', 'dinner', 'snack', 'pre_workout', 'post_workout')),
  input_kind    text not null check (input_kind in ('photo', 'voice', 'text')),
  media_path    text,
  transcript    text,
  status        text not null default 'estimated' check (status in ('estimated', 'confirmed', 'corrected')),
  total_kcal    numeric,
  protein_g     numeric,
  carbs_g       numeric,
  fat_g         numeric,
  fiber_g       numeric,
  confidence    numeric check (confidence between 0 and 1),
  plan_id       uuid references public.nutrition_plans (id) on delete set null,
  plan_feedback jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index meals_user_time_idx on public.meals (user_id, eaten_at desc);

create table public.meal_items (
  id                uuid primary key default gen_random_uuid(),
  meal_id           uuid not null references public.meals (id) on delete cascade,
  user_id           uuid not null references public.profiles (id) on delete cascade,
  name_he           text not null,
  quantity          numeric,
  unit              text,
  kcal              numeric,
  protein_g         numeric,
  carbs_g           numeric,
  fat_g             numeric,
  fiber_g           numeric,
  glycemic_load_est numeric
);
create index meal_items_meal_idx on public.meal_items (meal_id);

-- ---------------------------------------------------------------------
-- הקשר רפואי: בדיקות דם, תרופות ותוספים, מצבים רפואיים
-- ---------------------------------------------------------------------
create table public.lab_reports (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles (id) on delete cascade,
  taken_on         date not null,
  lab_name         text,
  file_path        text,
  status           text not null default 'uploaded' check (status in ('uploaded', 'extracted', 'confirmed')),
  extraction_notes text,
  created_at       timestamptz not null default now()
);
create index lab_reports_user_idx on public.lab_reports (user_id, taken_on desc);

create table public.lab_results (
  id               uuid primary key default gen_random_uuid(),
  report_id        uuid not null references public.lab_reports (id) on delete cascade,
  user_id          uuid not null references public.profiles (id) on delete cascade,
  analyte_code     text not null,          -- 'hba1c' | 'ferritin' | 'b12' | 'vit_d' | 'tsh' | 'ldl' ...
  analyte_name_raw text not null,          -- כפי שהופיע בדו"ח
  value            numeric,
  value_text       text,                   -- לתוצאות לא מספריות ("שלילי")
  unit             text,
  ref_low          numeric,                -- טווח הייחוס מהדו"ח עצמו, כי הוא משתנה בין מעבדות
  ref_high         numeric,
  -- 🧠 generated column: הדגל תמיד עקבי עם הערך והטווח, ואי אפשר "לשכוח לעדכן"
  flag             text generated always as (
                     case
                       when value is null or (ref_low is null and ref_high is null) then null
                       when ref_low  is not null and value < ref_low  then 'low'
                       when ref_high is not null and value > ref_high then 'high'
                       else 'normal'
                     end) stored,
  taken_on         date not null,
  constraint lab_results_has_value check (value is not null or value_text is not null)
);
create index lab_results_trend_idx on public.lab_results (user_id, analyte_code, taken_on desc);

create table public.medications (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles (id) on delete cascade,
  kind              text not null check (kind in ('medication', 'supplement')),
  name              text not null,
  active_ingredient text,
  dose              numeric,
  dose_unit         text,
  frequency         text,                  -- "פעם ביום"
  timing            text,                  -- "בבוקר על קיבה ריקה"
  reason            text,
  prescribed_by     text,
  started_on        date,
  stopped_on        date,
  active            boolean generated always as (stopped_on is null) stored,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index medications_user_active_idx on public.medications (user_id) where stopped_on is null;

create table public.health_conditions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  name         text not null,
  code         text,                       -- 'hypothyroidism' | 'insulin_resistance' | ...
  status       text not null default 'active' check (status in ('active', 'resolved', 'suspected')),
  diagnosed_on date,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index health_conditions_user_idx on public.health_conditions (user_id, status);

-- ---------------------------------------------------------------------
-- planned_sessions: שורה לכל אימון מתוכנן, וקישור לאימון שבוצע
-- ---------------------------------------------------------------------
create table public.planned_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  planned_date  date not null,
  planned_start time,                      -- שעה מקומית. קובעת מתי נשלח תדריך לפני אימון
  activity_type text not null,
  title         text not null,
  details       jsonb not null default '{}'::jsonb,
  status        text not null default 'planned' check (status in ('planned', 'done', 'skipped', 'moved')),
  workout_id    uuid references public.workouts (id) on delete set null,
  created_by    text not null default 'agent' check (created_by in ('agent', 'user', 'coach')),
  change_reason text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index planned_sessions_user_date_idx on public.planned_sessions (user_id, planned_date);

alter table public.workouts
  add constraint workouts_planned_session_fk
  foreign key (planned_session_id) references public.planned_sessions (id) on delete set null;

-- ---------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------
create trigger goals_updated_at             before update on public.goals             for each row execute function public.set_updated_at();
create trigger meals_updated_at             before update on public.meals             for each row execute function public.set_updated_at();
create trigger medications_updated_at       before update on public.medications       for each row execute function public.set_updated_at();
create trigger health_conditions_updated_at before update on public.health_conditions for each row execute function public.set_updated_at();
create trigger planned_sessions_updated_at  before update on public.planned_sessions  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- RLS: בעלים בלבד. מידע רפואי לא נחשף למאמן, גם לא בעתיד, בלי scope מפורש.
-- ---------------------------------------------------------------------
alter table public.goals             enable row level security;
alter table public.nutrition_plans   enable row level security;
alter table public.meals             enable row level security;
alter table public.meal_items        enable row level security;
alter table public.lab_reports       enable row level security;
alter table public.lab_results       enable row level security;
alter table public.medications       enable row level security;
alter table public.health_conditions enable row level security;
alter table public.planned_sessions  enable row level security;

create policy "goals: owner"             on public.goals             for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "meals: owner"             on public.meals             for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "meal_items: owner"        on public.meal_items        for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "lab_reports: owner"       on public.lab_reports       for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "lab_results: owner"       on public.lab_results       for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "medications: owner"       on public.medications       for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "health_conditions: owner" on public.health_conditions for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "planned_sessions: owner"  on public.planned_sessions  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- תוכנית תזונה: המשתמש רואה ומציע, אבל **אישור** (active) עובר רק דרך השרת,
-- שבודק כללי בטיחות לפני ההפעלה. לכן אין למשתמש update ישיר.
create policy "nutrition_plans: owner reads"     on public.nutrition_plans for select to authenticated using (user_id = (select auth.uid()));
create policy "nutrition_plans: owner proposes"  on public.nutrition_plans for insert to authenticated
  with check (user_id = (select auth.uid()) and status = 'proposed' and created_by = 'user');
