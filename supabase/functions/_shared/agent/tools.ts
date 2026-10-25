// =====================================================================
// הכלים של הסוכן: הגדרות (מה המודל רואה) + מימוש (מה השרת עושה).
//
// 🧠 כלל אבטחה: הסוכן רץ עם service role, שעוקף RLS. לכן user_id **לעולם** לא
//    מגיע מהמודל. הוא נקבע בשרת (מי ששלח את ההודעה) ומוזרק לכל שאילתה.
//    המודל יכול לבקש "האימונים שלי", אבל לא "האימונים של משתמש X".
// =====================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import { INTAKE_KEYS } from "./intake.ts";
import { mergePrefs } from "./reminder-prefs.ts";
import { ageFrom, localDate } from "../time.ts";
import { addTotals, energyEstimate, type MealItem, mealFeedback, type PlanTargets, planWarnings, sumItems, type Totals, validateItem, ZERO } from "./nutrition.ts";

type Tool = Anthropic.Beta.Messages.BetaTool;

const DATE = { type: "string", description: "YYYY-MM-DD (לפי השעון המקומי של המשתמש)" } as const;

// strict: true + additionalProperties: false מבטיחים שהקלט תואם לסכימה בדיוק.
// שדות אופציונליים מוגדרים כ-nullable ועדיין ב-required, כפי ש-strict דורש.
// 🧠 ל-strict יש מגבלות מצטברות לבקשה: עד 20 כלים, עד 16 פרמטרים עם union type
//    (כולל ["string", "null"]), ועד 24 פרמטרים אופציונליים. לכן strict שמור לכלי כתיבה
//    קטנים. כלי קריאה, וכלי כתיבה עם הרבה שדות nullable, רצים בלי strict, והקלט שלהם
//    נבדק כאן בקוד (dateRange, בדיקות טווח ו-enum). הבדיקות מחשבות את המגבלות אוטומטית.
const NON_STRICT = new Set([
  "get_daily_summaries", "get_workouts", "get_workout_detail", "get_sleep", "get_trend", "get_samples", "get_events",
  "update_profile", "add_medication", "log_event",
  "log_meal", "update_meal", "get_meals", "propose_nutrition_plan",
  "plan_session", "update_planned_session", "set_reminder_prefs",
]);
export const STRICT_LIMITS = { tools: 20, unionParams: 16, optionalParams: 24 };

