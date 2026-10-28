-- בדיקות אינטגרציה: מיגרציות + ingest_canonical_batch + daily_summaries + RLS.
-- מקבל את פלט המתאם האמיתי דרך משתני psql: batch, batch2.
\set QUIET on

create temp table t_batch as select :'batch'::jsonb as b, :'batch2'::jsonb as b2;
create temp table t_ctx (k text primary key, v text);

-- ------------------------------------------------------------ setup
do $$
declare v_uid uuid; v_other uuid; r record;
begin
  insert into auth.users (email) values ('miri@example.com') returning id into v_uid;
  insert into auth.users (email) values ('other@example.com') returning id into v_other;
  assert (select count(*) from public.profiles) = 2, 'trigger should create profiles';
  assert (select timezone from public.profiles where id = v_uid) = 'Asia/Jerusalem';
  assert (select focus_areas from public.profiles where id = v_uid) = array['sleep','steps','heart_rate','workouts'];

  select * into r from public.create_ingest_source(v_uid, 'health_auto_export', 'האייפון שלי');
  assert r.ingest_token like 'hk_%' and length(r.ingest_token) = 67, 'token format';
  assert (select ingest_token_hash from public.data_source_secrets where source_id = r.source_id)
         = encode(extensions.digest(r.ingest_token, 'sha256'), 'hex'), 'hash matches (same algo as Edge Function)';

  insert into t_ctx values ('uid', v_uid), ('other', v_other), ('source', r.source_id);
end $$;

-- ------------------------------------------------------- first ingest
do $$
declare v_src uuid := (select v::uuid from t_ctx where k = 'source');
        v_uid uuid := (select v::uuid from t_ctx where k = 'uid');
        s jsonb; d record;
begin
  s := public.ingest_canonical_batch(v_src, (select b from t_batch));
  raise notice 'stats: %', s;
  assert (s ->> 'samples')::int = 13,        format('samples: %s', s ->> 'samples');  -- כפילות הצעדים נבלעה
  assert (s ->> 'workouts')::int = 2,        'workouts';
  assert (s ->> 'workout_samples')::int = 8, format('workout_samples: %s', s ->> 'workout_samples');
  assert (s ->> 'route_points')::int = 2,    'route';
  assert (s ->> 'sleep_sessions')::int = 1,  'sleep';
  assert (s ->> 'intervals')::int = 5,        format('intervals: %s', s ->> 'intervals');
  assert (select pace_s_per_km from public.workout_intervals where kind = 'split_1km' and idx = 2) = 390, 'split pace';
  assert s -> 'days_affected' = '["2026-10-22"]'::jsonb, format('days: %s', s -> 'days_affected');

  select * into d from public.daily_summaries where user_id = v_uid and day = '2026-10-22';
  assert d.steps = 7160,           format('steps %s', d.steps);
  assert round(d.active_kcal) = 300, format('active_kcal %s', d.active_kcal);
  assert d.resting_hr = 56,        'resting_hr';
  assert d.hrv_avg = 50.5,         format('hrv %s', d.hrv_avg);
  assert d.hr_min = 58 and d.hr_max = 141, 'hr min/max from Min/Max';
  assert d.sleep_min = 423,        format('sleep %s', d.sleep_min);
  assert d.sleep_efficiency = round(423 / 456.0, 3), 'efficiency';
  assert d.weight_kg = 64.3,       'weight';
  assert d.workouts_count = 2 and d.workout_min = 94.5, format('workouts %s / %s', d.workouts_count, d.workout_min);
  assert d.recovery_score is null, 'no baseline yet → null, not a made-up number';

  assert (select last_synced_at from public.data_sources where id = v_src) is not null, 'last_synced_at';
end $$;

-- ------------------------------------------- idempotency + user fields kept
do $$
declare v_src uuid := (select v::uuid from t_ctx where k = 'source');
        n_samples int; n_ws int; n_route int;
begin
  update public.workouts set notes = 'ברך שמאל הציקה', perceived_effort = 7
   where external_id = '8F1A2B3C-0000-4D5E-9F10-ABCDEF123456';
  select count(*) into n_samples from public.health_samples;
  select count(*) into n_ws from public.workout_samples;
  select count(*) into n_route from public.workout_route_points;

  perform public.ingest_canonical_batch(v_src, (select b from t_batch));

  assert (select count(*) from public.health_samples) = n_samples, 'no duplicate samples on re-send';
  assert (select count(*) from public.workouts) = 2, 'no duplicate workouts';
  assert (select count(*) from public.workout_samples) = n_ws, 'series upserted, not appended';
  assert (select count(*) from public.workout_route_points) = n_route, 'route upserted, not appended';
  assert (select count(*) from public.workout_intervals) = 5, 'intervals upserted, not appended';
  assert (select notes from public.workouts where external_id = '8F1A2B3C-0000-4D5E-9F10-ABCDEF123456') = 'ברך שמאל הציקה',
         'user notes survive re-ingest';
  assert (select perceived_effort from public.workouts where external_id = '8F1A2B3C-0000-4D5E-9F10-ABCDEF123456') = 7,
         'RPE survives re-ingest';
