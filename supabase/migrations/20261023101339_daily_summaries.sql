-- =====================================================================
-- 0003 · daily_summaries: שורה אחת ליום. זה מה שהסוכן קורא רוב הזמן.
-- 🧠 pre-aggregation: לא שולחים למודל אלפי דגימות, אלא מספרים מסוכמים מראש.
-- "יום" = יום לפי ה-timezone של המשתמש, לא UTC.
-- =====================================================================

create table public.daily_summaries (
  user_id          uuid not null references public.profiles (id) on delete cascade,
  day              date not null,
  -- פעילות
  steps            numeric,
  active_kcal      numeric,
  exercise_min     numeric,
  distance_m       numeric,
  workouts_count   integer not null default 0,
  workout_min      numeric,
  -- לב
  resting_hr       numeric,
  hr_min           numeric,
  hr_max           numeric,
  walking_hr       numeric,
  hrv_avg          numeric,
  -- שינה (הלילה שהסתיים בבוקר של day)
  sleep_min        numeric,
  sleep_deep_min   numeric,
  sleep_rem_min    numeric,
  sleep_efficiency numeric,                  -- asleep / in bed
  -- גוף
  weight_kg        numeric,
  -- תזונה (יתמלא בשלב 4, מהארוחות)
  kcal_in          numeric,
  protein_g        numeric,
  carbs_g          numeric,
  fat_g            numeric,
  -- נגזרות
  baselines        jsonb not null default '{}'::jsonb,  -- ממוצע/סטיית תקן ל-28 הימים הקודמים
  recovery_score   numeric,                             -- 0–100, null אם אין baseline מספיק
  computed_at      timestamptz not null default now(),
  primary key (user_id, day)
);

alter table public.daily_summaries enable row level security;
create policy "daily_summaries: read own" on public.daily_summaries
  for select to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------
