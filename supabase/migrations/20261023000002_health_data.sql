-- =====================================================================
-- 0002 · health data: raw ingest + המודל הקנוני
-- זרימה: payload גולמי → ingest_events → adapter (TS) → טבלאות קנוניות
-- כתיבה לטבלאות האלה רק דרך service role (Edge Functions / RPC).
-- המשתמש קורא רק את שלו.
-- =====================================================================

-- ---------------------------------------------------------------------
-- ingest_events: כל payload שהגיע, כמו שהוא. לדיבוג ולהרצה מחדש אם המתאם תוקן.
-- נמחק אחרי 30 יום (cron בשלב 7).
-- ---------------------------------------------------------------------
create table public.ingest_events (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  source_id    uuid not null references public.data_sources (id) on delete cascade,
  received_at  timestamptz not null default now(),
  payload      jsonb not null,
  status       text not null default 'pending' check (status in ('pending', 'processed', 'failed')),
  error        text,
  stats        jsonb,
  processed_at timestamptz
);

create index ingest_events_user_received_idx on public.ingest_events (user_id, received_at desc);
create index ingest_events_failed_idx on public.ingest_events (status) where status <> 'processed';

-- ---------------------------------------------------------------------
-- health_samples: סדרות זמן כלליות (דופק, צעדים, HRV, משקל, ...)
-- metric הוא text ולא enum: מדד חדש מהמקור נשמר מיד, בלי מיגרציה.
-- ---------------------------------------------------------------------
create table public.health_samples (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  source_id  uuid not null references public.data_sources (id) on delete cascade,
  metric     text not null,
  start_at   timestamptz not null,
  end_at     timestamptz not null,            -- = start_at כשהמקור שולח נקודה ולא טווח
  value      numeric not null,                -- ממוצע כשהמקור שולח min/avg/max
  value_min  numeric,
  value_max  numeric,
  unit       text not null,                   -- תמיד יחידה קנונית (ראו units.ts)
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- מונע כפילויות כשהמקור שולח שוב חלון חופף (וזה קורה כל סנכרון)
  constraint health_samples_dedupe unique (user_id, source_id, metric, start_at, end_at),
  constraint health_samples_range check (end_at >= start_at)
);

-- השאילתה הנפוצה: "מדד X של משתמש Y בטווח תאריכים"
create index health_samples_user_metric_time_idx
  on public.health_samples (user_id, metric, start_at desc);

-- ---------------------------------------------------------------------
-- workouts: שלוש שכבות. עמודות לשדות שהסוכן שואל עליהם הרבה,
-- metrics jsonb לכל שדה סקלרי אחר, ו-raw לאובייקט המקורי (בלי הסדרות).
-- ---------------------------------------------------------------------
create table public.workouts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles (id) on delete cascade,
  source_id          uuid not null references public.data_sources (id) on delete cascade,
  external_id        text not null,           -- ה-UUID של HealthKit
  activity_name      text not null,           -- "Outdoor Run" כפי שהגיע
  activity_type      text not null,           -- 'outdoor_run' מנורמל
  start_at           timestamptz not null,
  end_at             timestamptz not null,
  duration_s         numeric,
  active_kcal        numeric,
  total_kcal         numeric,
  distance_m         numeric,
  elevation_up_m     numeric,
  avg_hr             numeric,
  max_hr             numeric,
  min_hr             numeric,
  is_indoor          boolean,
  location           text,
  metrics            jsonb not null default '{}'::jsonb,
  raw                jsonb not null default '{}'::jsonb,
  perceived_effort   smallint check (perceived_effort between 1 and 10),
  planned_session_id uuid,                    -- FK יתווסף בשלב 6 (planned_sessions)
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint workouts_dedupe unique (user_id, source_id, external_id)
);

create index workouts_user_start_idx on public.workouts (user_id, start_at desc);

create trigger workouts_updated_at
  before update on public.workouts
  for each row execute function public.set_updated_at();

-- סדרות זמן בתוך אימון: דופק, התאוששות דופק, צעדים, מרחק, אנרגיה...
-- user_id משוכפל כאן בכוונה: RLS פשוט ומהיר בלי join לכל שורה.
create table public.workout_samples (
  workout_id uuid not null references public.workouts (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  metric     text not null,
  at         timestamptz not null,
  value      numeric not null,
  value_min  numeric,
  value_max  numeric,
  unit       text not null,
  primary key (workout_id, metric, at)
);

create table public.workout_route_points (
  workout_id   uuid not null references public.workouts (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  at           timestamptz not null,
  lat          double precision not null,
  lon          double precision not null,
  altitude_m   double precision,
  speed_mps    double precision,
  course_deg   double precision,
  h_accuracy_m double precision,
  v_accuracy_m double precision,
  primary key (workout_id, at)
);

-- ---------------------------------------------------------------------
-- sleep_sessions: לילה אחד לכל מקור. sleep_date = היום שבו התעוררת.
-- ---------------------------------------------------------------------
create table public.sleep_sessions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles (id) on delete cascade,
  source_id        uuid not null references public.data_sources (id) on delete cascade,
  sleep_date       date not null,
  in_bed_start     timestamptz,
  in_bed_end       timestamptz,
  asleep_start     timestamptz,
  asleep_end       timestamptz,
  total_asleep_min numeric,
  in_bed_min       numeric,
  rem_min          numeric,
  core_min         numeric,
  deep_min         numeric,
  awake_min        numeric,
  stages           jsonb,                     -- רצף השלבים המלא, אם המקור שולח
  meta             jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint sleep_sessions_dedupe unique (user_id, source_id, sleep_date)
);

create index sleep_sessions_user_date_idx on public.sleep_sessions (user_id, sleep_date desc);

create trigger sleep_sessions_updated_at
  before update on public.sleep_sessions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- RLS: קריאה של המידע שלך בלבד. אין policies של כתיבה = רק service role כותב.
-- (select auth.uid()) בסוגריים: Postgres מחשב פעם אחת לשאילתה ולא לכל שורה.
-- ---------------------------------------------------------------------
alter table public.ingest_events        enable row level security;
alter table public.health_samples       enable row level security;
alter table public.workouts             enable row level security;
alter table public.workout_samples      enable row level security;
alter table public.workout_route_points enable row level security;
alter table public.sleep_sessions       enable row level security;

create policy "ingest_events: read own" on public.ingest_events
  for select to authenticated using (user_id = (select auth.uid()));
create policy "health_samples: read own" on public.health_samples
  for select to authenticated using (user_id = (select auth.uid()));
create policy "workouts: read own" on public.workouts
  for select to authenticated using (user_id = (select auth.uid()));
create policy "workout_samples: read own" on public.workout_samples
  for select to authenticated using (user_id = (select auth.uid()));
create policy "workout_route_points: read own" on public.workout_route_points
  for select to authenticated using (user_id = (select auth.uid()));
create policy "sleep_sessions: read own" on public.sleep_sessions
  for select to authenticated using (user_id = (select auth.uid()));

-- את RPE והערות לאימון המשתמש כן יכול לעדכן בעצמו (בעתיד, מהדשבורד)
create policy "workouts: update own notes" on public.workouts
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ה-policy למעלה קובע *אילו שורות*. ההרשאות כאן קובעות *אילו עמודות*:
-- המשתמש יכול לשנות רק RPE והערות, לא את הנתונים שהגיעו מהשעון.
revoke update on public.workouts from anon, authenticated;
grant update (perceived_effort, notes) on public.workouts to authenticated;
