// =====================================================================
// היכרות ראשונית: מתי להציע אותה ביוזמה, ומה כתוב בהצעה.
// 🧠 ההצעה עצמה היא טקסט קבוע עם כפתורים, לא תשובה של המודל: היא נשלחת למי שעוד לא
//    כתב כלום (אין לנו מגדר, אז הניסוח ניטרלי), והיא חייבת להיות צפויה וקצרה.
//    הכללים: כל סוג פנייה לכל היותר פעם אחת, לא בשעות השקט, ולא כשהמשתמש באמצע שיחה.
// =====================================================================

import type { InlineKeyboard } from "../telegram.ts";
import type { OnboardingStatus } from "./intake.ts";
import { inQuietHours } from "./reminders.ts";
import type { ReminderPrefs } from "./reminder-prefs.ts";

export const MIN_MISSING_TO_OFFER = 3;   // מי שכבר כמעט מוכר לא צריך "היכרות"
const NUDGE_AFTER_H = 24;                // לא ענו להצעה
const SNOOZE_H = 20;                     // לחצו "אחר כך"
const RESUME_AFTER_H = 24;               // עצרו באמצע

export const OFFER_TEXT =
  "היי, אני המאמן האישי שלך 👋\n" +
  "כדי שההמלצות שלי יתאימו בדיוק לך, אשמח להכיר קצת: איך לפנות אלייך/אליך, כמה פרטים בסיסיים ומה המטרות. " +
  "זה לוקח כ-3 דקות, אפשר לדלג על כל שאלה, ואפשר לעצור באמצע ולהמשיך מתי שנוח.";

const TEXTS = {
  offer: OFFER_TEXT,
  offer_nudge: "רק מזכיר בעדינות 🙂 אם יש כמה דקות, אשמח שנכיר קצת כדי שאוכל לדייק את ההמלצות. ואם לא עכשיו, הכול בסדר.",
  snooze_nudge: "אמרנו שנכיר \"אחר כך\" 🙂 מתאים עכשיו? זה קצר, ואפשר לדלג על כל שאלה.",
  resume: "עצרנו באמצע ההיכרות. נמשיך מאיפה שהפסקנו? ובינתיים אפשר לשאול אותי כל דבר.",
} as const;

export type OnboardingRef = keyof typeof TEXTS;

export function onboardingKeyboard(ref: OnboardingRef = "offer"): InlineKeyboard {
  return [[
    { text: ref === "resume" ? "נמשיך 👍" : "בואו נכיר 🙂", callback_data: "onb:start" },
    { text: "אחר כך", callback_data: "onb:later" },
  ]];
}

export interface OnboardingState {
  now: Date;
  timezone: string;
  prefs: ReminderPrefs;                 // בשביל שעות השקט
  status: OnboardingStatus;
  statusUpdatedAt: string | null;
  missingCount: number;
  lastUserMessageAt: string | null;
  sent: Set<string>;                    // ref_key-ים של onboarding שכבר נשלחו (בלי הגבלת זמן)
}

const hoursSince = (iso: string | null, now: Date) => (iso ? (now.getTime() - Date.parse(iso)) / 3600_000 : Infinity);

/** איזו פנייה יזומה מגיעה עכשיו, אם בכלל */
export function planOnboarding(st: OnboardingState): { ref: OnboardingRef; text: string; keyboard: InlineKeyboard } | null {
  if (inQuietHours(st.now, st.timezone, st.prefs)) return null;
  if (hoursSince(st.lastUserMessageAt, st.now) < 0.34) return null; // כותבים עכשיו: לא קוטעים
  const pick = (ref: OnboardingRef) => (st.sent.has(ref) ? null : { ref, text: TEXTS[ref], keyboard: onboardingKeyboard(ref) });

  switch (st.status) {
    case null:
      return st.missingCount >= MIN_MISSING_TO_OFFER ? pick("offer") : null;
    case "offered":
      return hoursSince(st.statusUpdatedAt, st.now) >= NUDGE_AFTER_H ? pick("offer_nudge") : null;
    case "snoozed":
      return hoursSince(st.statusUpdatedAt, st.now) >= SNOOZE_H ? pick("snooze_nudge") : null;
    case "in_progress":
      return st.missingCount > 0 && hoursSince(st.statusUpdatedAt, st.now) >= RESUME_AFTER_H &&
          hoursSince(st.lastUserMessageAt, st.now) >= RESUME_AFTER_H
        ? pick("resume")
        : null;
    default:
      return null; // declined / done
  }
}
