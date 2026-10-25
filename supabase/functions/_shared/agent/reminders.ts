// =====================================================================
// כללי התזכורות היזומות. פונקציה טהורה: מקבלת מצב ושעה, ומחזירה מה צריך לשלוח.
// 🧠 ההחלטה מתי לפנות היא קוד דטרמיניסטי ונבדק. רק הניסוח עובר למודל, אחרי
//    שכבר הוחלט שיש סיבה לפנות. כך הבוט לא "מחליט" להציק.
// =====================================================================

import { localDate } from "../time.ts";
import { localDateTime } from "./tools.ts";
import type { MealSlot, ReminderPrefs } from "./reminder-prefs.ts";
export { DEFAULT_PREFS, mergePrefs } from "./reminder-prefs.ts";
export type { MealSlot, ReminderPrefs };

// מאיזו שעה ארוחה "נחשבת" לחלון: ארוחה ב-12:00 עונה על בדיקת הצהריים, לא על הבוקר
const SLOT_FROM: Record<MealSlot, string> = { breakfast: "04:00", lunch: "11:00", dinner: "17:00" };

export const MAX_MEAL_REMINDERS_PER_DAY = 2;
export const ACTIVE_CHAT_MIN = 20;        // המשתמש כתב בדקות האחרונות: לא קוטעים
export const STALE_AFTER_MIN = 120;       // תזכורת שפספסה את הזמן שלה בשעתיים כבר לא רלוונטית
export const CHECKIN_GAP_MIN = 90;        // לא שולחים "מה שלומך" מיד אחרי פנייה יזומה אחרת
const DEFAULT_SESSION_MIN = 60;
const FOLLOWUP_AFTER_END_MIN = 60;
const FOLLOWUP_NO_START = "20:00";

export interface PlannedSession {
  id: string;
  planned_date: string;          // YYYY-MM-DD מקומי
  planned_start: string | null;  // HH:MM[:SS] מקומי
  duration_min: number | null;
  title: string;
  activity_type: string;
  status: string;
}

export interface SchedulerState {
  now: Date;
  timezone: string;
  prefs: ReminderPrefs;
  mealTrackingActive: boolean;          // רשמה ארוחה ב-3 הימים האחרונים, או שיש תוכנית פעילה
  mealsToday: string[];                 // eaten_at (ISO)
  sent: Set<string>;                    // "kind:ref_key" שכבר נשלחו
  mealRemindersToday: number;
  lastUserMessageAt: string | null;
  lastProactiveAt: string | null;       // ההודעה היזומה האחרונה מכל סוג (כולל הצעת היכרות)
  sessions: PlannedSession[];           // של היום
  workouts: Array<{ id: string; start_at: string; activity_type: string }>; // של היום
}

export interface DueReminder {
  kind: "meal_reminder" | "pre_workout" | "workout_followup" | "daily_checkin";
  ref_key: string;
  info: Record<string, unknown>;
}

const hhmm = (t: string) => t.slice(0, 5);
const at = (day: string, time: string, tz: string) => Date.parse(localDateTime(`${day} ${hhmm(time)}`, tz));

/** האם שעה מקומית נופלת בשעות השקט (כולל טווח שחוצה חצות, כמו 22:00–07:00) */
export function inQuietHours(now: Date, tz: string, prefs: ReminderPrefs): boolean {
  const t = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  const [s, e] = [prefs.quiet_start, prefs.quiet_end];
  return s <= e ? t >= s && t < e : t >= s || t < e;
}

const isDue = (dueAt: number, now: number) => now >= dueAt && now < dueAt + STALE_AFTER_MIN * 60_000;

/** אימון שהשעון רשם ומתאים לאימון המתוכנן: באותו יום, ואם יש שעה, בסביבתה */
export function matchWorkout(s: PlannedSession, workouts: SchedulerState["workouts"], tz: string) {
  if (!s.planned_start) return workouts[0] ?? null;
  const start = at(s.planned_date, s.planned_start, tz);
  return workouts.find((w) => {
    const t = Date.parse(w.start_at);
    return t >= start - 3 * 3600_000 && t <= start + 4 * 3600_000;
  }) ?? null;
}

