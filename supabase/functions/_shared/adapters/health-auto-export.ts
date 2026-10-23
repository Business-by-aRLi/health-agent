// =====================================================================
// מתאם: Health Auto Export (iOS) → CanonicalBatch
//
// הפורמט של HAE (REST API automation, JSON):
//   { data: { metrics: [{ name, units, data: [...] }], workouts: [{...}] } }
//
// עקרון מנחה: **לא מאבדים מידע.** מה שמזהים ממפים לעמודות. מה שלא מזהים
// נשמר כמדד גנרי (health_samples) או בתוך workouts.metrics/raw, ומקבל warning.
// ה-payload הגולמי נשמר בכל מקרה ב-ingest_events, כך שאפשר להריץ מחדש
// אחרי תיקון של המתאם.
//
// ⚠️ את המבנה צריך לאמת מול payload אמיתי מהטלפון שלך (שלב 1, בדיקה ראשונה).
//    המתאם כתוב באופן הגנתי: שדות חסרים לא מפילים אותו.
// =====================================================================

import { normalize, round } from "../units.ts";
import { localDate, parseHaeDate } from "../time.ts";
import type {
  AdapterContext,
  AdapterResult,
  CanonicalRoutePoint,
  CanonicalSample,
  CanonicalSleep,
  CanonicalWorkout,
  CanonicalWorkoutSample,
} from "./types.ts";

// שם המדד ב-HAE → השם הקנוני שלנו. מה שלא מופיע כאן נשמר בשם המקורי.
export const METRIC_MAP: Record<string, string> = {
  step_count: "steps",
  heart_rate: "heart_rate",
  resting_heart_rate: "resting_heart_rate",
  heart_rate_variability: "hrv_sdnn",
  walking_heart_rate_average: "walking_heart_rate",
  active_energy: "active_energy",
  basal_energy_burned: "basal_energy",
  apple_exercise_time: "exercise_minutes",
  apple_stand_time: "stand_minutes",
  apple_stand_hour: "stand_hours",
  walking_running_distance: "walking_running_distance",
  cycling_distance: "cycling_distance",
  swimming_distance: "swimming_distance",
  flights_climbed: "flights_climbed",
  weight_body_mass: "body_mass",
  body_mass_index: "bmi",
  body_fat_percentage: "body_fat_pct",
  lean_body_mass: "lean_body_mass",
  vo2_max: "vo2max",
  respiratory_rate: "respiratory_rate",
  blood_oxygen_saturation: "spo2",
  walking_speed: "walking_speed",
  walking_step_length: "walking_step_length",
  physical_effort: "physical_effort",
  time_in_daylight: "daylight_minutes",
  apple_sleeping_wrist_temperature: "wrist_temperature_sleep",
  cardio_recovery: "cardio_recovery",
};

// מדדי Cycle Tracking. נקלטים רק כש-ctx.cycleTracking (ראו ARCHITECTURE 4.4ג)
export const CYCLE_METRICS = new Set([
  "menstrual_flow", "intermenstrual_bleeding", "cervical_mucus_quality", "ovulation_test_result",
  "basal_body_temperature", "sexual_activity", "contraceptives", "pregnancy_test_result",
  "progesterone_test_result", "pregnancy", "lactation",
]);

// ערכים קטגוריאליים → מספר, כדי שאפשר יהיה לחשב (max, ספירה). הטקסט נשמר ב-meta.category.
// מה שלא מופיע כאן מקבל 1 ("נרשם").
const CATEGORY_CODES: Record<string, Record<string, number>> = {
  menstrual_flow: { none: 0, unspecified: 1, light: 1, medium: 2, heavy: 3 },
  cervical_mucus_quality: { dry: 1, sticky: 2, creamy: 3, watery: 4, "egg white": 5 },
  ovulation_test_result: { negative: 0, positive: 2, "luteinizing hormone surge": 2, indeterminate: 1, "estrogen surge": 1 },
  pregnancy_test_result: { negative: 0, positive: 1, indeterminate: 0.5 },
  progesterone_test_result: { negative: 0, positive: 1, indeterminate: 0.5 },
};

// שדות ב-workout שממופים לעמודות. כל השאר הולך ל-metrics/raw.
const WORKOUT_CORE_KEYS = new Set([
  "id", "name", "start", "end", "duration", "location", "isIndoor",
  "activeEnergyBurned", "activeEnergy", "totalEnergy", "distance", "elevationUp",
  "heartRate", "avgHeartRate", "maxHeartRate", "minHeartRate", "route",
]);