const TOOL_DEFS: Tool[] = [
  {
    name: "get_daily_summaries",
    description:
      "סיכום יומי לטווח תאריכים: צעדים, קלוריות פעילות, דקות אימון, מספר אימונים, דופק במנוחה, HRV, שינה (דקות, עמוקה, REM, יעילות), משקל, ציון התאוששות, מחזור (אם מופעל). עד 120 יום.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { from: DATE, to: DATE },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "get_workouts",
    description:
      "רשימת אימונים בטווח תאריכים, עם סוג, משך, מרחק, קלוריות ודופק. activity_type מסנן לפי סוג מנורמל (outdoor_cycling, pool_swim, pilates, functional_strength_training, outdoor_walk, open_water_swim...), או null לכל הסוגים.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { from: DATE, to: DATE, activity_type: { type: ["string", "null"] } },
      required: ["from", "to", "activity_type"],
      additionalProperties: false,
    },
  },
  {
    name: "get_workout_detail",
    description:
      "כל הפרטים של אימון אחד: הקפות/ספליטים/מקטעים עם קצב, מהירות ודופק לכל אחד, עקומת דופק (מדוגמת), התאוששות דופק אחרי האימון, מזג אוויר ומדדים נוספים. workout_id מגיע מ-get_workouts.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { workout_id: { type: "string" } },
      required: ["workout_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_sleep",
    description: "לילות שינה בטווח תאריכים: שעת הירדמות וקימה, סה\"כ שינה, שלבים (core/deep/REM/ער). התאריך הוא יום ההתעוררות.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { from: DATE, to: DATE },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "get_trend",
    description: "מגמה של מדד יומי לאורך זמן, מקובצת לפי יום/שבוע/חודש (ממוצע, מינימום, מקסימום, מספר ימים עם נתון). טוב לשאלות כמו 'איך השתנה ה-HRV שלי בחודשיים האחרונים'.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        metric: {
          type: "string",
          enum: [
            "steps", "active_kcal", "exercise_min", "distance_m", "workouts_count", "workout_min",
            "resting_hr", "hrv_avg", "walking_hr", "hr_max", "sleep_min", "sleep_deep_min", "sleep_rem_min",
            "sleep_efficiency", "weight_kg", "recovery_score",
          ],
        },
        from: DATE,
        to: DATE,
        bucket: { type: "string", enum: ["day", "week", "month"] },
      },
      required: ["metric", "from", "to", "bucket"],
      additionalProperties: false,
    },
  },
  {
    name: "get_samples",
    description:
      "דגימות גולמיות (בדרך כלל לפי שעה) של מדד שאין בסיכום היומי: respiratory_rate, spo2, vo2max, walking_speed, walking_step_length, walking_asymmetry_percentage, heart_rate (שעתי, עם min/max), body_mass, wrist_temperature_sleep ועוד. עד 500 נקודות.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { metric: { type: "string" }, from: DATE, to: DATE },
      required: ["metric", "from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "remember",
    description: "שמירת עובדה לטווח ארוך על המשתמש (העדפה, פציעה, לו\"ז, תובנה, התחייבות). משפט אחד, ברור ועצמאי.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["preference", "injury", "schedule", "insight", "commitment", "other"] },
        content: { type: "string" },
      },
      required: ["category", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "forget",
    description: "ביטול זיכרון שכבר לא נכון (לפי memory_id מתוך <context>).",
    strict: true,
    input_schema: {
      type: "object",
      properties: { memory_id: { type: "integer" } },
      required: ["memory_id"],
      additionalProperties: false,
    },
  },
  {
    name: "update_profile",
    description: "עדכון פרטי פרופיל. שדה שלא משתנה = null.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        display_name: { type: ["string", "null"], description: "השם שהמשתמש ביקש שנפנה אליו" },
        birth_date: { type: ["string", "null"], description: "YYYY-MM-DD" },
        sex: { type: ["string", "null"], description: "female | male | other" },
        height_cm: { type: ["number", "null"] },
        activity_level: { type: ["string", "null"] },
        injuries_notes: { type: ["string", "null"], description: "פציעות ומגבלות. \"אין\" כשהמשתמש אמר שאין" },
        training_background: { type: ["string", "null"], description: "היסטוריה אימונית: ענפים, ותק, רמה, הישגים" },
        dietary_notes: { type: ["string", "null"], description: "העדפות תזונה, אלרגיות, כשרות, צמחונות" },
      },
      required: ["display_name", "birth_date", "sex", "height_cm", "activity_level", "injuries_notes", "training_background", "dietary_notes"],
      additionalProperties: false,
    },
  },
  {
    name: "set_goal",
    description: "יצירת מטרה חדשה, רק אחרי שהמשתמש הסכים לה במפורש.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["weight", "body_fat", "steps", "sleep", "strength", "endurance", "race", "habit", "custom"] },
        title: { type: "string" },
        target_value: { type: ["number", "null"] },
        unit: { type: ["string", "null"] },
        target_date: { type: ["string", "null"], description: "YYYY-MM-DD" },
      },
      required: ["kind", "title", "target_value", "unit", "target_date"],
      additionalProperties: false,
    },
  },
  {
    name: "update_goal_status",
    description: "שינוי סטטוס של מטרה קיימת (לפי goal_id מתוך <context>).",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        goal_id: { type: "string" },
        status: { type: "string", enum: ["active", "achieved", "paused", "dropped"] },
      },
      required: ["goal_id", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "set_cycle_tracking",
    description: "הפעלה או כיבוי של מעקב מחזור. אפשרי רק כשבפרופיל sex = female. רק לבקשה מפורשת של המשתמשת.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { enabled: { type: "boolean" } },
      required: ["enabled"],
      additionalProperties: false,
    },
  },
  {
    name: "intake_update",
    description:
      "עדכון מצב שאלת היכרות. asked: מיד כששאלת על שדה (כדי שהבוט לא ישאל שוב מחר). declined: המשתמש לא רוצה לשתף, ולא שואלים שוב. none: המשתמש ענה שאין (אין תרופות, אין פציעות, אין רקע רפואי). כשהמשתמש משתף את המידע עצמו, שמור אותו בכלי המתאים; אין צורך לסמן.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        field: { type: "string", enum: INTAKE_KEYS },
        status: { type: "string", enum: ["asked", "declined", "none"] },
      },
      required: ["field", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "log_measurement",
    description: "רישום מדידת גוף שהמשתמש סיפר: משקל (ק\"ג), אחוז שומן, היקף מותניים (ס\"מ). date = היום שבו נמדד, או null להיום.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        metric: { type: "string", enum: ["body_mass", "body_fat_percentage", "waist_circumference"] },
        value: { type: "number" },
        date: { type: ["string", "null"], description: "YYYY-MM-DD" },
      },
      required: ["metric", "value", "date"],
      additionalProperties: false,
    },
  },
  {
    name: "add_medication",
    description: "רישום תרופה או תוסף שהמשתמש נוטל. שדה לא ידוע = null. לא לשאול על כל השדות; מספיק שם, והשאר אם עלה בשיחה.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["medication", "supplement"] },
        name: { type: "string" },
        dose: { type: ["number", "null"] },
        dose_unit: { type: ["string", "null"], description: "mg, mcg, IU, טבליה..." },
        frequency: { type: ["string", "null"], description: "פעם ביום, פעמיים בשבוע..." },
        timing: { type: ["string", "null"], description: "בבוקר על קיבה ריקה, עם ארוחה..." },
        reason: { type: ["string", "null"] },
        started_on: { type: ["string", "null"], description: "YYYY-MM-DD" },
      },
      required: ["kind", "name", "dose", "dose_unit", "frequency", "timing", "reason", "started_on"],
      additionalProperties: false,
    },
  },
  {
    name: "stop_medication",
    description: "סימון שהמשתמש הפסיק תרופה או תוסף (לפי medication_id מתוך <context>). stopped_on = null להיום.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { medication_id: { type: "string" }, stopped_on: { type: ["string", "null"], description: "YYYY-MM-DD" } },
      required: ["medication_id", "stopped_on"],
      additionalProperties: false,
    },
  },
  {
    name: "add_health_condition",
    description: "רישום רקע רפואי שהמשתמש שיתף: מצב קיים (active), חשד שעדיין בבירור (suspected), או היסטוריה (resolved: ניתוח, פציעה ישנה, מצב שחלף).",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "בעברית, כפי שהמשתמש תיאר" },
        status: { type: "string", enum: ["active", "suspected", "resolved"] },
        diagnosed_on: { type: ["string", "null"], description: "YYYY-MM-DD, או YYYY-01-01 כשידועה רק השנה" },
        notes: { type: ["string", "null"] },
      },
      required: ["name", "status", "diagnosed_on", "notes"],
      additionalProperties: false,
    },
  },
  {
    name: "update_health_condition",
    description: "עדכון סטטוס של רקע רפואי קיים (לפי condition_id מתוך <context>).",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        condition_id: { type: "string" },
        status: { type: "string", enum: ["active", "suspected", "resolved"] },
        notes: { type: ["string", "null"] },
      },
      required: ["condition_id", "status", "notes"],
      additionalProperties: false,
    },
  },
  {
    name: "log_event",
    description:
      "רישום אירוע ביומן הבריאות: התקף מיגרנה, כאב ראש, מחלה, כאב, סטרס, עייפות חריגה, בחילה, אלרגיה וכל דבר שהמשתמש רוצה לעקוב אחריו. kind הוא slug באנגלית ועקבי לאורך זמן (migraine, headache, illness, injury_pain, stress, low_energy, nausea, allergy, period_pain, poor_mood...). זמנים בשעון המקומי בפורמט YYYY-MM-DD HH:MM; started_at = null לעכשיו; ended_at = null אם עדיין נמשך או לא ידוע.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        label_he: { type: "string", description: "איך המשתמש קרא לזה" },
        started_at: { type: ["string", "null"] },
        ended_at: { type: ["string", "null"] },
        severity: { type: ["integer", "null"], description: "1–10" },
        details: {
          type: "object",
          description: "פרטים מובנים. כל שדה שלא עלה בשיחה = null",
          properties: {
            triggers: { type: ["array", "null"], items: { type: "string" } },
            medication_taken: { type: ["string", "null"] },
            aura: { type: ["boolean", "null"] },
            location: { type: ["string", "null"] },
            symptoms: { type: ["array", "null"], items: { type: "string" } },
          },
          required: ["triggers", "medication_taken", "aura", "location", "symptoms"],
          additionalProperties: false,
        },
        notes: { type: ["string", "null"] },
      },
      required: ["kind", "label_he", "started_at", "ended_at", "severity", "details", "notes"],
      additionalProperties: false,
    },
  },
  {
    name: "update_event",
    description: "עדכון אירוע קיים ביומן (לפי event_id מתוך <context> או get_events): שעת סיום, עוצמה, הערות. שדה שלא משתנה = null.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string" },
        ended_at: { type: ["string", "null"], description: "YYYY-MM-DD HH:MM מקומי" },
        severity: { type: ["integer", "null"] },
        notes: { type: ["string", "null"] },
      },
      required: ["event_id", "ended_at", "severity", "notes"],
      additionalProperties: false,
    },
  },
  {
    name: "get_events",
    description:
      "אירועים מהיומן בטווח תאריכים (עד 366 יום), עם תמונת מצב לכל אירוע: השינה בלילה שלפניו, HRV, דופק במנוחה, התאוששות ויום מחזור (אם מופעל) ביום האירוע, ופעילות ואימונים ביום שלפניו. כולל סיכום: כמה אירועים, עוצמה ממוצעת, ושינה ממוצעת לפני אירוע לעומת כל הטווח. kind = null לכל הסוגים.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { from: DATE, to: DATE, kind: { type: ["string", "null"] } },
      required: ["from", "to", "kind"],
      additionalProperties: false,
    },
  },
  {
    name: "log_meal",
    description:
      "רישום ארוחה (מתמונה, הודעה קולית או תיאור). פרק את הארוחה לפריטים, והערך לכל פריט כמות, קלוריות ומאקרו. את הסכומים, ההשוואה לתוכנית ומה שנשאר להיום השרת מחשב ומחזיר. eaten_at בשעון המקומי YYYY-MM-DD HH:MM, או null לעכשיו. confidence בין 0 ל-1: כמה אתה בטוח בזיהוי ובכמויות. ארוחה אחת = קריאה אחת.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        meal_type: { type: ["string", "null"], enum: ["breakfast", "lunch", "dinner", "snack", "pre_workout", "post_workout", null] },
        eaten_at: { type: ["string", "null"] },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name_he: { type: "string" },
              quantity: { type: ["number", "null"] },
              unit: { type: ["string", "null"], description: "גרם, מ\"ל, יחידה, כוס, כף..." },
              kcal: { type: ["number", "null"] },
              protein_g: { type: ["number", "null"] },
              carbs_g: { type: ["number", "null"] },
              fat_g: { type: ["number", "null"] },
              fiber_g: { type: ["number", "null"] },
              glycemic_load_est: { type: ["number", "null"], description: "עומס גליקמי משוער של הפריט במנה הזו" },
            },
            required: ["name_he", "quantity", "unit", "kcal", "protein_g", "carbs_g", "fat_g", "fiber_g", "glycemic_load_est"],
            additionalProperties: false,
          },
        },
        confidence: { type: "number" },
        notes: { type: ["string", "null"] },
      },
      required: ["meal_type", "eaten_at", "items", "confidence", "notes"],
      additionalProperties: false,
    },
  },
  {
    name: "update_meal",
    description:
      "תיקון ארוחה שנרשמה (לפי meal_id מתוך <context> או get_meals). confirm: המשתמש אישר שהזיהוי נכון. replace_items: החלפת כל רשימת הפריטים בגרסה המתוקנת (שלח את כל הפריטים, לא רק את מה שהשתנה). delete: המשתמש אומר שלא אכל את זה או שזו כפילות. meal_type ו-eaten_at: null אם לא משתנים.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        meal_id: { type: "string" },
        action: { type: "string", enum: ["confirm", "replace_items", "delete"] },
        items: { type: ["array", "null"], items: { type: "object" }, description: "רק ל-replace_items, באותו מבנה של log_meal" },
        meal_type: { type: ["string", "null"] },
        eaten_at: { type: ["string", "null"] },
      },
      required: ["meal_id", "action", "items", "meal_type", "eaten_at"],
      additionalProperties: false,
    },
  },
  {
    name: "get_meals",
    description:
      "ארוחות וסיכום תזונה יומי (קלוריות, חלבון, פחמימות, שומן, סיבים) בטווח תאריכים, עד 92 יום, יחד עם יעדי התוכנית הפעילה. פירוט הארוחות והפריטים מוחזר רק לטווח של עד 14 יום. לטווח ארוך יותר מוחזר רק הסיכום היומי.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { from: DATE, to: DATE },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_nutrition_plan",
    description:
      "הצעת תוכנית תזונה, אחרי שבשיחה התבררו המטרה, ההעדפות והמגבלות. התוכנית לא נכנסת לתוקף: המשתמש מקבל כפתור אישור בטלגרם, ורק לחיצה עליו מפעילה אותה. השרת מחזיר הערכת הוצאה אנרגטית (TDEE) ואזהרות; אם יש אזהרה, תקן והצע שוב. אל תבקש מהמשתמש לכתוב 'מאשר/ת', הכפתור מגיע לבד.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        plan_types: {
          type: "array",
          items: { type: "string", enum: ["calorie_deficit", "high_protein", "glycemic_control", "maintenance", "muscle_gain", "anti_inflammatory", "custom"] },
        },
        kcal_target: { type: ["integer", "null"] },
        protein_g: { type: ["integer", "null"] },
        carbs_g: { type: ["integer", "null"] },
        fat_g: { type: ["integer", "null"] },
        fiber_g: { type: ["integer", "null"] },
        rules: {
          type: "object",
          properties: {
            carbs_per_meal_max_g: { type: ["integer", "null"] },
            protein_per_meal_min_g: { type: ["integer", "null"] },
            notes: { type: ["string", "null"], description: "כללים נוספים בעברית: תזמון ארוחות, הליכה אחרי ארוחה, מה להעדיף" },
          },
          required: ["carbs_per_meal_max_g", "protein_per_meal_min_g", "notes"],
          additionalProperties: false,
        },
        rationale: { type: "string", description: "למה התוכנית הזו, בשניים-שלושה משפטים" },
      },
      required: ["plan_types", "kcal_target", "protein_g", "carbs_g", "fat_g", "fiber_g", "rules", "rationale"],
      additionalProperties: false,
    },
  },
  {
    name: "plan_session",
    description:
      "קביעת אימון מתוכנן (\"מחר ב-7 שחייה 45 דקות\"). לפני אימון עם שעה נשלח תדריך קצר, ואם השעון לא רושם אימון מתאים, נשלחת שאלת מעקב. date ו-start בשעון המקומי. start = null אם אין שעה קבועה. activity_type מנורמל כמו ב-get_workouts (pool_swim, outdoor_run, functional_strength_training, pilates, outdoor_cycling, outdoor_walk...).",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        date: DATE,
        start: { type: ["string", "null"], description: "HH:MM" },
        duration_min: { type: ["integer", "null"] },
        activity_type: { type: "string" },
        title: { type: "string", description: "בעברית, קצר: \"שחייה 1,500 מ' קלה\"" },
        details: { type: ["string", "null"], description: "מבנה האימון, עצימות, מטרה" },
      },
      required: ["date", "start", "duration_min", "activity_type", "title", "details"],
      additionalProperties: false,
    },
  },
  {
    name: "update_planned_session",
    description:
      "שינוי אימון מתוכנן (לפי session_id מתוך <context>): הזזה (date/start), סימון שבוצע (done), שלא בוצע (skipped), או ביטול (skipped עם סיבה). שדה שלא משתנה = null.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        status: { type: ["string", "null"], enum: ["planned", "done", "skipped", null] },
        date: { type: ["string", "null"], description: "YYYY-MM-DD" },
        start: { type: ["string", "null"], description: "HH:MM" },
        duration_min: { type: ["integer", "null"] },
        title: { type: ["string", "null"] },
        reason: { type: ["string", "null"], description: "למה השתנה (נשמר למעקב)" },
      },
      required: ["session_id", "status", "date", "start", "duration_min", "title", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "set_reminder_prefs",
    description:
      "שינוי התזכורות היזומות לפי בקשת המשתמש. meals / workouts: הפעלה או כיבוי כללי. breakfast / lunch / dinner: שעת הבדיקה HH:MM, או \"off\" לכיבוי של אותה ארוחה. quiet_start / quiet_end: שעות שקט. pre_workout_lead_min: כמה דקות לפני אימון לשלוח תדריך. שדה שלא משתנה = null.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        meals: { type: ["boolean", "null"] },
        workouts: { type: ["boolean", "null"] },
        breakfast: { type: ["string", "null"] },
        lunch: { type: ["string", "null"] },
        dinner: { type: ["string", "null"] },
        quiet_start: { type: ["string", "null"] },
        quiet_end: { type: ["string", "null"] },
        pre_workout_lead_min: { type: ["integer", "null"] },
      },
      required: ["meals", "workouts", "breakfast", "lunch", "dinner", "quiet_start", "quiet_end", "pre_workout_lead_min"],
      additionalProperties: false,
    },
  },
  {
    name: "onboarding_update",
    description:
      "עדכון מצב ההיכרות הראשונית. in_progress: המשתמש הסכים להכיר (גם אם כתב את זה במילים ולא לחץ על הכפתור). snoozed: \"אחר כך\" (תזכורת אחת למחרת). declined: לא מעוניין בהיכרות מסודרת (הפרטים ייאספו בהדרגה כרגיל). done: סיימתם את השאלות ואת ההגדרות הראשוניות.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { status: { type: "string", enum: ["in_progress", "snoozed", "declined", "done"] } },
      required: ["status"],
      additionalProperties: false,
    },
  },
];