export function planReminders(st: SchedulerState): { due: DueReminder[]; autoDone: Array<{ session_id: string; workout_id: string }> } {
  const now = st.now.getTime();
  const today = localDate(st.now.toISOString(), st.timezone);
  const due: DueReminder[] = [];
  const autoDone: Array<{ session_id: string; workout_id: string }> = [];
  const quiet = inQuietHours(st.now, st.timezone, st.prefs);
  const chatting = st.lastUserMessageAt !== null && now - Date.parse(st.lastUserMessageAt) < ACTIVE_CHAT_MIN * 60_000;

  // ---- אימונים מתוכננים
  for (const s of st.sessions) {
    if (s.status !== "planned" || s.planned_date !== today) continue;
    const match = matchWorkout(s, st.workouts, st.timezone);
    if (match) {
      autoDone.push({ session_id: s.id, workout_id: match.id }); // השעון רשם, אין צורך לשאול
      continue;
    }
    if (!st.prefs.workouts) continue;

    if (s.planned_start) {
      const start = at(s.planned_date, s.planned_start, st.timezone);
      let preAt = start - st.prefs.pre_workout_lead_min * 60_000;
      // תדריך שנופל בשעות השקט זז לסוף השקט, אם זה עדיין לפני האימון
      const quietEnd = at(today, st.prefs.quiet_end, st.timezone);
      if (inQuietHours(new Date(preAt), st.timezone, st.prefs) && preAt < quietEnd) preAt = quietEnd;
      if (preAt < start && isDue(preAt, now) && now < start && !quiet && !st.sent.has(`pre_workout:${s.id}`)) {
        due.push({ kind: "pre_workout", ref_key: s.id, info: { session: s } });
      }
    }
    const followAt = s.planned_start
      ? at(s.planned_date, s.planned_start, st.timezone) + ((s.duration_min ?? DEFAULT_SESSION_MIN) + FOLLOWUP_AFTER_END_MIN) * 60_000
      : at(s.planned_date, FOLLOWUP_NO_START, st.timezone);
    if (isDue(followAt, now) && !quiet && !st.sent.has(`workout_followup:${s.id}`)) {
      due.push({ kind: "workout_followup", ref_key: s.id, info: { session: s } });
    }
  }

  // ---- "מה שלומך היום?": לא כתב ולא תיעד כלום עד שעת הבדיקה
  // 🧠 משתמש שקט מקבל הודעה אחת ביום, לא שרשרת: אחרי ה-check-in, כל עוד לא ענה,
  //    לא נשלחות גם תזכורות ארוחה.
  const wroteToday = st.lastUserMessageAt !== null && localDate(st.lastUserMessageAt, st.timezone) === today;
  const quietUser = !wroteToday && st.mealsToday.length === 0;
  const checkinSent = st.sent.has(`daily_checkin:${today}`);
  if (st.prefs.checkin && quietUser && !quiet && !checkinSent) {
    const recentProactive = st.lastProactiveAt !== null && now - Date.parse(st.lastProactiveAt) < CHECKIN_GAP_MIN * 60_000;
    if (isDue(at(today, st.prefs.checkin, st.timezone), now) && !recentProactive && due.length === 0) {
      due.push({ kind: "daily_checkin", ref_key: today, info: {} });
    }
  }
  const checkinPending = due.some((d) => d.kind === "daily_checkin") || (checkinSent && !wroteToday);

  // ---- ארוחות שלא תועדו
  if (st.prefs.meals && st.mealTrackingActive && !quiet && !chatting && !checkinPending) {
    let budget = MAX_MEAL_REMINDERS_PER_DAY - st.mealRemindersToday;
    for (const slot of ["breakfast", "lunch", "dinner"] as MealSlot[]) {
      const check = st.prefs.meal_checks[slot];
      if (!check || budget <= 0) continue;
      const checkAt = at(today, check, st.timezone);
      if (!isDue(checkAt, now) || st.sent.has(`meal_reminder:${today}:${slot}`)) continue;
      const from = at(today, SLOT_FROM[slot], st.timezone);
      const logged = st.mealsToday.some((m) => {
        const t = Date.parse(m);
        return t >= from && t <= now;
      });
      if (logged) continue;
      due.push({ kind: "meal_reminder", ref_key: `${today}:${slot}`, info: { slot, meals_today: st.mealsToday.length } });
      budget--;
    }
  }

  return { due, autoDone };
}
