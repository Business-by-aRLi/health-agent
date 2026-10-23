-- =====================================================================
-- 0004 · ingest_canonical_batch: כל הכתיבה של קליטה, בטרנזקציה אחת.
--
-- 🧠 למה RPC אחד ולא הרבה inserts מה-Edge Function?
--   1. אטומיות: אם משהו נכשל באמצע, שום דבר לא נכתב. אין "חצי אימון".
--   2. round-trip אחד לדאטהבייס במקום עשרות.
--   3. הלוגיקה של dedupe ו-upsert צמודה לסכימה ונבדקת ב-SQL.
--
-- הקלט הוא CanonicalBatch (ראו supabase/functions/_shared/adapters/types.ts).
-- service role בלבד: משתמש רגיל לא יכול להזריק נתונים, גם לא לעצמו.
-- =====================================================================

create or replace function public.ingest_canonical_batch(p_source_id uuid, p_batch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user        uuid;
  v_tz          text;
  v_samples     int := 0;
  v_workouts    int := 0;
  v_wsamples    int := 0;
  v_route       int := 0;
  v_sleep       int := 0;
  v_days        date[];
  v_from_day    date;
  v_to_day      date;
  v_day         date;
  v_workout     jsonb;
  v_workout_id  uuid;
  v_n           int;
begin
  select s.user_id, p.timezone into v_user, v_tz
    from public.data_sources s
    join public.profiles p on p.id = s.user_id
   where s.id = p_source_id and s.status = 'active';
  if v_user is null then
    raise exception 'source % not found or inactive', p_source_id using errcode = 'P0002';
  end if;

  -- -------------------------------------------------------------- samples
  -- distinct on: אם אותו מפתח מופיע פעמיים באותו batch, upsert היה נכשל
  -- ("ON CONFLICT DO UPDATE command cannot affect row a second time")
  insert into public.health_samples as h
    (user_id, source_id, metric, start_at, end_at, value, value_min, value_max, unit, meta)
  select distinct on (x.metric, x.start_at, coalesce(x.end_at, x.start_at))
         v_user, p_source_id, x.metric, x.start_at, coalesce(x.end_at, x.start_at),
         x.value, x.value_min, x.value_max, x.unit, coalesce(x.meta, '{}'::jsonb)
    from jsonb_to_recordset(coalesce(p_batch -> 'samples', '[]'::jsonb)) as x(
           metric text, start_at timestamptz, end_at timestamptz,
           value numeric, value_min numeric, value_max numeric, unit text, meta jsonb)
   where x.metric is not null and x.start_at is not null and x.value is not null
  on conflict on constraint health_samples_dedupe do update set
    value = excluded.value, value_min = excluded.value_min, value_max = excluded.value_max,
    unit = excluded.unit, meta = excluded.meta;
  get diagnostics v_samples = row_count;

  -- ------------------------------------------------------------- workouts
  for v_workout in
    select * from jsonb_array_elements(coalesce(p_batch -> 'workouts', '[]'::jsonb))
  loop
    insert into public.workouts as w (
      user_id, source_id, external_id, activity_name, activity_type, start_at, end_at,
      duration_s, active_kcal, total_kcal, distance_m, elevation_up_m, avg_hr, max_hr, min_hr,
      is_indoor, location, metrics, raw)
    values (
      v_user, p_source_id,
      v_workout ->> 'external_id',
      v_workout ->> 'activity_name',
      v_workout ->> 'activity_type',
      (v_workout ->> 'start_at')::timestamptz,
      (v_workout ->> 'end_at')::timestamptz,
      (v_workout ->> 'duration_s')::numeric,
      (v_workout ->> 'active_kcal')::numeric,
      (v_workout ->> 'total_kcal')::numeric,
      (v_workout ->> 'distance_m')::numeric,
      (v_workout ->> 'elevation_up_m')::numeric,
      (v_workout ->> 'avg_hr')::numeric,
      (v_workout ->> 'max_hr')::numeric,
      (v_workout ->> 'min_hr')::numeric,
      (v_workout ->> 'is_indoor')::boolean,
      v_workout ->> 'location',
      coalesce(v_workout -> 'metrics', '{}'::jsonb),
      coalesce(v_workout -> 'raw', '{}'::jsonb))
    on conflict on constraint workouts_dedupe do update set
      activity_name = excluded.activity_name, activity_type = excluded.activity_type,
      start_at = excluded.start_at, end_at = excluded.end_at, duration_s = excluded.duration_s,
      active_kcal = excluded.active_kcal, total_kcal = excluded.total_kcal,
      distance_m = excluded.distance_m, elevation_up_m = excluded.elevation_up_m,
      avg_hr = excluded.avg_hr, max_hr = excluded.max_hr, min_hr = excluded.min_hr,
      is_indoor = excluded.is_indoor, location = excluded.location,
      metrics = excluded.metrics, raw = excluded.raw
      -- perceived_effort / notes / planned_session_id לא נדרסים: הם שלך, לא של השעון
    returning id into v_workout_id;
    v_workouts := v_workouts + 1;

    -- הסדרות מוחלפות במלואן: גרסת האימון האחרונה מהמקור היא האמת
    delete from public.workout_samples      where workout_id = v_workout_id;
    delete from public.workout_route_points where workout_id = v_workout_id;

    insert into public.workout_samples (workout_id, user_id, metric, at, value, value_min, value_max, unit)
    select distinct on (x.metric, x.at)
           v_workout_id, v_user, x.metric, x.at, x.value, x.value_min, x.value_max, x.unit
      from jsonb_to_recordset(coalesce(v_workout -> 'samples', '[]'::jsonb)) as x(
             metric text, at timestamptz, value numeric, value_min numeric, value_max numeric, unit text)
     where x.metric is not null and x.at is not null and x.value is not null;
    get diagnostics v_n = row_count;
    v_wsamples := v_wsamples + v_n;

    insert into public.workout_route_points (
      workout_id, user_id, at, lat, lon, altitude_m, speed_mps, course_deg, h_accuracy_m, v_accuracy_m)
    select distinct on (x.at)
           v_workout_id, v_user, x.at, x.lat, x.lon, x.altitude_m, x.speed_mps, x.course_deg,
           x.h_accuracy_m, x.v_accuracy_m
      from jsonb_to_recordset(coalesce(v_workout -> 'route', '[]'::jsonb)) as x(
             at timestamptz, lat double precision, lon double precision, altitude_m double precision,
             speed_mps double precision, course_deg double precision,
             h_accuracy_m double precision, v_accuracy_m double precision)
     where x.at is not null and x.lat is not null and x.lon is not null;
    get diagnostics v_n = row_count;
    v_route := v_route + v_n;
  end loop;

  -- ---------------------------------------------------------------- sleep
  insert into public.sleep_sessions as s (
    user_id, source_id, sleep_date, in_bed_start, in_bed_end, asleep_start, asleep_end,
    total_asleep_min, in_bed_min, rem_min, core_min, deep_min, awake_min, stages, meta)
  select distinct on (x.sleep_date)
         v_user, p_source_id, x.sleep_date, x.in_bed_start, x.in_bed_end, x.asleep_start, x.asleep_end,
         x.total_asleep_min, x.in_bed_min, x.rem_min, x.core_min, x.deep_min, x.awake_min,
         x.stages, coalesce(x.meta, '{}'::jsonb)
    from jsonb_to_recordset(coalesce(p_batch -> 'sleep', '[]'::jsonb)) as x(
           sleep_date date, in_bed_start timestamptz, in_bed_end timestamptz,
           asleep_start timestamptz, asleep_end timestamptz,
           total_asleep_min numeric, in_bed_min numeric, rem_min numeric, core_min numeric,
           deep_min numeric, awake_min numeric, stages jsonb, meta jsonb)
   where x.sleep_date is not null
  on conflict on constraint sleep_sessions_dedupe do update set
    in_bed_start = excluded.in_bed_start, in_bed_end = excluded.in_bed_end,
    asleep_start = excluded.asleep_start, asleep_end = excluded.asleep_end,
    total_asleep_min = excluded.total_asleep_min, in_bed_min = excluded.in_bed_min,
    rem_min = excluded.rem_min, core_min = excluded.core_min, deep_min = excluded.deep_min,
    awake_min = excluded.awake_min, stages = excluded.stages, meta = excluded.meta;
  get diagnostics v_sleep = row_count;

  -- -------------------------------------------------- days affected (local)
  select array_agg(distinct d order by d) into v_days
    from (
      select ((x ->> 'start_at')::timestamptz at time zone v_tz)::date as d
        from jsonb_array_elements(coalesce(p_batch -> 'samples', '[]'::jsonb)) x
      union
      select ((x ->> 'start_at')::timestamptz at time zone v_tz)::date
        from jsonb_array_elements(coalesce(p_batch -> 'workouts', '[]'::jsonb)) x
      union
      select (x ->> 'sleep_date')::date
        from jsonb_array_elements(coalesce(p_batch -> 'sleep', '[]'::jsonb)) x
    ) t
   where d is not null;

  -- מחשבים מהיום המושפע הראשון ועד היום האחרון שיש לו סיכום (או המושפע האחרון).
  -- ככה גם ה-baseline של הימים שאחרי backfill מתעדכן. מוגבל ל-400 יום.
  if v_days is not null then
    v_from_day := v_days[1];
    select greatest(v_days[array_upper(v_days, 1)], coalesce(max(day), v_days[1]))
      into v_to_day
      from public.daily_summaries where user_id = v_user;
    v_to_day := least(v_to_day, v_from_day + 400);

    v_day := v_from_day;
    while v_day <= v_to_day loop
      perform public.recompute_daily_summary(v_user, v_day);
      v_day := v_day + 1;
    end loop;
  end if;

  update public.data_sources set last_synced_at = now() where id = p_source_id;

  return jsonb_build_object(
    'samples',         v_samples,
    'workouts',        v_workouts,
    'workout_samples', v_wsamples,
    'route_points',    v_route,
    'sleep_sessions',  v_sleep,
    'days_affected',   coalesce(to_jsonb(v_days), '[]'::jsonb),
    'recomputed',      case when v_days is null then null
                            else jsonb_build_object('from', v_from_day, 'to', v_to_day) end
  );
end;
$$;

revoke execute on function public.ingest_canonical_batch(uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.ingest_canonical_batch(uuid, jsonb) to service_role;

-- recovery_score_v0 טהורה ולא חושפת מידע, אבל אין סיבה שתהיה ב-API הציבורי
revoke execute on function public.recovery_score_v0(numeric, numeric, numeric, int, numeric, numeric, numeric, int, numeric, numeric) from public, anon, authenticated;
