// =====================================================================
// זמנים: הכול נשמר כ-ISO עם offset. "יום" מחושב לפי ה-timezone של המשתמש.
// =====================================================================

// HAE שולח "2026-10-22 07:15:00 +0300". הפורמט הזה לא תקני ל-Date.parse בכל
// הסביבות, ולכן ממירים אותו ל-ISO: "2026-10-22T07:15:00+03:00".
const HAE_DATE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}:?\d{2})?$/;

/** מחזיר ISO string עם offset מקורי, או null אם לא ניתן לפרש */
export function parseHaeDate(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    // epoch: שניות או מילישניות
    return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  }
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  const m = s.match(HAE_DATE);
  if (m) {
    const [, d, t, tz] = m;
    const time = t.length === 5 ? `${t}:00` : t;
    let offset = tz ?? "Z";
    if (/^[+-]\d{4}$/.test(offset)) offset = `${offset.slice(0, 3)}:${offset.slice(3)}`;
    const iso = `${d}T${time}${offset}`;
    return Number.isNaN(Date.parse(iso)) ? null : iso;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** התאריך המקומי (YYYY-MM-DD) של רגע מסוים, ב-timezone נתון */
export function localDate(iso: string, timeZone: string): string {
  // en-CA מחזיר בדיוק YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}
