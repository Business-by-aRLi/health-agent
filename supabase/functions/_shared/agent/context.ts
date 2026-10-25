// =====================================================================
// בניית <context> לכל הודעה: תמונת מצב קומפקטית שהסוכן רואה בלי לקרוא לכלים.
// 🧠 זה נכנס להודעת המשתמש (לא ל-system), כי הוא משתנה בכל פעם. ה-system נשאר
//    קבוע ונשמר ב-cache.
// =====================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { ageFrom, localDate } from "../time.ts";
export { ageFrom };
import { intakeContextLines, loadIntake } from "./intake.ts";
import { localDayBounds } from "./tools.ts";

const HE_DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

export interface UserProfile {
  id: string;
  display_name: string | null;
  timezone: string;
  sex: string | null;
  birth_date: string | null;
  height_cm: number | null;
  activity_level: string | null;
  injuries_notes: string | null;
  training_background: string | null;
  dietary_prefs: Record<string, unknown>;
  focus_areas: string[];
  cycle_tracking_enabled: boolean;
}

export async function loadProfile(db: SupabaseClient, userId: string): Promise<UserProfile> {
  const { data, error } = await db.from("profiles")
    .select("id, display_name, timezone, sex, birth_date, height_cm, activity_level, injuries_notes, training_background, dietary_prefs, focus_areas, cycle_tracking_enabled")
    .eq("id", userId).single();
  if (error) throw error;
  return data as UserProfile;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}


