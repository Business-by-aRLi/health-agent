// =====================================================================
// חישובי תזונה: סכומים, השוואה לתוכנית, והערכת הוצאה אנרגטית.
// 🧠 המודל מעריך כל פריט (גרמים, קלוריות, מאקרו). כל הסכומים וההשוואות נעשים כאן,
//    בקוד, ולא במודל: אותו קלט תמיד נותן אותה תוצאה, ואפשר לבדוק את זה בטסטים.
// =====================================================================

export interface MealItem {
  name_he: string;
  quantity: number | null;
  unit: string | null;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  glycemic_load_est: number | null;
}

export interface Totals { kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number; glycemic_load: number }

export interface PlanTargets {
  plan_types: string[];
  kcal_target: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  rules: { carbs_per_meal_max_g?: number | null; protein_per_meal_min_g?: number | null; [k: string]: unknown };
}

const round = (n: number) => Math.round(n);
const num = (v: unknown) => (v === null || v === undefined || Number.isNaN(Number(v)) ? 0 : Number(v));

export function sumItems(items: Array<Partial<MealItem>>): Totals {
  const t = { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, glycemic_load: 0 };
  for (const i of items) {
    t.kcal += num(i.kcal);
    t.protein_g += num(i.protein_g);
    t.carbs_g += num(i.carbs_g);
    t.fat_g += num(i.fat_g);
    t.fiber_g += num(i.fiber_g);
    t.glycemic_load += num(i.glycemic_load_est);
  }
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, round(v)])) as unknown as Totals;
}

export function addTotals(a: Totals, b: Partial<Totals>): Totals {
  return {
    kcal: a.kcal + num(b.kcal), protein_g: a.protein_g + num(b.protein_g), carbs_g: a.carbs_g + num(b.carbs_g),
    fat_g: a.fat_g + num(b.fat_g), fiber_g: a.fiber_g + num(b.fiber_g), glycemic_load: a.glycemic_load + num(b.glycemic_load),
  };
}

export const ZERO: Totals = { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, glycemic_load: 0 };

/** בדיקות תקינות על פריט שהמודל העריך. מחזיר הודעת שגיאה או null */
export function validateItem(i: Partial<MealItem>): string | null {
  if (!i.name_he || typeof i.name_he !== "string") return "לכל פריט צריך name_he";
  const limits: Array<[keyof MealItem, number]> = [["kcal", 3000], ["protein_g", 250], ["carbs_g", 400], ["fat_g", 250], ["fiber_g", 80], ["glycemic_load_est", 150]];
  for (const [k, max] of limits) {
    const v = i[k];
    if (v === null || v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max) return `${String(k)} של "${i.name_he}" לא סביר (${v})`;
  }
  return null;
}

// 🧠 עומס גליקמי של ארוחה: עד 10 נמוך, 11–19 בינוני, 20 ומעלה גבוה. סף מקובל בספרות.
const HIGH_MEAL_GL = 20;

/**
 * משוב של ארוחה מול התוכנית: מה נשאר להיום, ואילו כללים הארוחה לא עמדה בהם.
 * מחזיר קודים ומספרים, והמודל מנסח אותם בעברית.
 */
export function mealFeedback(meal: Totals, dayAfter: Totals, plan: PlanTargets | null) {
  if (!plan) return { has_plan: false, day_totals: dayAfter, flags: [] as string[] };
  const remaining: Record<string, number> = {};
  if (plan.kcal_target) remaining.kcal = plan.kcal_target - dayAfter.kcal;
  if (plan.protein_g) remaining.protein_g = plan.protein_g - dayAfter.protein_g;
  if (plan.carbs_g) remaining.carbs_g = plan.carbs_g - dayAfter.carbs_g;
  if (plan.fat_g) remaining.fat_g = plan.fat_g - dayAfter.fat_g;
  if (plan.fiber_g) remaining.fiber_g = plan.fiber_g - dayAfter.fiber_g;

  const flags: string[] = [];
  const r = plan.rules ?? {};
  if (r.carbs_per_meal_max_g && meal.carbs_g > Number(r.carbs_per_meal_max_g)) flags.push(`carbs_per_meal_over:${meal.carbs_g}>${r.carbs_per_meal_max_g}`);
  if (r.protein_per_meal_min_g && meal.protein_g < Number(r.protein_per_meal_min_g)) flags.push(`protein_per_meal_under:${meal.protein_g}<${r.protein_per_meal_min_g}`);
  if (plan.plan_types.includes("glycemic_control") && meal.glycemic_load >= HIGH_MEAL_GL) flags.push(`high_glycemic_load:${meal.glycemic_load}`);
  if (plan.plan_types.includes("glycemic_control") && meal.carbs_g >= 30 && meal.protein_g < 10 && meal.fiber_g < 5) flags.push("carbs_without_protein_or_fiber");
  if (plan.kcal_target && dayAfter.kcal > plan.kcal_target) flags.push(`day_kcal_over:${dayAfter.kcal - plan.kcal_target}`);

  return { has_plan: true, day_totals: dayAfter, remaining, flags };
}

/**
 * הערכת הוצאה אנרגטית יומית: BMR לפי Mifflin-St Jeor, כפול 1.2 (בסיס יומיומי),
 * ועוד הקלוריות הפעילות הממוצעות מהשעון. זו הערכה, לא מדידה, והיא מוצגת ככזו.
 */
export function energyEstimate(p: { sex: string | null; age: number | null; height_cm: number | null; weight_kg: number | null; avg_active_kcal: number | null }) {
  const missing = (["sex", "age", "height_cm", "weight_kg"] as const).filter((k) => p[k] === null || p[k] === undefined);
  if (p.sex !== null && p.sex !== "female" && p.sex !== "male" && !missing.includes("sex")) missing.push("sex");
  if (missing.length) return { bmr: null, tdee: null, missing };
  const base = 10 * p.weight_kg! + 6.25 * p.height_cm! - 5 * p.age!;
  const bmr = round(p.sex === "female" ? base - 161 : base + 5);
  const tdee = round(bmr * 1.2 + (p.avg_active_kcal ?? 0));
  return { bmr, tdee, missing, active_kcal_used: p.avg_active_kcal === null ? null : round(p.avg_active_kcal) };
}

export const KCAL_FLOOR = (sex: string | null) => (sex === "female" ? 1200 : 1500);

/** אזהרות על הצעת תוכנית, לפני שהיא מוצגת למשתמש */
export function planWarnings(plan: PlanTargets, sex: string | null, tdee: number | null, weight_kg: number | null): string[] {
  const w: string[] = [];
  if (plan.kcal_target !== null && plan.kcal_target < KCAL_FLOOR(sex)) w.push(`kcal_below_floor:${KCAL_FLOOR(sex)}`);
  if (plan.kcal_target !== null && tdee) {
    const deficit = (tdee - plan.kcal_target) / tdee;
    if (deficit > 0.25) w.push(`deficit_over_25pct:${Math.round(deficit * 100)}`);
  }
  if (plan.protein_g !== null && weight_kg) {
    const perKg = plan.protein_g / weight_kg;
    if (perKg > 2.5) w.push(`protein_over_2.5g_per_kg:${perKg.toFixed(1)}`);
  }
  if (plan.kcal_target !== null && plan.protein_g !== null && plan.carbs_g !== null && plan.fat_g !== null) {
    const fromMacros = plan.protein_g * 4 + plan.carbs_g * 4 + plan.fat_g * 9;
    if (Math.abs(fromMacros - plan.kcal_target) / plan.kcal_target > 0.1) w.push(`macros_dont_match_kcal:${fromMacros}`);
  }
  return w;
}
