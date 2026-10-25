-- בדיקות: סוגי תזכורות, מניעת כפילות, ובדיקת הסוד של ה-scheduler
\set QUIET on
do $$
declare v_uid uuid := (select id from auth.users where email = 'miri@example.com');
        v_n int;
begin
  insert into public.outbound_notifications (user_id, kind, ref_key) values (v_uid, 'meal_reminder', '2026-11-03:lunch');
  insert into public.outbound_notifications (user_id, kind, ref_key) values (v_uid, 'meal_reminder', '2026-11-03:lunch')
    on conflict do nothing;
  get diagnostics v_n = row_count;
  assert v_n = 0, 'claim is single';
  insert into public.outbound_notifications (user_id, kind, ref_key) values (v_uid, 'workout_followup', 'x');
  insert into public.outbound_notifications (user_id, kind, ref_key) values (v_uid, 'daily_checkin', '2026-11-03');
  insert into public.outbound_notifications (user_id, kind, ref_key) values (v_uid, 'onboarding', 'offer');
  begin
    insert into public.outbound_notifications (user_id, kind, ref_key) values (v_uid, 'spam', 'x');
    assert false, 'kind check';
  exception when check_violation then null; end;

  insert into public.planned_sessions (user_id, planned_date, planned_start, duration_min, activity_type, title)
  values (v_uid, current_date, '07:30', 45, 'pool_swim', 'שחייה');
  begin
    insert into public.planned_sessions (user_id, planned_date, activity_type, title, duration_min) values (v_uid, current_date, 'x', 'x', 2);
    assert false, 'duration check';
  exception when check_violation then null; end;

  -- בלי vault (בסביבה המקומית) הסוד אף פעם לא תקף
  assert not public.scheduler_secret_ok('anything'), 'no vault, no access';
  assert not public.scheduler_secret_ok(null), 'null secret';
end $$;
\echo '  ✓ reminders: kinds, single claim, planned session duration, scheduler secret'