// שלבי שינה כפי שמגיעים מ-HealthKit (באנגלית, גם בטלפון בעברית)
const SLEEP_STAGE_KEYS: Record<string, "in_bed" | "asleep" | "awake" | "core" | "deep" | "rem"> = {
  "in bed": "in_bed", "inbed": "in_bed",
  "asleep": "asleep", "unspecified": "asleep", "asleep unspecified": "asleep",
  "awake": "awake",
  "core": "core", "deep": "deep", "rem": "rem",
};

type Json = Record<string, unknown>;

export function adaptHealthAutoExport(payload: unknown, ctx: AdapterContext): AdapterResult {
  const warnings: string[] = [];
  const data = (payload as Json | null)?.data as Json | undefined;
  if (!data || typeof data !== "object") {
    throw new AdapterError("payload חסר את השדה data. האם זה JSON של Health Auto Export?");
  }

  const samples: CanonicalSample[] = [];
  const sleep: CanonicalSleep[] = [];
  const workouts: CanonicalWorkout[] = [];
  let skippedCycle = 0;

  for (const metric of asArray(data.metrics)) {
    const name = String(metric.name ?? "");
    const units = metric.units as string | undefined;
    const points = asArray(metric.data);
    if (!name) {
      warnings.push("metric ללא שם דולג");
      continue;
    }
    if (name === "sleep_analysis") {
      sleep.push(...adaptSleep(points, units, ctx, warnings));
      continue;
    }
    if (CYCLE_METRICS.has(name) && !ctx.cycleTracking) {
      skippedCycle += points.length;
      continue;
    }
    for (const p of points) {
      samples.push(...adaptMetricPoint(name, units, p, warnings));
    }
  }

  for (const w of asArray(data.workouts)) {
    const adapted = adaptWorkout(w, warnings);
    if (adapted) workouts.push(adapted);
  }

  if (skippedCycle) warnings.push(`מעקב מחזור כבוי: ${skippedCycle} נקודות מחזור לא נקלטו`);
  return { batch: { samples, workouts, sleep }, warnings: dedupeWarnings(warnings) };
}

export class AdapterError extends Error {}

// ---------------------------------------------------------------- metrics

function adaptMetricPoint(name: string, units: string | undefined, p: Json, warnings: string[]): CanonicalSample[] {
  const start = parseHaeDate(p.date ?? p.startDate);
  if (!start) {
    warnings.push(`${name}: נקודה בלי תאריך דולגה`);
    return [];
  }
  const end = parseHaeDate(p.endDate) ?? start;
  const metric = METRIC_MAP[name] ?? name;
  const meta: Json = {};
  if (p.source) meta.source = p.source;

  // 1) המקרה הנפוץ: { date, qty }
  if (isNum(p.qty)) {
    const n = normalize(p.qty, units);
    return [{ metric, start_at: start, end_at: end, value: n.value, unit: n.unit, meta }];
  }

  // 2) דופק ודומיו: { Min, Avg, Max }
  if (isNum(p.Avg) || isNum(p.avg)) {
    const avg = normalize((p.Avg ?? p.avg) as number, units);
    const min = numOrNull(p.Min ?? p.min);
    const max = numOrNull(p.Max ?? p.max);
    return [{
      metric, start_at: start, end_at: end,
      value: avg.value,
      value_min: min === null ? null : normalize(min, units).value,
      value_max: max === null ? null : normalize(max, units).value,
      unit: avg.unit, meta,
    }];
  }

  // 3) קטגוריאלי: { date, value: "Medium" }. מקודד למספר, והטקסט נשמר
  if (typeof p.value === "string" && p.value.trim()) {
    const category = p.value.trim();
    const code = CATEGORY_CODES[name]?.[category.toLowerCase()] ?? 1;
    return [{ metric, start_at: start, end_at: end, value: code, unit: "category", meta: { ...meta, category } }];
  }
  if (isNum(p.value)) {
    const n = normalize(p.value, units);
    return [{ metric, start_at: start, end_at: end, value: n.value, unit: n.unit, meta }];
  }

  // 4) גנרי: כל שדה מספרי הופך למדד נפרד. למשל לחץ דם:
  //    { systolic, diastolic } → blood_pressure_systolic, blood_pressure_diastolic
  const out: CanonicalSample[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (!isNum(v)) continue;
    const n = normalize(v, units);
    out.push({ metric: `${metric}_${snake(k)}`, start_at: start, end_at: end, value: n.value, unit: n.unit, meta });
  }
  if (out.length === 0) warnings.push(`${name}: נקודה בלי ערך מספרי דולגה`);
  return out;
}

