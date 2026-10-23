-- בדיקות: מעקב מחזור + טבלאות הדומיין (תזונה, רפואי, אימונים מתוכננים).
-- רץ אחרי ingest.test.sql, על אותו דאטהבייס.
\set QUIET on
create temp table t_b3 as select :'batch3'::jsonb as b;
create temp table t_ctx2 as
  select u.id as uid, (select id from auth.users where email = 'other@example.com') as other,
         (select id from public.data_sources where user_id = u.id) as src
    from auth.users u where u.email = 'miri@example.com';

-- ------------------------------------------------------------ cycle
do $$
declare c record; s jsonb; d jsonb;
begin
  select * into c from t_ctx2;

  -- אי אפשר להפעיל מעקב בלי sex = female
  begin
    update public.profiles set cycle_tracking_enabled = true where id = c.uid;
    assert false, 'cycle tracking must require sex=female';
  exception when check_violation then null; end;

  update public.profiles set sex = 'female', cycle_tracking_enabled = true where id = c.uid;
  s := public.ingest_canonical_batch(c.src, (select b from t_b3));
  assert (select count(*) from public.health_samples where metric = 'menstrual_flow') = 15, 'flow samples';

  d := (select cycle from public.daily_summaries where user_id = c.uid and day = '2026-10-22');
  raise notice 'cycle 2026-10-22: %', d;
  assert d ->> 'last_period_start' = '2026-10-14', 'last start';
  assert (d ->> 'cycle_day')::int = 9, 'cycle day';
  assert (d ->> 'avg_cycle_len')::int = 29, 'avg len (29, 29)';
  assert d ->> 'phase_est' = 'follicular', 'phase';
  assert (d ->> 'flow')::boolean = false, 'no flow today';

  d := (select cycle from public.daily_summaries where user_id = c.uid and day = '2026-10-15');
  assert d ->> 'phase_est' = 'menstrual' and (d ->> 'cycle_day')::int = 2, format('menstrual %s', d);

  -- 'None' (value 0) ב-20.10 לא נחשב דימום
  assert (select (cycle ->> 'flow')::boolean from public.daily_summaries where user_id = c.uid and day = '2026-10-20') = false,
         'None is not flow';

  -- כיבוי → cycle = null בחישוב הבא
  update public.profiles set cycle_tracking_enabled = false where id = c.uid;
  perform public.recompute_daily_summary(c.uid, '2026-10-22');
  assert (select cycle from public.daily_summaries where user_id = c.uid and day = '2026-10-22') is null, 'disabled → null';
  update public.profiles set cycle_tracking_enabled = true where id = c.uid;
end $$;

-- ------------------------------------------------------------ domain
do $$
declare c record; r uuid; p1 uuid;
begin
  select * into c from t_ctx2;

  insert into public.lab_reports (user_id, taken_on, lab_name) values (c.uid, '2026-09-01', 'מכבי') returning id into r;
  insert into public.lab_results (report_id, user_id, analyte_code, analyte_name_raw, value, unit, ref_low, ref_high, taken_on) values
    (r, c.uid, 'ferritin', 'פריטין', 12, 'ng/mL', 15, 150, '2026-09-01'),
    (r, c.uid, 'ldl',      'LDL',    142, 'mg/dL', null, 130, '2026-09-01'),
    (r, c.uid, 'tsh',      'TSH',    2.1, 'mIU/L', 0.4, 4.0, '2026-09-01');
  insert into public.lab_results (report_id, user_id, analyte_code, analyte_name_raw, value_text, taken_on)
    values (r, c.uid, 'hcg', 'בטא HCG', 'שלילי', '2026-09-01');
  assert (select string_agg(analyte_code || ':' || coalesce(flag, '-'), ',' order by analyte_code) from public.lab_results)
         = 'ferritin:low,hcg:-,ldl:high,tsh:normal', 'generated flags';

  insert into public.medications (user_id, kind, name, active_ingredient, dose, dose_unit, timing)
    values (c.uid, 'supplement', 'ויטמין D', 'cholecalciferol', 2000, 'IU', 'עם ארוחה');
  insert into public.medications (user_id, kind, name, stopped_on) values (c.uid, 'medication', 'ישן', '2026-01-01');
  assert (select count(*) from public.medications where active) = 1, 'active generated';

  -- תוכנית תזונה: active דורש אישור, ורק אחת active
  begin
    insert into public.nutrition_plans (user_id, plan_types, status) values (c.uid, '{calorie_deficit}', 'active');
    assert false, 'active without approval';
  exception when check_violation then null; end;
  insert into public.nutrition_plans (user_id, plan_types, kcal_target, protein_g, status, approved_at)
    values (c.uid, '{calorie_deficit,high_protein}', 1700, 120, 'active', now()) returning id into p1;
  begin
    insert into public.nutrition_plans (user_id, plan_types, status, approved_at) values (c.uid, '{maintenance}', 'active', now());
    assert false, 'two active plans';
  exception when unique_violation then null; end;
  begin
    insert into public.nutrition_plans (user_id, plan_types, kcal_target) values (c.uid, '{calorie_deficit}', 600);
    assert false, 'kcal floor';
  exception when check_violation then null; end;
  begin
    insert into public.nutrition_plans (user_id, plan_types) values (c.uid, '{keto_magic}');
    assert false, 'unknown plan type';
  exception when check_violation then null; end;

  insert into public.planned_sessions (user_id, planned_date, planned_start, activity_type, title)
    values (c.uid, '2026-10-24', '07:00', 'outdoor_run', 'ריצה קלה 40 דק''');
  update public.workouts set planned_session_id = (select id from public.planned_sessions limit 1)
   where activity_type = 'outdoor_run';
  assert found, 'workout ↔ planned session FK';
end $$;

-- ------------------------------------------------------------- RLS
grant select on t_ctx2 to authenticated;
\o /dev/null
set role authenticated;
select set_config('request.jwt.claim.sub', (select other::text from t_ctx2), false);
do $$ begin
  assert (select count(*) from public.lab_results) = 0, 'other: no labs';
  assert (select count(*) from public.medications) = 0, 'other: no meds';
  assert (select count(*) from public.nutrition_plans) = 0, 'other: no plans';
  begin
    insert into public.medications (user_id, kind, name) select uid, 'supplement', 'x' from t_ctx2;
    assert false, 'cannot write into someone else';
  exception when insufficient_privilege then null; end;
end $$;

select set_config('request.jwt.claim.sub', (select uid::text from t_ctx2), false);
do $$ begin
  assert (select count(*) from public.lab_results) = 4, 'owner sees labs';
  insert into public.health_conditions (user_id, name, code) select uid, 'תת-פעילות בלוטת התריס', 'hypothyroidism' from t_ctx2;
  insert into public.nutrition_plans (user_id, plan_types, created_by) select uid, '{glycemic_control}', 'user' from t_ctx2;
  begin
    insert into public.nutrition_plans (user_id, plan_types, created_by, status, approved_at)
      select uid, '{maintenance}', 'user', 'active', now() from t_ctx2;
    assert false, 'user cannot self-activate a plan';
  exception when insufficient_privilege then null; end;
  begin
    update public.nutrition_plans set status = 'active', approved_at = now() where status = 'proposed';
    -- אין policy של update → 0 שורות מתעדכנות, בלי שגיאה
    assert not found, 'user cannot activate via update';
  end;
end $$;
reset role;
\o
\echo '  ✓ cycle tracking (female-only, phases, opt-out), labs flags, meds, plans rules, RLS'
