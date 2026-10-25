// העדפות התזכורות וברירות המחדל. מודול בלי תלויות, כדי ש-tools.ts ו-reminders.ts
// יוכלו לייבא ממנו בלי ייבוא מעגלי.

export type MealSlot = "breakfast" | "lunch" | "dinner";

export interface ReminderPrefs {
  meals: boolean;
  workouts: boolean;
  meal_checks: Record<MealSlot, string | null>; // "HH:MM" או null = כבוי
  checkin: string | null;                       // "מה שלומך היום?" למי ששקט עד השעה הזו. null = כבוי
  pre_workout_lead_min: number;
  quiet_start: string;
  quiet_end: string;
}

export const DEFAULT_PREFS: ReminderPrefs = {
  meals: true,
  workouts: true,
  meal_checks: { breakfast: "10:30", lunch: "14:30", dinner: "20:30" },
  checkin: "12:00",
  pre_workout_lead_min: 90,
  quiet_start: "22:00",
  quiet_end: "07:00",
};

/** מאחד העדפות שמורות עם ברירות המחדל (שדה חסר = ברירת מחדל) */
export function mergePrefs(saved: unknown): ReminderPrefs {
  const s = (saved && typeof saved === "object" ? saved : {}) as Partial<ReminderPrefs>;
  return {
    ...DEFAULT_PREFS,
    ...s,
    meal_checks: { ...DEFAULT_PREFS.meal_checks, ...(s.meal_checks ?? {}) },
  };
}

