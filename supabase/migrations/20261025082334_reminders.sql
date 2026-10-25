-- =====================================================================
-- reminders: תזכורות יזומות (ארוחה שלא תועדה, תדריך לפני אימון, מעקב אחרי אימון).
-- pg_cron קורא כל 10 דקות לפונקציה coach-scheduler. הכללים בקוד (reminders.ts),
-- והטבלה outbound_notifications מבטיחה שכל תזכורת נשלחת פעם אחת לכל היותר.
-- =====================================================================

alter table public.outbound_notifications drop constraint outbound_notifications_kind_check;
alter table public.outbound_notifications add constraint outbound_notifications_kind_check
  check (kind in ('evening_summary', 'pre_workout', 'morning_fallback', 'weekly_review', 'meal_reminder', 'workout_followup'));

-- משך מתוכנן: קובע מתי שואלים "איך היה?" אם השעון לא רשם אימון
alter table public.planned_sessions add column duration_min smallint check (duration_min between 5 and 600);
create index planned_sessions_due_idx on public.planned_sessions (planned_date) where status = 'planned';

-- ---------------------------------------------------------------------
-- הסוד שבו pg_cron חותם על הקריאה לפונקציה.
-- 🧠 נוצר בתוך מסד הנתונים (Vault) ולא יוצא ממנו: לא ב-git, לא בצ'אט ולא ב-secrets
--    של הפונקציות. הפונקציה בודקת את ה-header מול ה-RPC scheduler_secret_ok,
--    שרק service role יכול לקרוא לו.
-- ---------------------------------------------------------------------
do $$
begin
  -- dynamic SQL: בסביבה בלי vault ההפניה לטבלה הייתה נכשלת כבר בניתוח, גם כשהתנאי שקרי
  if to_regclass('vault.secrets') is not null then
    execute $q$
      select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'coach_scheduler_secret', 'pg_cron -> coach-scheduler')
       where not exists (select 1 from vault.secrets where name = 'coach_scheduler_secret')
    $q$;
  end if;
end $$;

create or replace function public.scheduler_secret_ok(p_secret text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v text;
begin
  if to_regclass('vault.decrypted_secrets') is null then return false; end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v using 'coach_scheduler_secret';
  return v is not null and p_secret is not null and v = p_secret;
end;
$$;

revoke execute on function public.scheduler_secret_ok(text) from public, anon, authenticated;
grant  execute on function public.scheduler_secret_ok(text) to service_role;

-- ---------------------------------------------------------------------
-- pg_cron + pg_net: כל 10 דקות. עטוף בבדיקה כי בסביבת הבדיקות המקומית אין אותם.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    perform cron.schedule(
      'coach-scheduler',
      '*/10 * * * *',
      $job$
        select net.http_post(
          url     := 'https://hwcgxyreboaqjoxrofgw.supabase.co/functions/v1/coach-scheduler',
          headers := jsonb_build_object(
                       'Content-Type', 'application/json',
                       'x-scheduler-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'coach_scheduler_secret')),
          body    := '{}'::jsonb,
          timeout_milliseconds := 55000
        );
      $job$
    );
  end if;
end $$;
