-- =====================================================================
-- nutrition: תיעוד ארוחות מתמונה / קול / טקסט, ותוכניות תזונה שמופעלות בכפתור.
-- הטבלאות meals, meal_items ו-nutrition_plans נוצרו ב-domain. כאן: קישור להודעה,
-- אחסון תמונות, והפעלת תוכנית בצורה בטוחה.
-- =====================================================================

-- הודעה שהגיעה עם קובץ (תמונת ארוחה, ובהמשך בדיקת דם): הנתיב ב-Storage
alter table public.messages add column media_path text;

-- מאיזו הודעה נרשמה הארוחה (לתיקונים ולמעקב)
alter table public.meals add column source_message_id bigint references public.messages (id) on delete set null;

-- ---------------------------------------------------------------------
-- Storage: bucket פרטי לקבצים של משתמשים. נתיב: {user_id}/{yyyy-mm-dd}/{message_id}.{ext}
-- 🧠 התיקייה הראשונה בנתיב היא ה-user_id, וה-policy בודקת אותה. כך משתמש יכול לקרוא
--    רק את הקבצים שלו (בעתיד, מהדשבורד), והכתיבה עוברת רק דרך השרת (service role).
--    עטוף בבדיקה כי בסביבת הבדיקות המקומית אין סכמת storage.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('user-media', 'user-media', false, 10485760,
            array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'])
    on conflict (id) do nothing;

    if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'user-media: owner reads') then
      create policy "user-media: owner reads" on storage.objects for select to authenticated
        using (bucket_id = 'user-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- activate_nutrition_plan: נקרא רק כשהמשתמש לחץ על כפתור האישור בטלגרם.
-- בודק רצפת קלוריות לפי מגדר, מסמן את התוכנית הקודמת כ-superseded ומפעיל את החדשה,
-- הכול בטרנזקציה אחת.
-- ---------------------------------------------------------------------
create or replace function public.activate_nutrition_plan(p_user_id uuid, p_plan_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_kcal   integer;
  v_sex    text;
begin
  select status, kcal_target into v_status, v_kcal
    from public.nutrition_plans where id = p_plan_id and user_id = p_user_id
    for update;
  if not found then raise exception 'plan not found'; end if;
  if v_status = 'active' then return; end if;   -- לחיצה כפולה על הכפתור
  if v_status <> 'proposed' then raise exception 'plan is %', v_status; end if;

  select sex into v_sex from public.profiles where id = p_user_id;
  if v_kcal is not null and v_kcal < (case when v_sex = 'female' then 1200 else 1500 end) then
    raise exception 'kcal_target below safe floor';
  end if;

  update public.nutrition_plans set status = 'superseded', valid_to = current_date
   where user_id = p_user_id and status = 'active';
  update public.nutrition_plans set status = 'active', approved_at = now(), valid_from = coalesce(valid_from, current_date)
   where id = p_plan_id;
end;
$$;

create or replace function public.reject_nutrition_plan(p_user_id uuid, p_plan_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.nutrition_plans set status = 'rejected'
   where id = p_plan_id and user_id = p_user_id and status = 'proposed';
$$;

revoke execute on function public.activate_nutrition_plan(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.activate_nutrition_plan(uuid, uuid) to service_role;
revoke execute on function public.reject_nutrition_plan(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.reject_nutrition_plan(uuid, uuid) to service_role;
