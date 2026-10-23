// =====================================================================
// בניית <context> לכל הודעה: תמונת מצב קומפקטית שהסוכן רואה בלי לקרוא לכלים.
// 🧠 זה נכנס להודעת המשתמש (לא ל-system), כי הוא משתנה בכל פעם. ה-system נשאר
//    קבוע ונשמר ב-cache.
// =====================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { localDate } from "../time.ts";

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
  dietary_prefs: Record<string, unknown>;
  focus_areas: string[];
  cycle_tracking_enabled: boolean;
}

export async function loadProfile(db: SupabaseClient, userId: string): Promise<UserProfile> {
  const { data, error } = await db.from("profiles")
    .select("id, display_name, timezone, sex, birth_date, height_cm, activity_level, injuries_notes, dietary_prefs, focus_areas, cycle_tracking_enabled")
    .eq("id", userId).single();
  if (error) throw error;
  return data as UserProfile;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function ageFrom(birth: string | null, today: string): number | null {
  if (!birth) return null;
  const [by, bm, bd] = birth.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

export async function buildContext(db: SupabaseClient, p: UserProfile, now = new Date()): Promise<string> {
  const tz = p.timezone;
  const today = localDate(now.toISOString(), tz);
  const weekAgo = addDays(today, -6);
  const time = now.toLocaleTimeString("he-IL", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
  const dow = HE_DAYS[new Date(`${today}T12:00:00Z`).getUTCDay()];

  const [summaries, goals, memory, workouts, sources, plan, meds, conditions] = await Promise.all([
    db.from("daily_summaries")
      .select("day, steps, active_kcal, exercise_min, workouts_count, resting_hr, hrv_avg, sleep_min, sleep_efficiency, weight_kg, recovery_score, cycle, baselines")
      .eq("user_id", p.id).gte("day", weekAgo).lte("day", today).order("day"),
    db.from("goals").select("id, kind, title, target_value, unit, target_date").eq("user_id", p.id).eq("status", "active"),
    db.from("coach_memory").select("id, category, content").eq("user_id", p.id).eq("active", true).order("id").limit(60),
    db.from("workouts").select("activity_type, start_at, duration_s, distance_m, avg_hr")
      .eq("user_id", p.id).order("start_at", { ascending: false }).limit(5),
    db.from("data_sources").select("provider, last_synced_at").eq("user_id", p.id).eq("status", "active"),
    db.from("nutrition_plans").select("plan_types, kcal_target, protein_g, carbs_g, fat_g, rules").eq("user_id", p.id).eq("status", "active").maybeSingle(),
    db.from("medications").select("kind, name, dose, dose_unit, timing").eq("user_id", p.id).is("stopped_on", null),
    db.from("health_conditions").select("name, status").eq("user_id", p.id).neq("status", "resolved"),
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
    Object.keys(p.dietary_prefs ?? {}).length && `תזונה: ${JSON.stringify(p.dietary_prefs)}`,
    `פוקוס: ${p.focus_areas.join(", ")}`,
    `מעקב מחזור: ${p.cycle_tracking_enabled ? "מופעל" : "כבוי"}`,
  ].filter(Boolean).join(" | ")}`);

  const g = goals.data ?? [];
  lines.push(`מטרות פעילות: ${g.length ? g.map((x) => `[goal_id=${x.id}] ${x.title}${x.target_value ? ` (${x.target_value}${x.unit ?? ""}${x.target_date ? ` עד ${x.target_date}` : ""})` : ""}`).join("; ") : "אין עדיין"}`);

  const m = memory.data ?? [];
  lines.push(`זיכרון: ${m.length ? m.map((x) => `[memory_id=${x.id}|${x.category}] ${x.content}`).join(" ; ") : "ריק"}`);

  if (plan.data) lines.push(`תוכנית תזונה פעילה: ${JSON.stringify(plan.data)}`);
  if (meds.data?.length) lines.push(`תרופות ותוספים פעילים: ${meds.data.map((x) => `${x.name}${x.dose ? ` ${x.dose}${x.dose_unit ?? ""}` : ""}${x.timing ? ` (${x.timing})` : ""}`).join("; ")}`);
  if (conditions.data?.length) lines.push(`מצבים רפואיים: ${conditions.data.map((x) => `${x.name} (${x.status})`).join("; ")}`);

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