// ------------------------------------------------------------------ sleep

function adaptSleep(points: Json[], units: string | undefined, ctx: AdapterContext, warnings: string[]): CanonicalSleep[] {
  const aggregated = points.filter((p) => "totalSleep" in p || "sleepStart" in p || "inBed" in p && !("value" in p));
  const segments = points.filter((p) => typeof p.value === "string" && (p.startDate || p.date));

  const out: CanonicalSleep[] = aggregated.map((p) => adaptAggregatedSleep(p, units, ctx)).filter(isDefined);
  if (segments.length) out.push(...adaptSleepSegments(segments, ctx, warnings));
  if (points.length && !out.length) warnings.push("sleep_analysis: לא זוהה פורמט שינה");
  return out;
}

/** פורמט "Aggregate sleep": שורה אחת ללילה, ערכים בשעות */
function adaptAggregatedSleep(p: Json, units: string | undefined, ctx: AdapterContext): CanonicalSleep | undefined {
  const toMin = (v: unknown) => (isNum(v) ? round(normalize(v, units ?? "hr").value, 2) : null);
  const asleepEnd = parseHaeDate(p.sleepEnd);
  const inBedEnd = parseHaeDate(p.inBedEnd);
  const wake = asleepEnd ?? inBedEnd;
  const sleepDate = wake ? nightOf(wake, ctx.timezone) : dateOnly(p.date);
  if (!sleepDate) return undefined;

  const core = toMin(p.core), deep = toMin(p.deep), rem = toMin(p.rem), unspecified = toMin(p.asleep);
  // השעון לבד לא מודד "זמן במיטה" ושולח inBed: 0 (נצפה ב-payload אמיתי).
  // במקרה כזה זמן במיטה = מתחילת השינה ועד הקימה, כדי ש-sleep_efficiency יהיה חישוב אמיתי ולא null.
  const bedStart = parseHaeDate(p.inBedStart) ?? parseHaeDate(p.sleepStart);
  const bedEnd = inBedEnd ?? asleepEnd;
  const reportedInBed = toMin(p.inBed);
  const inBedMin = reportedInBed && reportedInBed > 0
    ? reportedInBed
    : bedStart && bedEnd ? round((Date.parse(bedEnd) - Date.parse(bedStart)) / 60000, 2) : null;
  const total = toMin(p.totalSleep) ??
    sumOrNull([core, deep, rem, unspecified]);

  return {
    sleep_date: sleepDate,
    in_bed_start: parseHaeDate(p.inBedStart),
    in_bed_end: inBedEnd,
    asleep_start: parseHaeDate(p.sleepStart),
    asleep_end: asleepEnd,
    total_asleep_min: total,
    in_bed_min: inBedMin,
    core_min: core, deep_min: deep, rem_min: rem,
    awake_min: toMin(p.awake),
    stages: null,
    meta: p.source ? { source: p.source } : {},
  };
}