export async function buildContext(db: SupabaseClient, p: UserProfile, now = new Date()): Promise<string> {
  const tz = p.timezone;
  const today = localDate(now.toISOString(), tz);
  const weekAgo = addDays(today, -6);
  const time = now.toLocaleTimeString("he-IL", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
  const dow = HE_DAYS[new Date(`${today}T12:00:00Z`).getUTCDay()];

  const [summaries, goals, memory, workouts, sources, plan, meds, conditions, intake, events, meals, proposed] = await Promise.all([
    db.from("daily_summaries")
      .select("day, steps, active_kcal, exercise_min, workouts_count, resting_hr, hrv_avg, sleep_min, sleep_efficiency, weight_kg, recovery_score, cycle, baselines")
      .eq("user_id", p.id).gte("day", weekAgo).lte("day", today).order("day"),
    db.from("goals").select("id, kind, title, target_value, unit, target_date").eq("user_id", p.id).eq("status", "active"),
    db.from("coach_memory").select("id, category, content").eq("user_id", p.id).eq("active", true).order("id").limit(60),
    db.from("workouts").select("activity_type, start_at, duration_s, distance_m, avg_hr")
      .eq("user_id", p.id).order("start_at", { ascending: false }).limit(5),
    db.from("data_sources").select("provider, last_synced_at").eq("user_id", p.id).eq("status", "active"),
    db.from("nutrition_plans").select("id, plan_types, kcal_target, protein_g, carbs_g, fat_g, fiber_g, rules, approved_at").eq("user_id", p.id).eq("status", "active").maybeSingle(),
    db.from("medications").select("id, kind, name, dose, dose_unit, frequency, timing, reason").eq("user_id", p.id).is("stopped_on", null),
    db.from("health_conditions").select("id, name, status, diagnosed_on, notes").eq("user_id", p.id).order("status"),
    loadIntake(db, p.id, now),
    db.from("health_events").select("id, kind, label_he, started_at, ended_at, severity")
      .eq("user_id", p.id).gte("started_at", new Date(now.getTime() - 14 * 86_400_000).toISOString())
      .order("started_at", { ascending: false }).limit(15),
    db.from("meals").select("id, eaten_at, meal_type, status, total_kcal, protein_g, carbs_g, fat_g, fiber_g")
      .eq("user_id", p.id).gte("eaten_at", localDayBounds(today, tz)).lt("eaten_at", localDayBounds(today, tz, true)).order("eaten_at"),
    db.from("nutrition_plans").select("id, plan_types, kcal_target, protein_g, created_at")
      .eq("user_id", p.id).eq("status", "proposed").gte("created_at", new Date(now.getTime() - 7 * 86_400_000).toISOString())
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);

  const rows = summaries.data ?? [];
  const latest = rows.at(-1);
  const r = (n: unknown) => (n === null || n === undefined ? "-" : String(Math.round(Number(n))));
  const hm = (min: unknown) => (min === null || min === undefined ? "-" : `${Math.floor(Number(min) / 60)}:${String(Math.round(Number(min) % 60)).padStart(2, "0")}`);

  const lines: string[] = [];
  lines.push(`<context>`);
  lines.push(`עכשיו: יום ${dow}, ${today}, ${time} (${tz})`);

  const age = ageFrom(p.birth_date, today);
  lines.push(`פרופיל: ${[
    p.display_name && `שם: ${p.display_name}`,
    `sex: ${p.sex ?? "לא ידוע"}`,
    age !== null && `גיל: ${age}`,
    p.height_cm && `גובה: ${p.height_cm} ס"מ`,
    p.activity_level && `רמת פעילות: ${p.activity_level}`,
    p.injuries_notes && `מגבלות/פציעות: ${p.injuries_notes}`,
    p.training_background && `רקע אימוני: ${p.training_background}`,
    Object.keys(p.dietary_prefs ?? {}).length && `תזונה: ${JSON.stringify(p.dietary_prefs)}`,
    `פוקוס: ${p.focus_areas.join(", ")}`,
    `מעקב מחזור: ${p.cycle_tracking_enabled ? "מופעל" : "כבוי"}`,
  ].filter(Boolean).join(" | ")}`);

  const g = goals.data ?? [];
  lines.push(`מטרות פעילות: ${g.length ? g.map((x) => `[goal_id=${x.id}] ${x.title}${x.target_value ? ` (${x.target_value}${x.unit ?? ""}${x.target_date ? ` עד ${x.target_date}` : ""})` : ""}`).join("; ") : "אין עדיין"}`);

  const m = memory.data ?? [];
  lines.push(`זיכרון: ${m.length ? m.map((x) => `[memory_id=${x.id}|${x.category}] ${x.content}`).join(" ; ") : "ריק"}`);

  if (plan.data) {
    const { id, approved_at: _a, ...targets } = plan.data;
    lines.push(`תוכנית תזונה פעילה [plan_id=${id}]: ${JSON.stringify(targets)}`);
  } else {
    lines.push(`תוכנית תזונה פעילה: אין`);
  }
  if (proposed.data) {
    lines.push(`הצעת תוכנית שממתינה לאישור בכפתור [plan_id=${proposed.data.id}]: ${proposed.data.plan_types.join(", ")}${proposed.data.kcal_target ? `, ${proposed.data.kcal_target} קק"ל` : ""}${proposed.data.protein_g ? `, ${proposed.data.protein_g} ג' חלבון` : ""}`);
  }
  const ml = meals.data ?? [];
  const sum = (k: "total_kcal" | "protein_g" | "carbs_g" | "fat_g" | "fiber_g") => Math.round(ml.reduce((a, x) => a + Number(x[k] ?? 0), 0));
  lines.push(ml.length
    ? `תזונה היום (${ml.length} ארוחות רשומות): ${sum("total_kcal")} קק"ל, חלבון ${sum("protein_g")} ג', פחמימות ${sum("carbs_g")} ג', שומן ${sum("fat_g")} ג', סיבים ${sum("fiber_g")} ג'. ארוחות: ${ml.map((x) => `[meal_id=${x.id}] ${new Date(x.eaten_at).toLocaleTimeString("he-IL", { timeZone: tz, hour: "2-digit", minute: "2-digit" })} ${x.meal_type ?? ""} ${Math.round(Number(x.total_kcal ?? 0))} קק"ל${x.status === "estimated" ? " (הערכה)" : ""}`).join("; ")}`
    : `תזונה היום: לא נרשמו ארוחות`);
  if (meds.data?.length) lines.push(`תרופות ותוספים פעילים: ${meds.data.map((x) => `[medication_id=${x.id}|${x.kind}] ${x.name}${x.dose ? ` ${x.dose}${x.dose_unit ?? ""}` : ""}${[x.frequency, x.timing, x.reason && `סיבה: ${x.reason}`].filter(Boolean).map((t) => ` (${t})`).join("")}`).join("; ")}`);
  if (conditions.data?.length) lines.push(`רקע רפואי: ${conditions.data.map((x) => `[condition_id=${x.id}] ${x.name} (${x.status === "resolved" ? "עבר" : x.status === "suspected" ? "חשד" : "פעיל"}${x.diagnosed_on ? `, מ-${x.diagnosed_on}` : ""})${x.notes ? `: ${x.notes}` : ""}`).join("; ")}`);
  lines.push(...intakeContextLines(intake));

  const ev = events.data ?? [];
  if (ev.length) {
    lines.push(`יומן בריאות, 14 ימים אחרונים: ${ev.map((x) => `[event_id=${x.id}] ${new Date(x.started_at).toLocaleString("he-IL", { timeZone: tz, dateStyle: "short", timeStyle: "short" })} ${x.label_he ?? x.kind} (${x.kind})${x.severity ? ` עוצמה ${x.severity}` : ""}${x.ended_at ? "" : " (בלי שעת סיום)"}`).join("; ")}`);
  }

  lines.push(`7 ימים אחרונים (יום | צעדים | קק"ל פעילות | דק' אימון | אימונים | דופק מנוחה | HRV | שינה | יעילות | משקל | התאוששות${p.cycle_tracking_enabled ? " | מחזור" : ""}):`);
  for (const d of rows) {
    const cycle = p.cycle_tracking_enabled && d.cycle
      ? ` | יום ${(d.cycle as Record<string, unknown>).cycle_day ?? "-"} ${(d.cycle as Record<string, unknown>).phase_est ?? ""}`
      : "";
    lines.push(`${d.day} | ${r(d.steps)} | ${r(d.active_kcal)} | ${r(d.exercise_min)} | ${d.workouts_count} | ${r(d.resting_hr)} | ${d.hrv_avg === null ? "-" : Number(d.hrv_avg).toFixed(1)} | ${hm(d.sleep_min)} | ${d.sleep_efficiency ?? "-"} | ${d.weight_kg ?? "-"} | ${r(d.recovery_score)}${cycle}`);
  }
  if (!rows.length) lines.push("(אין נתונים בשבוע האחרון)");

  const b = latest?.baselines as Record<string, { mean: number | null; sd: number | null; n: number }> | undefined;
  if (b && b.days) {
    lines.push(`בסיס אישי (28 יום): ${["resting_hr", "hrv_avg", "sleep_min", "steps"].map((k) => `${k}=${b[k]?.mean ?? "-"}±${b[k]?.sd ?? "-"} (n=${b[k]?.n ?? 0})`).join(", ")}`);
  }

  const w = workouts.data ?? [];
  lines.push(`אימונים אחרונים: ${w.length ? w.map((x) => `${new Date(x.start_at).toLocaleDateString("he-IL", { timeZone: tz })} ${x.activity_type} ${Math.round(Number(x.duration_s) / 60)}ד'${x.distance_m ? ` ${(Number(x.distance_m) / 1000).toFixed(1)}ק"מ` : ""}${x.avg_hr ? ` דופק ${Math.round(Number(x.avg_hr))}` : ""}`).join("; ") : "אין"}`);

  const last = (sources.data ?? []).map((s) => s.last_synced_at).filter(Boolean).sort().at(-1);
  lines.push(`סנכרון אחרון מהשעון: ${last ? new Date(last).toLocaleString("he-IL", { timeZone: tz }) : "אף פעם"}`);
  lines.push(`</context>`);
  return lines.join("\n");
}
