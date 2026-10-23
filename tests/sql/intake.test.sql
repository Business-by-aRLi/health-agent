-- בדיקות: שאלון היכרות ומדידות ידניות
\set QUIET on
do $$
declare v_uid uuid := (select id from auth.users where email = 'miri@example.com');
        v_src int;
begin
  perform public.mark_intake(v_uid, 'goals', 'asked');
  perform public.mark_intake(v_uid, 'goals', 'asked');
  assert (select ask_count from public.intake_status where user_id = v_uid and field = 'goals') = 2, 'ask_count increments';
  perform public.mark_intake(v_uid, 'goals', 'declined');
  assert (select status from public.intake_status where user_id = v_uid and field = 'goals') = 'declined', 'declined';
  assert (select ask_count from public.intake_status where user_id = v_uid and field = 'goals') = 2, 'decline keeps count';
  assert (select last_asked_at from public.intake_status where user_id = v_uid and field = 'goals') is not null, 'decline keeps last ask';

  perform public.log_manual_measurement(v_uid, 'body_mass', 64.5, '2026-10-24 09:00:00+03');
  perform public.log_manual_measurement(v_uid, 'body_mass', 64.5, '2026-10-24 09:00:00+03');  -- אידמפוטנטי
  select count(*) into v_src from public.data_sources where user_id = v_uid and provider = 'manual';
  assert v_src = 1, 'one manual source';
  assert (select count(*) from public.health_samples where user_id = v_uid and metric = 'body_mass' and meta->>'via' = 'chat') = 1, 'one sample';
  assert (select weight_kg from public.daily_summaries where user_id = v_uid and day = '2026-10-24') = 64.5, 'summary updated';

  begin
    perform public.log_manual_measurement(v_uid, 'body_mass', 640, now());
    assert false, 'range check';
  exception when raise_exception then null; end;
  insert into public.health_events (user_id, kind, label_he, started_at, severity)
  values (v_uid, 'migraine', 'מיגרנה', now(), 7);
  begin
    insert into public.health_events (user_id, kind, started_at) values (v_uid, 'Migraine!', now());
    assert false, 'kind slug check';
  exception when check_violation then null; end;
  begin
    insert into public.health_events (user_id, kind, started_at, ended_at) values (v_uid, 'headache', now(), now() - interval '1 hour');
    assert false, 'range check';
  exception when check_violation then null; end;
  begin
    perform public.log_manual_measurement(v_uid, 'blood_sugar', 90, now());
    assert false, 'metric check';
  exception when raise_exception then null; end;
end $$;

create temp table t_intake as select (select id from auth.users where email = 'other@example.com') as other;
grant select on t_intake to authenticated;
\o /dev/null
set role authenticated;
select set_config('request.jwt.claim.sub', (select other::text from t_intake), false);
do $$ begin
  assert (select count(*) from public.intake_status) = 0, 'other: no intake rows';
  assert (select count(*) from public.health_events) = 0, 'other: no events';
  begin
    perform public.mark_intake((select auth.uid()), 'sex', 'none');
    assert false, 'users cannot call mark_intake';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
\o
\echo '  ✓ intake status, manual measurements, health events, RLS'