/** פורמט מפורט: מקטע לכל שלב שינה. מקבצים ללילות. */
function adaptSleepSegments(segments: Json[], ctx: AdapterContext, warnings: string[]): CanonicalSleep[] {
  const nights = new Map<string, Array<{ stage: string; start_at: string; end_at: string; min: number }>>();

  for (const s of segments) {
    const start = parseHaeDate(s.startDate ?? s.date);
    const end = parseHaeDate(s.endDate);
    const stage = SLEEP_STAGE_KEYS[String(s.value).toLowerCase().trim()];
    if (!start || !end || !stage) {
      warnings.push(`sleep_analysis: מקטע לא מזוהה (${String(s.value)}) דולג`);
      continue;
    }
    const night = nightOf(end, ctx.timezone);
    const min = (Date.parse(end) - Date.parse(start)) / 60000;
    if (!nights.has(night)) nights.set(night, []);
    nights.get(night)!.push({ stage, start_at: start, end_at: end, min });
  }

  return [...nights.entries()].map(([sleep_date, segs]) => {
    segs.sort((a, b) => a.start_at.localeCompare(b.start_at));
    const sum = (k: string) => round(segs.filter((x) => x.stage === k).reduce((a, x) => a + x.min, 0), 2);
    const sleepSegs = segs.filter((x) => ["asleep", "core", "deep", "rem"].includes(x.stage));
    const bedSegs = segs.filter((x) => x.stage === "in_bed");
    const asleepTotal = round(sleepSegs.reduce((a, x) => a + x.min, 0), 2);
    // אם אין מקטע "In Bed" (נפוץ כשרק השעון מודד), זמן במיטה = מההירדמות הראשונה עד הקימה
    const inBedMin = bedSegs.length
      ? sum("in_bed")
      : segs.length ? round((Date.parse(segs.at(-1)!.end_at) - Date.parse(segs[0].start_at)) / 60000, 2) : null;
    return {
      sleep_date,
      in_bed_start: bedSegs[0]?.start_at ?? segs[0]?.start_at ?? null,
      in_bed_end: bedSegs.at(-1)?.end_at ?? segs.at(-1)?.end_at ?? null,
      asleep_start: sleepSegs[0]?.start_at ?? null,
      asleep_end: sleepSegs.at(-1)?.end_at ?? null,
      total_asleep_min: asleepTotal || null,
      in_bed_min: inBedMin,
      core_min: sum("core"), deep_min: sum("deep"), rem_min: sum("rem"), awake_min: sum("awake"),
      stages: segs.map(({ stage, start_at, end_at }) => ({ stage, start_at, end_at })),
      meta: { format: "segments" },
    };
  });
}

/**
 * לאיזה לילה שייך רגע ההתעוררות? הכלל: מה שמסתיים לפני 12:00 שייך לאותו יום,
 * ומה שמסתיים אחרי 12:00 שייך ללילה של מחר. זה מטפל במקטעים שנגמרים ב-23:50.
 * (תנומת צהריים תשויך ללילה הבא. מקובל בשלב הזה.)
 */
function nightOf(wakeIso: string, tz: string): string {
  return localDate(new Date(Date.parse(wakeIso) + 12 * 3600 * 1000).toISOString(), tz);
}

// --------------------------------------------------------------- workouts

function adaptWorkout(w: Json, warnings: string[]): CanonicalWorkout | undefined {
  const start = parseHaeDate(w.start);
  const end = parseHaeDate(w.end);
  const name = String(w.name ?? "Workout");
  if (!start || !end) {
    warnings.push(`workout "${name}": בלי start/end, דולג`);
    return undefined;
  }
  // אם אין id (גרסאות ישנות), מייצרים מזהה יציב מהזמנים, כדי ששליחה חוזרת לא תשכפל
  const externalId = String(w.id ?? `${name}|${start}|${end}`);

  const qty = (v: unknown) => readQty(v);
  const hr = w.heartRate as Json | undefined;

  const workout: CanonicalWorkout = {
    external_id: externalId,
    activity_name: name,
    activity_type: snake(name),
    start_at: start,
    end_at: end,
    duration_s: isNum(w.duration) ? round(w.duration, 2) : round((Date.parse(end) - Date.parse(start)) / 1000, 2),
    active_kcal: qty(w.activeEnergyBurned)?.value ?? qtySum(w.activeEnergy),
    total_kcal: qty(w.totalEnergy)?.value ?? null,
    distance_m: qty(w.distance)?.value ?? null,
    elevation_up_m: qty(w.elevationUp)?.value ?? null,
    avg_hr: qty(hr?.avg)?.value ?? qty(w.avgHeartRate)?.value ?? null,
    max_hr: qty(hr?.max)?.value ?? qty(w.maxHeartRate)?.value ?? null,
    min_hr: qty(hr?.min)?.value ?? qty(w.minHeartRate)?.value ?? null,
    is_indoor: typeof w.isIndoor === "boolean" ? w.isIndoor : (w.location === "Indoor" ? true : w.location === "Outdoor" ? false : null),
    location: typeof w.location === "string" ? w.location : null,
    metrics: {},
    raw: {},
    samples: [],
    route: [],
  };

  for (const [key, value] of Object.entries(w)) {
    if (key === "route") {
      workout.route = adaptRoute(asArray(value));
      continue;
    }
    if (Array.isArray(value)) {
      // כל מערך של נקודות עם תאריך = סדרת זמן בתוך האימון
      const series = adaptWorkoutSeries(key, value as Json[]);
      if (series.length) workout.samples.push(...series);
      else if (value.length) warnings.push(`workout.${key}: מערך לא מזוהה (${value.length} פריטים), נשמר ב-raw`);
      if (!series.length) workout.raw[key] = value;
      continue;
    }
    workout.raw[key] = value;
    if (WORKOUT_CORE_KEYS.has(key)) continue;

    const q = readQty(value);
    if (q) workout.metrics[snake(key)] = q;
    else if (["string", "number", "boolean"].includes(typeof value)) workout.metrics[snake(key)] = value as string | number | boolean;
  }

  return workout;
}