end $$;

-- ----------------------------------------- sleep segments format
-- (הלילה בפורמט המקטעים מתחיל אחרי זה שכבר נקלט ונגמר לפניו, וזה בדיוק "חיתוך" שלא דורס,
--  ולכן מנקים קודם. הדריסה עצמה נבדקת למטה)
do $$
declare v_src uuid := (select v::uuid from t_ctx where k = 'source');
        v_uid uuid := (select v::uuid from t_ctx where k = 'uid');
begin
  perform public.ingest_canonical_batch(v_src, (select b2 from t_batch));
  assert (select total_asleep_min from public.sleep_sessions) = 423, 'contained later-start version does not overwrite';
  delete from public.sleep_sessions;
  perform public.ingest_canonical_batch(v_src, (select b2 from t_batch));
  assert (select count(*) from public.sleep_sessions) = 1, 'one night';
  assert (select total_asleep_min from public.sleep_sessions) = 405, 'segments total';
  assert jsonb_array_length((select stages from public.sleep_sessions)) = 5, 'stages kept';
  assert (select sleep_min from public.daily_summaries where user_id = v_uid and day = '2026-10-22') = 405,
         'summary recomputed';
end $$;

-- ------------------------- rolling-window truncation does not shrink the night
do $$
declare v_src uuid := (select v::uuid from t_ctx where k = 'source');
        v_before numeric := (select total_asleep_min from public.sleep_sessions);
        v_row public.sleep_sessions := (select s from public.sleep_sessions s);
begin
  -- אותו לילה, מתחיל שעתיים אחרי ונגמר באותה שעה, 60 דקות: חיתוך של HAE, נשאר הלילה המלא
  perform public.ingest_canonical_batch(v_src, jsonb_build_object('sleep', jsonb_build_array(jsonb_build_object(
    'sleep_date', v_row.sleep_date, 'asleep_start', v_row.asleep_start + interval '2 hours', 'asleep_end', v_row.asleep_end,
    'in_bed_start', v_row.asleep_start + interval '2 hours', 'in_bed_end', v_row.asleep_end, 'total_asleep_min', 60))));
  assert (select total_asleep_min from public.sleep_sessions) = v_before, 'truncated window ignored';
  -- נתון שהגיע באיחור ומאריך את הלילה (סוף מאוחר יותר) כן מעדכן
  perform public.ingest_canonical_batch(v_src, jsonb_build_object('sleep', jsonb_build_array(jsonb_build_object(
    'sleep_date', v_row.sleep_date, 'asleep_start', v_row.asleep_start, 'asleep_end', v_row.asleep_end + interval '30 minutes',
    'in_bed_start', v_row.asleep_start, 'in_bed_end', v_row.asleep_end + interval '30 minutes', 'total_asleep_min', v_before + 30))));
  assert (select total_asleep_min from public.sleep_sessions) = v_before + 30, 'later data extends';
  -- מחזירים למצב הקודם בשביל הבדיקות הבאות
  delete from public.sleep_sessions;
  perform public.ingest_canonical_batch(v_src, (select b2 from t_batch));
end $$;

-- --------------------------------------------- timezone day boundary
do $$
declare v_src uuid := (select v::uuid from t_ctx where k = 'source');
        v_uid uuid := (select v::uuid from t_ctx where k = 'uid');
begin
  perform public.ingest_canonical_batch(v_src, jsonb_build_object('samples', jsonb_build_array(
    jsonb_build_object('metric','steps','start_at','2026-10-22T23:30:00+03:00','value',100,'unit','count'),
    jsonb_build_object('metric','steps','start_at','2026-10-23T00:30:00+03:00','value',40,'unit','count'))));
  -- 00:30 שעון ישראל = 21:30 UTC של ה-22, אבל שייך ל-23 אצלך
  assert (select steps from public.daily_summaries where user_id = v_uid and day = '2026-10-22') = 7260, 'local day 22';
  assert (select steps from public.daily_summaries where user_id = v_uid and day = '2026-10-23') = 40,   'local day 23';
end $$;

