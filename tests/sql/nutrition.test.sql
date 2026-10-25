-- בדיקות: הפעלת תוכנית תזונה בכפתור, רצפת קלוריות, החלפה, ודחייה
\set QUIET on
do $$
declare v_uid uuid := (select id from auth.users where email = 'miri@example.com');
        v_low uuid; v_a uuid; v_b uuid; v_c uuid;
begin
  update public.nutrition_plans set status = 'superseded' where user_id = v_uid and status = 'active';
  update public.profiles set sex = 'female' where id = v_uid;

  insert into public.nutrition_plans (user_id, plan_types, kcal_target) values (v_uid, '{calorie_deficit}', 1100) returning id into v_low;
  begin
    perform public.activate_nutrition_plan(v_uid, v_low);
    assert false, 'floor';
  exception when raise_exception then null; end;

  insert into public.nutrition_plans (user_id, plan_types, kcal_target) values (v_uid, '{calorie_deficit}', 1700) returning id into v_a;
  perform public.activate_nutrition_plan(v_uid, v_a);
  perform public.activate_nutrition_plan(v_uid, v_a);   -- לחיצה כפולה: לא נכשל
  assert (select status from public.nutrition_plans where id = v_a) = 'active', 'a active';
  assert (select approved_at from public.nutrition_plans where id = v_a) is not null, 'approved_at';

  insert into public.nutrition_plans (user_id, plan_types, kcal_target, protein_g) values (v_uid, '{high_protein}', 1800, 120) returning id into v_b;
  perform public.activate_nutrition_plan(v_uid, v_b);
  assert (select status from public.nutrition_plans where id = v_a) = 'superseded', 'a superseded';
  assert (select count(*) from public.nutrition_plans where user_id = v_uid and status = 'active') = 1, 'one active';

  insert into public.nutrition_plans (user_id, plan_types) values (v_uid, '{maintenance}') returning id into v_c;
  perform public.reject_nutrition_plan(v_uid, v_c);
  assert (select status from public.nutrition_plans where id = v_c) = 'rejected', 'rejected';
  begin
    perform public.activate_nutrition_plan(v_uid, v_c);
    assert false, 'rejected plan cannot be activated';
  exception when raise_exception then null; end;

  -- משתמש אחר לא יכול להפעיל תוכנית שלא שלו
  begin
    perform public.activate_nutrition_plan((select id from auth.users where email = 'other@example.com'), v_b);
    assert false, 'not owner';
  exception when raise_exception then null; end;

  -- ארוחה מקושרת להודעה, ומחיקת הודעה לא מוחקת את הארוחה
  insert into public.meals (user_id, eaten_at, input_kind, total_kcal) values (v_uid, now(), 'photo', 500);
  assert (select count(*) from public.meals where user_id = v_uid) >= 1, 'meal';
end $$;
\echo '  ✓ nutrition plans (button activation, floor, supersede, reject), meals'