function adaptWorkoutSeries(key: string, points: Json[]): CanonicalWorkoutSample[] {
  // heartRateData → heart_rate, heartRateRecovery → heart_rate_recovery, stepCount → step_count
  const metric = snake(key.replace(/Data$/, ""));
  const out: CanonicalWorkoutSample[] = [];
  for (const p of points) {
    if (!p || typeof p !== "object") continue;
    const at = parseHaeDate(p.date ?? p.timestamp ?? p.startDate);
    if (!at) continue;
    const units = (p.units ?? p.unit) as string | undefined;
    if (isNum(p.qty)) {
      const n = normalize(p.qty, units);
      out.push({ metric, at, value: n.value, unit: n.unit });
    } else if (isNum(p.Avg) || isNum(p.avg)) {
      const avg = normalize((p.Avg ?? p.avg) as number, units);
      const min = numOrNull(p.Min ?? p.min);
      const max = numOrNull(p.Max ?? p.max);
      out.push({
        metric, at, value: avg.value, unit: avg.unit,
        value_min: min === null ? null : normalize(min, units).value,
        value_max: max === null ? null : normalize(max, units).value,
      });
    }
  }
  return out;
}

function adaptRoute(points: Json[]): CanonicalRoutePoint[] {
  const out: CanonicalRoutePoint[] = [];
  for (const p of points) {
    const at = parseHaeDate(p.timestamp ?? p.date);
    const lat = numOrNull(p.latitude ?? p.lat);
    const lon = numOrNull(p.longitude ?? p.lon);
    if (!at || lat === null || lon === null) continue;
    out.push({
      at, lat, lon,
      altitude_m: numOrNull(p.altitude),
      speed_mps: numOrNull(p.speed),
      course_deg: numOrNull(p.course),
      h_accuracy_m: numOrNull(p.horizontalAccuracy),
      v_accuracy_m: numOrNull(p.verticalAccuracy),
    });
  }
  return out;
}

// ---------------------------------------------------------------- helpers

function readQty(v: unknown): { value: number; unit: string } | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Json;
  if (!isNum(o.qty)) return null;
  return normalize(o.qty, (o.units ?? o.unit) as string | undefined);
}

/** activeEnergy כמערך של נקודות: מסכמים */
function qtySum(v: unknown): number | null {
  if (!Array.isArray(v) || !v.length) return null;
  let total = 0;
  for (const p of v as Json[]) {
    if (isNum(p?.qty)) total += normalize(p.qty, (p.units ?? p.unit) as string | undefined).value;
  }
  return round(total, 3);
}

function asArray(v: unknown): Json[] {
  return Array.isArray(v) ? v.filter((x) => x && typeof x === "object") as Json[] : [];
}
function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function numOrNull(v: unknown): number | null {
  return isNum(v) ? v : null;
}
function isDefined<T>(v: T | undefined): v is T {
  return v !== undefined;
}
function sumOrNull(xs: Array<number | null>): number | null {
  const ns = xs.filter(isNum);
  return ns.length ? round(ns.reduce((a, b) => a + b, 0), 2) : null;
}
function dateOnly(v: unknown): string | null {
  const m = typeof v === "string" ? v.match(/^\d{4}-\d{2}-\d{2}/) : null;
  return m ? m[0] : null;
}
/** "Outdoor Run" → "outdoor_run", "heartRateData" → "heart_rate_data". תומך גם בעברית */
export function snake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
}
function dedupeWarnings(ws: string[]): string[] {
  const counts = new Map<string, number>();
  for (const w of ws) counts.set(w, (counts.get(w) ?? 0) + 1);
  return [...counts.entries()].map(([w, n]) => (n > 1 ? `${w} (×${n})` : w));
}
