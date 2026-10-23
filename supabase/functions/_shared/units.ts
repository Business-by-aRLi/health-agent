// =====================================================================
// המרת יחידות למקום אחד.
// HealthKit מחזיר יחידות לפי הגדרות הטלפון (ק"מ/מייל, kcal/kJ, kg/lb).
// אנחנו שומרים תמיד ביחידה קנונית אחת לכל סוג, כדי שסכום ומגמה יהיו נכונים.
// =====================================================================

import type { CanonicalUnit } from "./adapters/types.ts";

export interface Normalized {
  value: number;
  unit: CanonicalUnit;
}

// מקדם המרה: value_canonical = value * factor  (טמפרטורה מטופלת בנפרד)
const CONVERSIONS: Record<string, { unit: CanonicalUnit; factor: number }> = {
  // ספירה וקצב
  "count": { unit: "count", factor: 1 },
  "count/min": { unit: "count/min", factor: 1 },   // "bpm" רק לדופק, ראו rateUnit
  "bpm": { unit: "bpm", factor: 1 },
  "beats/min": { unit: "bpm", factor: 1 },
  // זמן
  "ms": { unit: "ms", factor: 1 },
  "s": { unit: "s", factor: 1 },
  "sec": { unit: "s", factor: 1 },
  "min": { unit: "min", factor: 1 },
  "hr": { unit: "min", factor: 60 },
  "h": { unit: "min", factor: 60 },
  // אנרגיה. "Cal" עם C גדולה בתזונה = kcal
  "kcal": { unit: "kcal", factor: 1 },
  "cal": { unit: "kcal", factor: 1 },
  "kj": { unit: "kcal", factor: 1 / 4.184 },
  // מסה
  "kg": { unit: "kg", factor: 1 },
  "g": { unit: "kg", factor: 0.001 },
  "lb": { unit: "kg", factor: 0.45359237 },
  "lbs": { unit: "kg", factor: 0.45359237 },
  "st": { unit: "kg", factor: 6.35029318 },
  // מרחק
  "m": { unit: "m", factor: 1 },
  "km": { unit: "m", factor: 1000 },
  "cm": { unit: "m", factor: 0.01 },
  "mi": { unit: "m", factor: 1609.344 },
  "ft": { unit: "m", factor: 0.3048 },
  "yd": { unit: "m", factor: 0.9144 },
  // מהירות
  "m/s": { unit: "m/s", factor: 1 },
  "km/hr": { unit: "m/s", factor: 1 / 3.6 },
  "km/h": { unit: "m/s", factor: 1 / 3.6 },
  "mi/hr": { unit: "m/s", factor: 0.44704 },
  "mph": { unit: "m/s", factor: 0.44704 },
  "m/hr": { unit: "m/s", factor: 1 / 3600 },
  "m/h": { unit: "m/s", factor: 1 / 3600 },
  // קצב (pace): תמיד שניות לק"מ
  "s/km": { unit: "s/km", factor: 1 },
  "s/mi": { unit: "s/km", factor: 1 / 1.609344 },
  // שונות
  "%": { unit: "%", factor: 1 },
  "mmhg": { unit: "mmHg", factor: 1 },
  "w": { unit: "W", factor: 1 },
  "watts": { unit: "W", factor: 1 },
  "ml/(kg·min)": { unit: "mL/(kg·min)", factor: 1 },
  "ml/(kg*min)": { unit: "mL/(kg·min)", factor: 1 },
  "ml/kg/min": { unit: "mL/(kg·min)", factor: 1 },
};

/** ממיר ערך ויחידה ליחידה הקנונית. יחידה לא מוכרת נשארת כמו שהיא. */
export function normalize(value: number, unit: string | undefined | null): Normalized {
  const u = (unit ?? "").trim();
  const key = u.toLowerCase();

  if (key === "degc" || key === "°c") return { value, unit: "degC" };
  if (key === "degf" || key === "°f") return { value: (value - 32) * 5 / 9, unit: "degC" };

  const conv = CONVERSIONS[key];
  if (!conv) return { value, unit: u || "unknown" };
  return { value: round(value * conv.factor), unit: conv.unit };
}

/**
 * HealthKit מחזיר count/min גם לדופק, גם לקצב צעדים וגם לנשימות.
 * "bpm" (פעימות לדקה) נכון רק למדדי לב, ולכן מתייגים לפי שם המדד.
 */
export function rateUnit(metric: string, n: Normalized): Normalized {
  if (n.unit === "count/min" && /heart|pulse|(^|_)hr($|_)/i.test(metric)) return { ...n, unit: "bpm" };
  return n;
}

/**
 * באג שנצפה ב-payload אמיתי: HAE שולח avgSpeed/maxSpeed עם units "km" (במקום "km/hr").
 * שדה מהירות עם יחידת מרחק בלבד = לשעה.
 */
export function speedUnitFix(key: string, unit: string | undefined): string | undefined {
  if (unit && /speed/i.test(key) && /^(km|mi|m)$/i.test(unit.trim())) return `${unit.trim()}/hr`;
  return unit;
}

/** מעגל ל-6 ספרות כדי לא לשמור רעש של floating point (0.30000000000000004) */
export function round(n: number, digits = 6): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
