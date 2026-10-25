-- =====================================================================
-- daily_checkin: "היי, מה שלומך היום?" למי שלא כתב ולא תיעד כלום עד הצהריים.
-- =====================================================================

alter table public.outbound_notifications drop constraint outbound_notifications_kind_check;
alter table public.outbound_notifications add constraint outbound_notifications_kind_check
  check (kind in ('evening_summary', 'pre_workout', 'morning_fallback', 'weekly_review', 'meal_reminder', 'workout_followup', 'onboarding', 'daily_checkin'));