-- recompute_daily_summary: מחשב (או מחשב מחדש) יום אחד. אידמפוטנטי.
-- ---------------------------------------------------------------------
create or replace function public.recompute_daily_summary(p_user_id uuid, p_day date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz      text;
  v_from    timestamptz;
  v_to      timestamptz;
  v_base    jsonb;
  v_score   numeric;
  r         record;
begin
  select timezone into v_tz from public.profiles where id = p_user_id;
  if v_tz is null then
    raise exception 'profile % not found', p_user_id;
  end if;

  -- גבולות היום בשעון המקומי, מתורגמים ל-timestamptz
  v_from := (p_day::timestamp)     at time zone v_tz;
  v_to   := ((p_day + 1)::timestamp) at time zone v_tz;

  with s as (
    select metric,
           sum(value)                         as sum_v,
           avg(value)                         as avg_v,
           min(coalesce(value_min, value))    as min_v,
           max(coalesce(value_max, value))    as max_v
      from public.health_samples
     where user_id = p_user_id
       and start_at >= v_from and start_at < v_to
       and metric in ('steps', 'active_energy', 'exercise_minutes', 'walking_running_distance',
                      'resting_heart_rate', 'heart_rate', 'walking_heart_rate', 'hrv_sdnn')
     group by metric
  ),
  w as (
    select count(*)::int as n, sum(duration_s) / 60.0 as minutes
      from public.workouts
     where user_id = p_user_id and start_at >= v_from and start_at < v_to
  ),
  -- כמה מקורות שינה לאותו לילה? לוקחים את הארוך (בדרך כלל השעון)
  sl as (
    select total_asleep_min, deep_min, rem_min,
           case when in_bed_min > 0 then round(total_asleep_min / in_bed_min, 3) end as eff
      from public.sleep_sessions
     where user_id = p_user_id and sleep_date = p_day
     order by total_asleep_min desc nulls last
     limit 1
  ),
  wt as (
    select value
      from public.health_samples
     where user_id = p_user_id and metric = 'body_mass'
       and start_at >= v_from and start_at < v_to
     order by start_at desc
     limit 1
  )
  select
    (select sum_v from s where metric = 'steps')                    as steps,
    (select sum_v from s where metric = 'active_energy')            as active_kcal,
    (select sum_v from s where metric = 'exercise_minutes')         as exercise_min,
    (select sum_v from s where metric = 'walking_running_distance') as distance_m,
    (select n from w)                                               as workouts_count,
    (select minutes from w)                                         as workout_min,
    (select avg_v from s where metric = 'resting_heart_rate')       as resting_hr,
    (select min_v from s where metric = 'heart_rate')               as hr_min,
    (select max_v from s where metric = 'heart_rate')               as hr_max,
    (select avg_v from s where metric = 'walking_heart_rate')       as walking_hr,
    (select avg_v from s where metric = 'hrv_sdnn')                 as hrv_avg,
    (select total_asleep_min from sl)                               as sleep_min,
    (select deep_min from sl)                                       as sleep_deep_min,
    (select rem_min from sl)                                        as sleep_rem_min,
    (select eff from sl)                                            as sleep_efficiency,
    (select value from wt)                                          as weight_kg
  into r;

  -- baseline: 28 הימים *הקודמים* (בלי היום עצמו, אחרת היום "מושך" את הממוצע אליו)
  select jsonb_build_object(
           'days',          count(*),
           'resting_hr',    jsonb_build_object('mean', round(avg(resting_hr), 1), 'sd', round(stddev_samp(resting_hr), 2), 'n', count(resting_hr)),
           'hrv_avg',       jsonb_build_object('mean', round(avg(hrv_avg), 1),    'sd', round(stddev_samp(hrv_avg), 2),    'n', count(hrv_avg)),
           'sleep_min',     jsonb_build_object('mean', round(avg(sleep_min), 0),  'sd', round(stddev_samp(sleep_min), 1),  'n', count(sleep_min)),
           'steps',         jsonb_build_object('mean', round(avg(steps), 0),      'sd', round(stddev_samp(steps), 0),      'n', count(steps))
         )
    into v_base
    from public.daily_summaries
   where user_id = p_user_id
     and day >= p_day - 28 and day < p_day;

  -- recovery score v0: הסטייה של HRV ודופק במנוחה מה-baseline האישי, ועוד שינה.
  -- HRV גבוה מהרגיל = טוב, דופק במנוחה גבוה מהרגיל = פחות טוב.
  -- זו היוריסטיקה פשוטה ושקופה, לא מדד רפואי. דורשת לפחות 7 ימים של baseline.
  v_score := public.recovery_score_v0(
               r.hrv_avg,    (v_base -> 'hrv_avg'    ->> 'mean')::numeric, (v_base -> 'hrv_avg'    ->> 'sd')::numeric, (v_base -> 'hrv_avg'    ->> 'n')::int,
               r.resting_hr, (v_base -> 'resting_hr' ->> 'mean')::numeric, (v_base -> 'resting_hr' ->> 'sd')::numeric, (v_base -> 'resting_hr' ->> 'n')::int,
               r.sleep_min,  (v_base -> 'sleep_min'  ->> 'mean')::numeric);

  insert into public.daily_summaries as d (
    user_id, day, steps, active_kcal, exercise_min, distance_m, workouts_count, workout_min,
    resting_hr, hr_min, hr_max, walking_hr, hrv_avg,
    sleep_min, sleep_deep_min, sleep_rem_min, sleep_efficiency, weight_kg,
    baselines, recovery_score, computed_at)
  values (
    p_user_id, p_day, r.steps, r.active_kcal, r.exercise_min, r.distance_m, coalesce(r.workouts_count, 0), r.workout_min,
    r.resting_hr, r.hr_min, r.hr_max, r.walking_hr, r.hrv_avg,
    r.sleep_min, r.sleep_deep_min, r.sleep_rem_min, r.sleep_efficiency, r.weight_kg,
    coalesce(v_base, '{}'::jsonb), v_score, now())
  on conflict (user_id, day) do update set
    steps = excluded.steps, active_kcal = excluded.active_kcal, exercise_min = excluded.exercise_min,
    distance_m = excluded.distance_m, workouts_count = excluded.workouts_count, workout_min = excluded.workout_min,
    resting_hr = excluded.resting_hr, hr_min = excluded.hr_min, hr_max = excluded.hr_max,
    walking_hr = excluded.walking_hr, hrv_avg = excluded.hrv_avg,
    sleep_min = excluded.sleep_min, sleep_deep_min = excluded.sleep_deep_min, sleep_rem_min = excluded.sleep_rem_min,
    sleep_efficiency = excluded.sleep_efficiency, weight_kg = excluded.weight_kg,
    baselines = excluded.baselines, recovery_score = excluded.recovery_score, computed_at = now();
    -- kcal_in/protein_g/... לא נדרסים כאן: הם מתעדכנים מהארוחות
end;
$$;

-- פונקציה טהורה (immutable) ונפרדת, כדי שיהיה קל לבדוק אותה ולהחליף ל-v1 בעתיד
create or replace function public.recovery_score_v0(
  p_hrv numeric, p_hrv_mean numeric, p_hrv_sd numeric, p_hrv_n int,
  p_rhr numeric, p_rhr_mean numeric, p_rhr_sd numeric, p_rhr_n int,
  p_sleep numeric, p_sleep_mean numeric
)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when p_hrv is null or p_rhr is null
      or coalesce(p_hrv_n, 0) < 7 or coalesce(p_rhr_n, 0) < 7
      or coalesce(p_hrv_sd, 0) = 0 or coalesce(p_rhr_sd, 0) = 0
    then null
    -- רצפה לסטיית התקן: כשהנתונים יציבים מאוד, sd זעיר היה הופך כל רעש קטן ל"קיצון".
    -- HRV: לפחות 8% מהממוצע. דופק במנוחה: לפחות 1.5 פעימות.
    else round(greatest(0, least(100,
           50
           + 12 * greatest(-2.5, least(2.5, (p_hrv - p_hrv_mean) / greatest(p_hrv_sd, 0.08 * p_hrv_mean)))
           - 12 * greatest(-2.5, least(2.5, (p_rhr - p_rhr_mean) / greatest(p_rhr_sd, 1.5)))
           + case when p_sleep is null or p_sleep_mean is null then 0
                  else 8 * greatest(-2, least(2, (p_sleep - p_sleep_mean) / 60.0)) end
         )))
  end;
$$;

revoke execute on function public.recompute_daily_summary(uuid, date) from public, anon, authenticated;
grant  execute on function public.recompute_daily_summary(uuid, date) to service_role;