export const TOOLS: Tool[] = TOOL_DEFS.map((t) => (NON_STRICT.has(t.name) ? { ...t, strict: false } : t));

// ---------------------------------------------------------------------------
// מימוש
// ---------------------------------------------------------------------------

export interface ToolContext {
  db: SupabaseClient;
  userId: string;
  timezone: string;
  messageId?: number;
  mediaPath?: string | null;                        // תמונה שהגיעה עם ההודעה הנוכחית
  inputKind?: "text" | "voice" | "photo";
  effects?: { proposedPlanId?: string };            // תופעות לוואי שה-webhook צריך לדעת עליהן (כפתור אישור)
}

type Input = Record<string, unknown>;

export class ToolInputError extends Error {}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** בדיקת טווח תאריכים. strict מבטיח מבנה, אבל לא תוכן ("2026-13-45", טווח הפוך) */
export function dateRange(input: Input, maxDays: number): { from: string; to: string } {
  const from = String(input.from ?? "");
  const to = String(input.to ?? "");
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    throw new ToolInputError("from/to חייבים להיות תאריכים בפורמט YYYY-MM-DD");
  }
  if (from > to) throw new ToolInputError("from מאוחר מ-to");
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
  if (days > maxDays) throw new ToolInputError(`טווח של עד ${maxDays} ימים. צריך טווח קצר יותר, או get_trend לטווחים ארוכים`);
  return { from, to };
}

/** גבולות היום המקומי ב-UTC, כדי לסנן timestamptz לפי "יום" של המשתמש */
export function localDayBounds(day: string, timeZone: string, endOfDay = false): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (endOfDay) d.setUTCDate(d.getUTCDate() + 1);
  const midnight = d.toISOString().slice(0, 10);
  // ה-offset בחצות המקומית (שעון קיץ משתנה בין ימים, ולכן מחשבים לכל יום בנפרד)
  const guess = Date.parse(`${midnight}T00:00:00Z`);
  const offset = tzOffsetMs(guess, timeZone);
  const utc = guess - offset;
  // תיקון שני: אם חצות נופל ממש על מעבר שעון, ה-offset בנקודה המתוקנת קובע
  return new Date(guess - tzOffsetMs(utc, timeZone)).toISOString();
}