-- ------------------------------------------------ baseline + recovery
do $$
declare v_src uuid := (select v::uuid from t_ctx where k = 'source');
        v_uid uuid := (select v::uuid from t_ctx where k = 'uid');
        v_samples jsonb; d record;
begin
  -- 10 ימים קודמים: דופק במנוחה ~58, HRV ~45
  select jsonb_agg(x) into v_samples from (
    select jsonb_build_object('metric','resting_heart_rate','start_at', (day::timestamp + time '08:00') at time zone 'Asia/Jerusalem',
                              'value', 58 + (i % 3) - 1, 'unit','bpm') as x
      from generate_series(1, 10) i, lateral (select date '2026-10-22' - i as day) dd
    union all
    select jsonb_build_object('metric','hrv_sdnn','start_at', (day::timestamp + time '04:00') at time zone 'Asia/Jerusalem',
                              'value', 45 + (i % 5) - 2, 'unit','ms')
      from generate_series(1, 10) i, lateral (select date '2026-10-22' - i as day) dd
  ) t;
  perform public.ingest_canonical_batch(v_src, jsonb_build_object('samples', v_samples));

  select * into d from public.daily_summaries where user_id = v_uid and day = '2026-10-22';
  assert (d.baselines -> 'hrv_avg' ->> 'n')::int = 10, format('baseline n %s', d.baselines);
  assert (d.baselines -> 'resting_hr' ->> 'mean')::numeric = 58, 'baseline mean';
  -- HRV 50.5 מעל 45, דופק 56 מתחת ל-58 → התאוששות טובה
  assert d.recovery_score between 70 and 99, format('recovery %s', d.recovery_score);
  raise notice 'recovery_score on 2026-10-22 = % (baselines %)', d.recovery_score, d.baselines;
end $$;

do $$
begin
  assert public.recovery_score_v0(45, 45, 3, 10, 58, 58, 1, 10, 420, 420) = 50, 'at baseline = 50';
  assert public.recovery_score_v0(35, 45, 3, 10, 64, 58, 1, 10, 300, 420) < 25, 'bad night = low';
  assert public.recovery_score_v0(45, 45, 3, 5, 58, 58, 1, 5, 420, 420) is null, 'n<7 → null';
  assert public.recovery_score_v0(999, 45, 3, 10, 0, 58, 1, 10, 900, 420) <= 100, 'clamped';
end $$;

-- ---------------------------------------------------------------- RLS
grant select on t_ctx to authenticated;
\o /dev/null

set role authenticated;
select set_config('request.jwt.claim.sub', (select v from t_ctx where k = 'other'), false);
do $$ begin
  assert (select count(*) from public.health_samples) = 0, 'other user sees no samples';
  assert (select count(*) from public.workouts) = 0, 'other user sees no workouts';
  assert (select count(*) from public.daily_summaries) = 0, 'other user sees no summaries';
  assert (select count(*) from public.profiles) = 1, 'other user sees only own profile';
end $$;

select set_config('request.jwt.claim.sub', (select v from t_ctx where k = 'uid'), false);
do $$ begin
  assert (select count(*) from public.health_samples) > 0, 'owner sees own samples';
  assert (select count(*) from public.workout_route_points) = 2, 'owner sees route';
  assert (select count(*) from public.data_sources) = 1, 'owner sees own source';
  assert (select count(*) from public.data_source_secrets) = 0, 'nobody reads token hashes';
end $$;

-- משתמש לא יכול לכתוב דגימות, לא ישירות ולא דרך ה-RPC
do $$ begin
  begin
    insert into public.health_samples (user_id, source_id, metric, start_at, end_at, value, unit)
    select (select v::uuid from t_ctx where k = 'uid'), id, 'steps', now(), now(), 1, 'count' from public.data_sources;
    assert false, 'direct insert should fail';
  exception when insufficient_privilege then null; end;

  begin
    perform public.ingest_canonical_batch(gen_random_uuid(), '{}'::jsonb);
    assert false, 'rpc should be denied';
  exception when insufficient_privilege then null; end;

  begin
    perform public.create_ingest_source((select v::uuid from t_ctx where k = 'uid'));
    assert false, 'issuing tokens should be denied';
  exception when insufficient_privilege then null; end;
end $$;

-- עדכון הערות מותר, עדכון נתוני שעון אסור
do $$ begin
  update public.workouts set notes = 'עדכון מהמשתמשת' where activity_type = 'outdoor_run';
  assert found, 'owner can update notes';
  begin
    update public.workouts set distance_m = 99999;
    assert false, 'updating watch data should fail';
  exception when insufficient_privilege then null; end;
end $$;

reset role;
\o
\echo '  ✓ ingest, idempotency, sleep formats, timezone, baseline/recovery, RLS'
