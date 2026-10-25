-- בדיקה: payload מאנדרואיד (Health Connect) נכתב דרך אותו RPC, ו-HRV מסוג RMSSD נכנס לסיכום היומי
\set QUIET on
\set batch_hc_q '''' :batch_hc ''''
create temp table t_hc as select :batch_hc_q::jsonb as b;
do $$
declare v_uid uuid; r record; v_stats jsonb; d record;
begin
  insert into auth.users (email) values ('android@example.com') returning id into v_uid;
  select * into r from public.create_ingest_source(v_uid, 'health_connect', 'גלקסי');
  v_stats := public.ingest_canonical_batch(r.source_id, (select b from t_hc));
  assert (v_stats ->> 'sleep_sessions')::int = 2, 'two nights';
  assert (v_stats ->> 'workouts')::int = 2, 'two workouts';

  select * into d from public.daily_summaries where user_id = v_uid and day = '2026-11-03';
  assert d.steps = 1234, 'steps';
  assert d.resting_hr = 57, 'resting hr';
  assert d.hrv_avg = 41.5, 'hrv from rmssd';
  assert d.sleep_min = 420, 'sleep';
  assert d.workouts_count = 2, 'workouts count';
  assert d.exercise_min = 65, 'exercise minutes derived from sessions';
  assert d.weight_kg = 61.8, 'weight';

  -- שליחה חוזרת של אותו חלון (האפליקציה שולחת 48 שעות כל פעם): בלי כפילויות
  perform public.ingest_canonical_batch(r.source_id, (select b from t_hc));
  assert (select steps from public.daily_summaries where user_id = v_uid and day = '2026-11-03') = 1234, 'idempotent steps';
  assert (select count(*) from public.workouts where user_id = v_uid) = 2, 'idempotent workouts';
end $$;
\echo '  ✓ health connect: android payload end-to-end, rmssd hrv, idempotent resend'