/** כמה ה-timezone מקדים את UTC ברגע נתון (במילישניות). לא תלוי ב-timezone של השרת */
export function tzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

const r1 = (n: unknown) => (n === null || n === undefined ? null : Math.round(Number(n) * 10) / 10);
const r0 = (n: unknown) => (n === null || n === undefined ? null : Math.round(Number(n)));

/** דילול סדרה ל-max נקודות, כדי לא להציף את המודל באלפי דגימות */
export function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  return Array.from({ length: max }, (_, i) => arr[Math.floor(i * step)]);
}

export async function executeTool(name: string, input: Input, ctx: ToolContext): Promise<unknown> {
  const { db, userId, timezone } = ctx;

  switch (name) {
    case "get_daily_summaries": {
      const { from, to } = dateRange(input, 120);
      const { data, error } = await db.from("daily_summaries")
        .select("day, steps, active_kcal, exercise_min, workouts_count, workout_min, resting_hr, hrv_avg, sleep_min, sleep_deep_min, sleep_rem_min, sleep_efficiency, weight_kg, recovery_score, cycle")
        .eq("user_id", userId).gte("day", from).lte("day", to).order("day");
      if (error) throw error;
      return (data ?? []).map((d) => ({
        day: d.day, steps: r0(d.steps), active_kcal: r0(d.active_kcal), exercise_min: r0(d.exercise_min),
        workouts: d.workouts_count, workout_min: r0(d.workout_min), resting_hr: r0(d.resting_hr), hrv: r1(d.hrv_avg),
        sleep_min: r0(d.sleep_min), deep_min: r0(d.sleep_deep_min), rem_min: r0(d.sleep_rem_min),
        sleep_eff: d.sleep_efficiency, weight_kg: r1(d.weight_kg), recovery: r0(d.recovery_score),
        ...(d.cycle ? { cycle: d.cycle } : {}),
      }));
    }

    case "get_workouts": {
      const { from, to } = dateRange(input, 366);
      let q = db.from("workouts")
        .select("id, activity_name, activity_type, start_at, duration_s, distance_m, active_kcal, avg_hr, max_hr, perceived_effort, notes")
        .eq("user_id", userId)
        .gte("start_at", localDayBounds(from, timezone))
        .lt("start_at", localDayBounds(to, timezone, true))
        .order("start_at")
        .limit(200);
      if (input.activity_type) q = q.eq("activity_type", String(input.activity_type));
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []).map((w) => ({
        workout_id: w.id, type: w.activity_type, name: w.activity_name,
        start: new Date(w.start_at).toLocaleString("he-IL", { timeZone: timezone }),
        min: r0(Number(w.duration_s) / 60), distance_m: r0(w.distance_m), kcal: r0(w.active_kcal),
        avg_hr: r0(w.avg_hr), max_hr: r0(w.max_hr), rpe: w.perceived_effort, notes: w.notes,
      }));
    }

    case "get_workout_detail": {
      const id = String(input.workout_id ?? "");
      const { data: w, error } = await db.from("workouts")
        .select("id, activity_name, activity_type, start_at, end_at, duration_s, distance_m, active_kcal, total_kcal, elevation_up_m, avg_hr, max_hr, min_hr, is_indoor, location, metrics, perceived_effort, notes")
        .eq("user_id", userId).eq("id", id).maybeSingle();
      if (error) throw error;
      if (!w) throw new ToolInputError("אימון לא נמצא");

      const [{ data: intervals }, { data: hr }, { data: recovery }] = await Promise.all([
        db.from("workout_intervals")
          .select("kind, idx, active_s, distance_m, speed_mps, pace_s_per_km, active_kcal, avg_hr, max_hr")
          .eq("workout_id", id).eq("user_id", userId).order("kind").order("idx").limit(300),
        db.from("workout_samples").select("at, value, value_max")
          .eq("workout_id", id).eq("user_id", userId).eq("metric", "heart_rate").order("at").limit(2000),
        db.from("workout_samples").select("at, value")
          .eq("workout_id", id).eq("user_id", userId).eq("metric", "heart_rate_recovery").order("at").limit(30),
      ]);
      const start = Date.parse(w.start_at);
      const byKind: Record<string, unknown[]> = {};
      for (const i of intervals ?? []) {
        (byKind[i.kind] ??= []).push({
          n: i.idx, s: r0(i.active_s), m: r1(i.distance_m), pace_s_km: r0(i.pace_s_per_km),
          kmh: i.speed_mps === null ? null : r1(Number(i.speed_mps) * 3.6), kcal: r1(i.active_kcal),
          hr: r0(i.avg_hr), hr_max: r0(i.max_hr),
        });
      }
      return {
        workout_id: w.id, type: w.activity_type, name: w.activity_name,
        start: new Date(w.start_at).toLocaleString("he-IL", { timeZone: timezone }),
        min: r1(Number(w.duration_s) / 60), distance_m: r0(w.distance_m), active_kcal: r0(w.active_kcal),
        total_kcal: r0(w.total_kcal), elevation_up_m: r0(w.elevation_up_m),
        hr: { avg: r0(w.avg_hr), max: r0(w.max_hr), min: r0(w.min_hr) },
        indoor: w.is_indoor, location: w.location, rpe: w.perceived_effort, notes: w.notes,
        metrics: w.metrics,
        intervals: byKind,
        hr_curve: downsample(hr ?? [], 40).map((p) => ({
          min: r1((Date.parse(p.at) - start) / 60000), hr: r0(p.value), max: r0(p.value_max),
        })),
        hr_recovery: (recovery ?? []).map((p) => ({ min_after_start: r1((Date.parse(p.at) - start) / 60000), hr: r0(p.value) })),
      };
    }

    case "get_sleep": {
      const { from, to } = dateRange(input, 120);
      const { data, error } = await db.from("sleep_sessions")
        .select("sleep_date, asleep_start, asleep_end, total_asleep_min, in_bed_min, core_min, deep_min, rem_min, awake_min")
        .eq("user_id", userId).gte("sleep_date", from).lte("sleep_date", to).order("sleep_date");
      if (error) throw error;
      const t = (iso: string | null) => iso ? new Date(iso).toLocaleTimeString("he-IL", { timeZone: timezone, hour: "2-digit", minute: "2-digit" }) : null;
      return (data ?? []).map((s) => ({
        date: s.sleep_date, asleep: t(s.asleep_start), woke: t(s.asleep_end),
        total_min: r0(s.total_asleep_min), in_bed_min: r0(s.in_bed_min),
        core: r0(s.core_min), deep: r0(s.deep_min), rem: r0(s.rem_min), awake: r0(s.awake_min),
      }));
    }

    case "get_trend": {
      const { from, to } = dateRange(input, 730);
      const metric = String(input.metric);
      const bucket = String(input.bucket);
      const allowed = (TOOLS.find((t) => t.name === "get_trend")!.input_schema.properties as Record<string, { enum?: string[] }>).metric.enum!;
      if (!allowed.includes(metric)) throw new ToolInputError("מדד לא נתמך");
      if (!["day", "week", "month"].includes(bucket)) throw new ToolInputError("bucket לא נתמך");
      const { data, error } = await db.from("daily_summaries").select(`day, ${metric}`)
        .eq("user_id", userId).gte("day", from).lte("day", to).not(metric, "is", null).order("day");
      if (error) throw error;
      const groups = new Map<string, number[]>();
      for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
        const day = String(row.day);
        const key = bucket === "day" ? day : bucket === "month" ? day.slice(0, 7) : isoWeekStart(day);
        (groups.get(key) ?? groups.set(key, []).get(key)!).push(Number(row[metric]));
      }
      return { metric, bucket, points: [...groups.entries()].map(([period, v]) => ({
        period, avg: r1(v.reduce((a, b) => a + b, 0) / v.length), min: r1(Math.min(...v)), max: r1(Math.max(...v)), days: v.length,
      })) };
    }

    case "get_samples": {
      const { from, to } = dateRange(input, 62);
      const metric = String(input.metric);
      const { data, error } = await db.from("health_samples").select("start_at, value, value_min, value_max, unit")
        .eq("user_id", userId).eq("metric", metric)
        .gte("start_at", localDayBounds(from, timezone)).lt("start_at", localDayBounds(to, timezone, true))
        .order("start_at").limit(500);
      if (error) throw error;
      if (!data?.length) return { metric, points: [], note: "אין דגימות למדד הזה בטווח" };
      return {
        metric, unit: data[0].unit,
        points: data.map((p) => ({
          at: new Date(p.start_at).toLocaleString("he-IL", { timeZone: timezone }),
          v: r1(p.value), ...(p.value_min !== null ? { min: r1(p.value_min), max: r1(p.value_max) } : {}),
        })),
      };
    }

    case "remember": {
      const content = String(input.content ?? "").trim();
      if (!content) throw new ToolInputError("content ריק");
      const { data, error } = await db.from("coach_memory")
        .insert({ user_id: userId, category: input.category, content, source_message_id: ctx.messageId ?? null })
        .select("id").single();
      if (error) throw error;
      return { ok: true, memory_id: data.id };
    }

    case "forget": {
      const { data, error } = await db.from("coach_memory").update({ active: false })
        .eq("user_id", userId).eq("id", Number(input.memory_id)).select("id");
      if (error) throw error;
      return { ok: (data ?? []).length > 0 };
    }

    case "update_profile": {
      const patch: Record<string, unknown> = {};
      for (const k of ["display_name", "birth_date", "sex", "height_cm", "activity_level", "injuries_notes", "training_background"]) {
        if (input[k] !== null && input[k] !== undefined) patch[k] = input[k];
      }
      if (patch.birth_date && !ISO_DATE.test(String(patch.birth_date))) throw new ToolInputError("birth_date בפורמט YYYY-MM-DD");
      if (patch.sex && !["female", "male", "other"].includes(String(patch.sex))) throw new ToolInputError("sex: female | male | other");
      if (patch.height_cm !== undefined && !(Number(patch.height_cm) >= 100 && Number(patch.height_cm) <= 250)) throw new ToolInputError("height_cm בין 100 ל-250");
      for (const k of ["display_name", "activity_level", "injuries_notes", "training_background"]) {
        if (patch[k] !== undefined && typeof patch[k] !== "string") throw new ToolInputError(`${k} חייב להיות טקסט`);
      }
      if (input.dietary_notes) patch.dietary_prefs = { notes: input.dietary_notes };
      if (!Object.keys(patch).length) return { ok: true, changed: [] };
      // שינוי sex ממשתמשת עם מעקב מחזור פעיל: מכבים את המעקב, אחרת ה-constraint יחסום
      if (patch.sex && patch.sex !== "female") patch.cycle_tracking_enabled = false;
      const { error } = await db.from("profiles").update(patch).eq("id", userId);
      if (error) throw error;
      // לשם אין עמודה "ריקה" שאפשר לבדוק (ברירת המחדל היא תחילית המייל), ולכן מסמנים שנענה
      if (patch.display_name) await db.rpc("mark_intake", { p_user_id: userId, p_field: "name", p_status: "answered" });
      return { ok: true, changed: Object.keys(patch) };
    }

    case "set_goal": {
      const { data, error } = await db.from("goals").insert({
        user_id: userId, kind: input.kind, title: input.title, target_value: input.target_value,
        unit: input.unit, target_date: input.target_date,
      }).select("id").single();
      if (error) throw error;
      return { ok: true, goal_id: data.id };
    }

    case "update_goal_status": {
      const { data, error } = await db.from("goals").update({ status: input.status })
        .eq("user_id", userId).eq("id", String(input.goal_id)).select("id");
      if (error) throw error;
      return { ok: (data ?? []).length > 0 };
    }

    case "set_cycle_tracking": {
      const { data: p } = await db.from("profiles").select("sex").eq("id", userId).single();
      if (input.enabled && p?.sex !== "female") {
        throw new ToolInputError("מעקב מחזור זמין רק כשבפרופיל sex = female. צריך קודם לעדכן את הפרופיל (update_profile).");
      }
      const { error } = await db.from("profiles").update({ cycle_tracking_enabled: Boolean(input.enabled) }).eq("id", userId);
      if (error) throw error;
      return {
        ok: true,
        enabled: Boolean(input.enabled),
        next_step: input.enabled
          ? "כדי שנתוני מחזור יגיעו, צריך להוסיף ב-Health Auto Export אוטומציה עם Data Type: Cycle Tracking (ראו מדריך ההגדרה)."
          : null,
      };
    }

    case "intake_update": {
      const field = String(input.field);
      const status = String(input.status);
      if (!INTAKE_KEYS.includes(field)) throw new ToolInputError("field לא מוכר");
      if (!["asked", "declined", "none"].includes(status)) throw new ToolInputError("status לא תקין");
      const { error } = await db.rpc("mark_intake", { p_user_id: userId, p_field: field, p_status: status });
      if (error) throw error;
      return { ok: true };
    }

    case "log_measurement": {
      const value = Number(input.value);
      if (!Number.isFinite(value)) throw new ToolInputError("value חייב להיות מספר");
      const day = input.date ? String(input.date) : null;
      if (day && !ISO_DATE.test(day)) throw new ToolInputError("date בפורמט YYYY-MM-DD");
      // מדידה מיום קודם נרשמת בצהריים המקומיים של אותו יום, כדי שתיפול על היום הנכון בסיכום
      const at = day ? new Date(Date.parse(localDayBounds(day, timezone)) + 12 * 3600_000).toISOString() : new Date().toISOString();
      const { error } = await db.rpc("log_manual_measurement", { p_user_id: userId, p_metric: input.metric, p_value: value, p_at: at });
      if (error) {
        if (/out of range|unsupported/.test(error.message ?? "")) throw new ToolInputError("הערך לא סביר למדד הזה. כדאי לוודא עם המשתמש");
        throw error;
      }
      return { ok: true };
    }

    case "add_medication": {
      const name = String(input.name ?? "").trim();
      if (!name) throw new ToolInputError("name ריק");
      if (!["medication", "supplement"].includes(String(input.kind))) throw new ToolInputError("kind: medication | supplement");
      if (input.dose != null && !Number.isFinite(Number(input.dose))) throw new ToolInputError("dose חייב להיות מספר");
      if (input.started_on && !ISO_DATE.test(String(input.started_on))) throw new ToolInputError("started_on בפורמט YYYY-MM-DD");
      const { data, error } = await db.from("medications").insert({
        user_id: userId, kind: input.kind, name, dose: input.dose ?? null, dose_unit: input.dose_unit ?? null,
        frequency: input.frequency ?? null, timing: input.timing ?? null, reason: input.reason ?? null, started_on: input.started_on ?? null,
      }).select("id").single();
      if (error) throw error;
      return { ok: true, medication_id: data.id };
    }

    case "stop_medication": {
      const stopped = input.stopped_on ? String(input.stopped_on) : localDate(new Date().toISOString(), timezone);
      if (!ISO_DATE.test(stopped)) throw new ToolInputError("stopped_on בפורמט YYYY-MM-DD");
      const { data, error } = await db.from("medications").update({ stopped_on: stopped })
        .eq("user_id", userId).eq("id", String(input.medication_id)).select("id");
      if (error) throw error;
      return { ok: (data ?? []).length > 0 };
    }

    case "add_health_condition": {
      const name = String(input.name ?? "").trim();
      if (!name) throw new ToolInputError("name ריק");
      if (input.diagnosed_on && !ISO_DATE.test(String(input.diagnosed_on))) throw new ToolInputError("diagnosed_on בפורמט YYYY-MM-DD");
      const { data, error } = await db.from("health_conditions").insert({
        user_id: userId, name, status: input.status, diagnosed_on: input.diagnosed_on, notes: input.notes,
      }).select("id").single();
      if (error) throw error;
      return { ok: true, condition_id: data.id };
    }

    case "update_health_condition": {
      const patch: Record<string, unknown> = { status: input.status };
      if (input.notes) patch.notes = input.notes;
      const { data, error } = await db.from("health_conditions").update(patch)
        .eq("user_id", userId).eq("id", String(input.condition_id)).select("id");
      if (error) throw error;
      return { ok: (data ?? []).length > 0 };
    }

    case "log_event": {
      const kind = String(input.kind ?? "").trim().toLowerCase();
      if (!/^[a-z][a-z0-9_]{1,40}$/.test(kind)) throw new ToolInputError("kind חייב להיות slug באנגלית (migraine, headache...)");
      const started = input.started_at ? localDateTime(String(input.started_at), timezone) : new Date().toISOString();
      const ended = input.ended_at ? localDateTime(String(input.ended_at), timezone) : null;
      if (ended && ended < started) throw new ToolInputError("ended_at לפני started_at");
      const severity = input.severity === null || input.severity === undefined ? null : Number(input.severity);
      if (severity !== null && !(severity >= 1 && severity <= 10)) throw new ToolInputError("severity בין 1 ל-10");
      const raw = input.details ?? {};
      if (typeof raw !== "object" || Array.isArray(raw)) throw new ToolInputError("details חייב להיות אובייקט");
      const details = Object.fromEntries(Object.entries(raw as Input)
        .filter(([k, v]) => ["triggers", "medication_taken", "aura", "location", "symptoms"].includes(k) && v !== null && v !== undefined));
      const { data, error } = await db.from("health_events").insert({
        user_id: userId, kind, label_he: input.label_he ?? null, started_at: started, ended_at: ended,
        severity, details, notes: input.notes ?? null, source_message_id: ctx.messageId ?? null,
      }).select("id").single();
      if (error) throw error;
      return { ok: true, event_id: data.id };
    }

    case "update_event": {
      const patch: Record<string, unknown> = {};
      if (input.ended_at) patch.ended_at = localDateTime(String(input.ended_at), timezone);
      if (input.severity !== null && input.severity !== undefined) {
        const sv = Number(input.severity);
        if (!(sv >= 1 && sv <= 10)) throw new ToolInputError("severity בין 1 ל-10");
        patch.severity = sv;
      }
      if (input.notes) patch.notes = input.notes;
      if (!Object.keys(patch).length) return { ok: true, changed: [] };
      const { data, error } = await db.from("health_events").update(patch)
        .eq("user_id", userId).eq("id", String(input.event_id)).select("id");
      if (error) {
        if (error.code === "23514") throw new ToolInputError("ended_at לפני תחילת האירוע");
        throw error;
      }
      return { ok: (data ?? []).length > 0, changed: Object.keys(patch) };
    }

    case "get_events": {
      const { from, to } = dateRange(input, 366);
      let q = db.from("health_events")
        .select("id, kind, label_he, started_at, ended_at, severity, details, notes")
        .eq("user_id", userId)
        .gte("started_at", localDayBounds(from, timezone))
        .lt("started_at", localDayBounds(to, timezone, true))
        .order("started_at").limit(300);
      if (input.kind) q = q.eq("kind", String(input.kind).toLowerCase());
      const [{ data: events, error }, { data: days, error: e2 }] = await Promise.all([
        q,
        db.from("daily_summaries")
          .select("day, steps, active_kcal, workouts_count, workout_min, resting_hr, hrv_avg, sleep_min, recovery_score, cycle")
          .eq("user_id", userId).gte("day", addDaysIso(from, -1)).lte("day", to),
      ]);
      if (error) throw error;
      if (e2) throw e2;
      return summarizeEvents(events ?? [], days ?? [], timezone);
    }

    case "log_meal": {
      const items = parseItems(input.items);
      const eatenAt = input.eaten_at ? localDateTime(String(input.eaten_at), timezone) : new Date().toISOString();
      if (Date.parse(eatenAt) > Date.now() + 3600_000) throw new ToolInputError("eaten_at בעתיד");
      const confidence = Math.min(1, Math.max(0, Number(input.confidence ?? 0.5)));
      const totals = sumItems(items);
      const plan = await loadActivePlan(db, userId);

      const { data: meal, error } = await db.from("meals").insert({
        user_id: userId, eaten_at: eatenAt, meal_type: mealType(input.meal_type),
        input_kind: ctx.inputKind ?? "text", media_path: ctx.mediaPath ?? null, source_message_id: ctx.messageId ?? null,
        status: "estimated", confidence, plan_id: plan?.id ?? null,
        total_kcal: totals.kcal, protein_g: totals.protein_g, carbs_g: totals.carbs_g, fat_g: totals.fat_g, fiber_g: totals.fiber_g,
      }).select("id").single();
      if (error) throw error;
      const { error: e2 } = await db.from("meal_items").insert(items.map((i) => ({ ...i, meal_id: meal.id, user_id: userId })));
      if (e2) {
        await db.from("meals").delete().eq("id", meal.id); // בלי פריטים אין ארוחה
        throw e2;
      }
      const feedback = await feedbackFor(db, userId, timezone, eatenAt, totals, plan);
      await db.from("meals").update({ plan_feedback: feedback }).eq("id", meal.id);
      return { ok: true, meal_id: meal.id, meal_totals: totals, ...feedback };
    }

    case "update_meal": {
      const id = String(input.meal_id ?? "");
      const { data: meal, error } = await db.from("meals").select("id, eaten_at, plan_id").eq("user_id", userId).eq("id", id).maybeSingle();
      if (error) throw error;
      if (!meal) throw new ToolInputError("ארוחה לא נמצאה");

      if (input.action === "delete") {
        const { error: e } = await db.from("meals").delete().eq("user_id", userId).eq("id", id);
        if (e) throw e;
        return { ok: true, deleted: true };
      }
      const patch: Record<string, unknown> = {};
      if (input.meal_type) patch.meal_type = mealType(input.meal_type);
      if (input.eaten_at) patch.eaten_at = localDateTime(String(input.eaten_at), timezone);
      if (input.action === "confirm") {
        patch.status = "confirmed";
        const { error: e } = await db.from("meals").update(patch).eq("user_id", userId).eq("id", id);
        if (e) throw e;
        return { ok: true, status: "confirmed" };
      }
      if (input.action !== "replace_items") throw new ToolInputError("action: confirm | replace_items | delete");
      const items = parseItems(input.items);
      const totals = sumItems(items);
      const { error: e1 } = await db.from("meal_items").delete().eq("user_id", userId).eq("meal_id", id);
      if (e1) throw e1;
      const { error: e2 } = await db.from("meal_items").insert(items.map((i) => ({ ...i, meal_id: id, user_id: userId })));
      if (e2) throw e2;
      const plan = await loadActivePlan(db, userId);
      const eatenAt = String(patch.eaten_at ?? meal.eaten_at);
      Object.assign(patch, {
        status: "corrected", total_kcal: totals.kcal, protein_g: totals.protein_g, carbs_g: totals.carbs_g,
        fat_g: totals.fat_g, fiber_g: totals.fiber_g, plan_id: plan?.id ?? meal.plan_id,
      });
      const { error: e3 } = await db.from("meals").update(patch).eq("user_id", userId).eq("id", id);
      if (e3) throw e3;
      const feedback = await feedbackFor(db, userId, timezone, eatenAt, totals, plan);
      await db.from("meals").update({ plan_feedback: feedback }).eq("id", id);
      return { ok: true, meal_id: id, meal_totals: totals, ...feedback };
    }

    case "get_meals": {
      const { from, to } = dateRange(input, 92);
      const detailed = (Date.parse(to) - Date.parse(from)) / 86_400_000 < 14;
      const [{ data: meals, error }, plan] = await Promise.all([
        db.from("meals")
          .select(`id, eaten_at, meal_type, status, total_kcal, protein_g, carbs_g, fat_g, fiber_g, plan_feedback${detailed ? ", meal_items(name_he, quantity, unit, kcal, protein_g, carbs_g)" : ""}`)
          .eq("user_id", userId)
          .gte("eaten_at", localDayBounds(from, timezone)).lt("eaten_at", localDayBounds(to, timezone, true))
          .order("eaten_at").limit(500),
        loadActivePlan(db, userId),
      ]);
      if (error) throw error;
      const rows = (meals ?? []) as unknown as Array<Record<string, unknown>>;
      const daily = new Map<string, Totals & { meals: number }>();
      for (const m of rows) {
        const day = localDate(String(m.eaten_at), timezone);
        const t = daily.get(day) ?? { ...ZERO, meals: 0 };
        daily.set(day, { ...addTotals(t, { kcal: num(m.total_kcal), protein_g: num(m.protein_g), carbs_g: num(m.carbs_g), fat_g: num(m.fat_g), fiber_g: num(m.fiber_g) }), meals: t.meals + 1 });
      }
      return {
        plan: plan ? { plan_id: plan.id, ...planTargets(plan) } : null,
        note: "יום בלי ארוחות רשומות = לא תועד, לא בהכרח לא אכל",
        daily: [...daily.entries()].map(([day, t]) => ({ day, ...t, kcal: r0(t.kcal), protein_g: r0(t.protein_g), carbs_g: r0(t.carbs_g), fat_g: r0(t.fat_g), fiber_g: r0(t.fiber_g) })),
        ...(detailed ? {
          meals: rows.map((m) => ({
            meal_id: m.id, at: new Date(String(m.eaten_at)).toLocaleString("he-IL", { timeZone: timezone, dateStyle: "short", timeStyle: "short" }),
            type: m.meal_type, status: m.status, kcal: r0(m.total_kcal), protein_g: r0(m.protein_g), carbs_g: r0(m.carbs_g), fat_g: r0(m.fat_g),
            items: m.meal_items, flags: (m.plan_feedback as { flags?: string[] } | null)?.flags ?? [],
          })),
        } : {}),
      };
    }

    case "propose_nutrition_plan": {
      const types = Array.isArray(input.plan_types) ? input.plan_types.map(String) : [];
      const allowedTypes = ["calorie_deficit", "high_protein", "glycemic_control", "maintenance", "muscle_gain", "anti_inflammatory", "custom"];
      if (!types.length || types.some((t) => !allowedTypes.includes(t))) throw new ToolInputError(`plan_types מתוך: ${allowedTypes.join(", ")}`);
      const int = (v: unknown, lo: number, hi: number, name: string) => {
        if (v === null || v === undefined) return null;
        const n = Math.round(Number(v));
        if (!Number.isFinite(n) || n < lo || n > hi) throw new ToolInputError(`${name} בין ${lo} ל-${hi}`);
        return n;
      };
      const r = (input.rules ?? {}) as Input;
      const plan: PlanTargets = {
        plan_types: types,
        kcal_target: int(input.kcal_target, 800, 6000, "kcal_target"),
        protein_g: int(input.protein_g, 20, 400, "protein_g"),
        carbs_g: int(input.carbs_g, 0, 800, "carbs_g"),
        fat_g: int(input.fat_g, 10, 300, "fat_g"),
        fiber_g: int(input.fiber_g, 0, 100, "fiber_g"),
        rules: Object.fromEntries(Object.entries({
          carbs_per_meal_max_g: int(r.carbs_per_meal_max_g, 10, 200, "carbs_per_meal_max_g"),
          protein_per_meal_min_g: int(r.protein_per_meal_min_g, 5, 100, "protein_per_meal_min_g"),
          notes: r.notes ? String(r.notes) : null,
        }).filter(([, v]) => v !== null)),
      };
      const energy = await energyFor(db, userId);
      const warnings = planWarnings(plan, energy.sex, energy.tdee, energy.weight_kg);
      if (warnings.some((w) => w.startsWith("kcal_below_floor"))) {
        throw new ToolInputError(`התוכנית מתחת לרצפת הקלוריות הבטוחה (${warnings.join(", ")}). צריך יעד גבוה יותר.`);
      }
      const { data, error } = await db.from("nutrition_plans").insert({
        user_id: userId, ...plan, rationale: String(input.rationale ?? ""), status: "proposed", created_by: "agent",
      }).select("id").single();
      if (error) throw error;
      if (ctx.effects) ctx.effects.proposedPlanId = data.id;
      return {
        ok: true, plan_id: data.id, status: "proposed",
        energy_estimate: { bmr: energy.bmr, tdee: energy.tdee, missing_for_estimate: energy.missing, avg_active_kcal_14d: energy.active_kcal_used },
        warnings,
        next_step: "הצג למשתמש את עיקרי התוכנית במשפטים ספורים. כפתור האישור יישלח אוטומטית אחרי התשובה שלך.",
      };
    }

    case "plan_session": {
      const date = String(input.date ?? "");
      if (!ISO_DATE.test(date) || Number.isNaN(Date.parse(date))) throw new ToolInputError("date בפורמט YYYY-MM-DD");
      if (date < localDate(new Date().toISOString(), timezone)) throw new ToolInputError("אי אפשר לתכנן אימון לתאריך שעבר");
      const start = input.start ? hhmmOrThrow(input.start, "start") : null;
      const duration = input.duration_min == null ? null : Math.round(Number(input.duration_min));
      if (duration !== null && !(duration >= 5 && duration <= 600)) throw new ToolInputError("duration_min בין 5 ל-600");
      const activity = String(input.activity_type ?? "").trim().toLowerCase();
      const title = String(input.title ?? "").trim();
      if (!activity || !title) throw new ToolInputError("activity_type ו-title חובה");
      const { data, error } = await db.from("planned_sessions").insert({
        user_id: userId, planned_date: date, planned_start: start, duration_min: duration, activity_type: activity, title,
        details: input.details ? { notes: String(input.details) } : {}, created_by: "agent",
      }).select("id").single();
      if (error) throw error;
      return { ok: true, session_id: data.id, reminders: start ? "תדריך לפני האימון + מעקב אחריו" : "מעקב בערב אם לא נרשם אימון" };
    }

    case "update_planned_session": {
      const id = String(input.session_id ?? "");
      const patch: Record<string, unknown> = {};
      if (input.status) {
        if (!["planned", "done", "skipped"].includes(String(input.status))) throw new ToolInputError("status: planned | done | skipped");
        patch.status = input.status;
      }
      if (input.date) {
        if (!ISO_DATE.test(String(input.date))) throw new ToolInputError("date בפורמט YYYY-MM-DD");
        patch.planned_date = input.date;
        if (!input.status) patch.status = "planned"; // הזזה מחזירה למצב מתוכנן, ותזכורות יישלחו לפי המועד החדש
      }
      if (input.start) patch.planned_start = hhmmOrThrow(input.start, "start");
      if (input.duration_min != null) patch.duration_min = Math.round(Number(input.duration_min));
      if (input.title) patch.title = String(input.title);
      if (input.reason) patch.change_reason = String(input.reason);
      if (!Object.keys(patch).length) return { ok: true, changed: [] };
      const { data, error } = await db.from("planned_sessions").update(patch).eq("user_id", userId).eq("id", id).select("id");
      if (error) throw error;
      // מועד חדש = תזכורות חדשות: מוחקים את סימוני "נשלח" של האימון הזה
      if ((data ?? []).length && (patch.planned_date || patch.planned_start)) {
        await db.from("outbound_notifications").delete().eq("user_id", userId).eq("ref_key", id);
      }
      return { ok: (data ?? []).length > 0, changed: Object.keys(patch) };
    }

    case "set_reminder_prefs": {
      const { data: p, error } = await db.from("profiles").select("notification_prefs").eq("id", userId).single();
      if (error) throw error;
      const prefs = (p.notification_prefs ?? {}) as Record<string, unknown>;
      const r = { ...((prefs.reminders ?? {}) as Record<string, unknown>) };
      const checks = { ...((r.meal_checks ?? {}) as Record<string, unknown>) };
      if (typeof input.meals === "boolean") r.meals = input.meals;
      if (typeof input.workouts === "boolean") r.workouts = input.workouts;
      for (const slot of ["breakfast", "lunch", "dinner"]) {
        const v = input[slot];
        if (v === null || v === undefined) continue;
        checks[slot] = v === "off" ? null : hhmmOrThrow(v, slot);
      }
      if (Object.keys(checks).length) r.meal_checks = checks;
      if (input.quiet_start) r.quiet_start = hhmmOrThrow(input.quiet_start, "quiet_start");
      if (input.quiet_end) r.quiet_end = hhmmOrThrow(input.quiet_end, "quiet_end");
      if (input.pre_workout_lead_min != null) {
        const lead = Math.round(Number(input.pre_workout_lead_min));
        if (!(lead >= 10 && lead <= 600)) throw new ToolInputError("pre_workout_lead_min בין 10 ל-600");
        r.pre_workout_lead_min = lead;
      }
      const { error: e2 } = await db.from("profiles").update({ notification_prefs: { ...prefs, reminders: r } }).eq("id", userId);
      if (e2) throw e2;
      return { ok: true, reminders: mergePrefs(r) };
    }

    case "onboarding_update": {
      const status = String(input.status);
      if (!["in_progress", "snoozed", "declined", "done"].includes(status)) throw new ToolInputError("status לא תקין");
      const { error } = await db.from("profiles").update({ onboarding_status: status, onboarding_updated_at: new Date().toISOString() }).eq("id", userId);
      if (error) throw error;
      return { ok: true, status };
    }

    default:
      throw new ToolInputError(`כלי לא מוכר: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// עזרים לתזונה
// ---------------------------------------------------------------------------

const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack", "pre_workout", "post_workout"];
const mealType = (v: unknown) => (v && MEAL_TYPES.includes(String(v)) ? String(v) : null);
const num = (v: unknown) => (v === null || v === undefined || Number.isNaN(Number(v)) ? 0 : Number(v));

function parseItems(raw: unknown): MealItem[] {
  if (!Array.isArray(raw) || !raw.length) throw new ToolInputError("items: צריך לפחות פריט אחד");
  if (raw.length > 30) throw new ToolInputError("items: עד 30 פריטים לארוחה");
  return raw.map((x) => {
    const i = (x ?? {}) as Record<string, unknown>;
    const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
    const item: MealItem = {
      name_he: String(i.name_he ?? "").trim(), quantity: n(i.quantity), unit: i.unit ? String(i.unit) : null,
      kcal: n(i.kcal), protein_g: n(i.protein_g), carbs_g: n(i.carbs_g), fat_g: n(i.fat_g), fiber_g: n(i.fiber_g),
      glycemic_load_est: n(i.glycemic_load_est),
    };
    const err = validateItem(item);
    if (err) throw new ToolInputError(err);
    return item;
  });
}

type PlanRow = { id: string } & PlanTargets;

async function loadActivePlan(db: SupabaseClient, userId: string): Promise<PlanRow | null> {
  const { data, error } = await db.from("nutrition_plans")
    .select("id, plan_types, kcal_target, protein_g, carbs_g, fat_g, fiber_g, rules")
    .eq("user_id", userId).eq("status", "active").maybeSingle();
  if (error) throw error;
  return data as PlanRow | null;
}

function planTargets(p: PlanTargets) {
  return { plan_types: p.plan_types, kcal: p.kcal_target, protein_g: p.protein_g, carbs_g: p.carbs_g, fat_g: p.fat_g, fiber_g: p.fiber_g, rules: p.rules };
}

/** סכום כל הארוחות ביום המקומי של eatenAt (כולל הארוחה הנוכחית, שכבר נשמרה) */
async function feedbackFor(db: SupabaseClient, userId: string, tz: string, eatenAt: string, meal: Totals, plan: PlanTargets | null) {
  const day = localDate(eatenAt, tz);
  const { data, error } = await db.from("meals").select("total_kcal, protein_g, carbs_g, fat_g, fiber_g")
    .eq("user_id", userId).gte("eaten_at", localDayBounds(day, tz)).lt("eaten_at", localDayBounds(day, tz, true));
  if (error) throw error;
  const dayTotals = (data ?? []).reduce((t: Totals, m) => addTotals(t, { kcal: num(m.total_kcal), protein_g: num(m.protein_g), carbs_g: num(m.carbs_g), fat_g: num(m.fat_g), fiber_g: num(m.fiber_g) }), { ...ZERO });
  return { day, meals_today: (data ?? []).length, ...mealFeedback(meal, dayTotals, plan) };
}

async function energyFor(db: SupabaseClient, userId: string) {
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
  const [{ data: p }, { data: w }, { data: days }] = await Promise.all([
    db.from("profiles").select("sex, birth_date, height_cm").eq("id", userId).single(),
    db.from("health_samples").select("value").eq("user_id", userId).eq("metric", "body_mass")
      .gte("start_at", new Date(Date.now() - 60 * 86_400_000).toISOString()).order("start_at", { ascending: false }).limit(1),
    db.from("daily_summaries").select("active_kcal").eq("user_id", userId).gte("day", since).not("active_kcal", "is", null),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const active = (days ?? []).map((d) => Number(d.active_kcal));
  const weight = w?.[0] ? Number(w[0].value) : null;
  const est = energyEstimate({
    sex: p?.sex ?? null, age: ageFrom(p?.birth_date ?? null, today), height_cm: p?.height_cm ? Number(p.height_cm) : null,
    weight_kg: weight, avg_active_kcal: active.length >= 5 ? active.reduce((a, b) => a + b, 0) / active.length : null,
  });
  return { ...est, sex: p?.sex ?? null, weight_kg: weight };
}

/** "7:05" / "07:05" / "07:05:00" → "07:05" */
function hhmmOrThrow(v: unknown, name: string): string {
  const m = String(v).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m || +m[1] > 23 || +m[2] > 59) throw new ToolInputError(`${name} בפורמט HH:MM`);
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

/** "YYYY-MM-DD HH:MM" בשעון המקומי → ISO ב-UTC */
export function localDateTime(v: string, timeZone: string): string {
  const m = v.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
  if (!m || Number.isNaN(Date.parse(m[1]))) throw new ToolInputError("זמן בפורמט YYYY-MM-DD HH:MM");
  const [, day, h, min] = m;
  if (+h > 23 || +min > 59) throw new ToolInputError("שעה לא תקינה");
  // offset בשעה עצמה (ולא בחצות), כדי שגם ביום של מעבר שעון התוצאה תהיה נכונה
  const naive = Date.parse(`${day}T${h}:${min}:00Z`);
  const utc = naive - tzOffsetMs(naive - tzOffsetMs(naive, timeZone), timeZone);
  return new Date(utc).toISOString();
}

function addDaysIso(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

type EventRow = { id: string; kind: string; label_he: string | null; started_at: string; ended_at: string | null; severity: number | null; details: unknown; notes: string | null };
type DayRow = Record<string, unknown> & { day: string };

/** מצמיד לכל אירוע את נתוני היום שלו ושל היום שלפניו, ומחשב סיכום קצר */
export function summarizeEvents(events: EventRow[], days: DayRow[], timeZone: string) {
  const byDay = new Map(days.map((d) => [String(d.day), d]));
  const fmt = (iso: string) => new Date(iso).toLocaleString("he-IL", { timeZone, dateStyle: "short", timeStyle: "short" });
  const avg = (v: number[]) => (v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null);

  const sleepBefore: number[] = [];
  const list = events.map((e) => {
    const day = localDate(e.started_at, timeZone);
    const today = byDay.get(day);
    const prev = byDay.get(addDaysIso(day, -1));
    if (today?.sleep_min != null) sleepBefore.push(Number(today.sleep_min));
    return {
      event_id: e.id, kind: e.kind, label: e.label_he, start: fmt(e.started_at),
      hours: e.ended_at ? r1((Date.parse(e.ended_at) - Date.parse(e.started_at)) / 3600_000) : null,
      severity: e.severity, details: e.details, notes: e.notes,
      // sleep_min של יום X = הלילה שהסתיים בבוקר X, כלומר הלילה שלפני האירוע
      snapshot: {
        sleep_before_min: r0(today?.sleep_min), hrv: r1(today?.hrv_avg), resting_hr: r0(today?.resting_hr),
        recovery: r0(today?.recovery_score),
        ...(today?.cycle ? { cycle: today.cycle } : {}),
        prev_day: prev ? { steps: r0(prev.steps), active_kcal: r0(prev.active_kcal), workouts: prev.workouts_count, workout_min: r0(prev.workout_min) } : null,
      },
    };
  });

  const allSleep = days.map((d) => d.sleep_min).filter((v) => v != null).map(Number);
  const sev = events.map((e) => e.severity).filter((v): v is number => v != null);
  return {
    count: events.length,
    by_kind: Object.fromEntries([...new Set(events.map((e) => e.kind))].map((k) => [k, events.filter((e) => e.kind === k).length])),
    avg_severity: sev.length ? r1(sev.reduce((a, b) => a + b, 0) / sev.length) : null,
    avg_sleep_before_event_min: avg(sleepBefore),
    nights_measured_before_events: sleepBefore.length,
    avg_sleep_all_nights_min: avg(allSleep),
    events: list,
  };
}

/** תחילת השבוע (יום ראשון, כמקובל בישראל) של תאריך */
export function isoWeekStart(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}
