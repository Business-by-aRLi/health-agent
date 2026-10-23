// =====================================================================
// הכנת היסטוריית השיחה למודל, מהשורות בטבלת messages.
// =====================================================================

export type Turn = { role: "user" | "assistant"; content: string };
type Row = { role: string; content: string };

/**
 * rows: מהחדש לישן (כמו שהשאילתה מחזירה). מחזיר מהישן לחדש, מוכן לשליחה:
 * - נחתך ב-marker האחרון (/new)
 * - רצפים של אותו תפקיד מאוחדים (ה-API דורש התחלפות user/assistant)
 * - מתחיל ב-user ומסתיים ב-assistant, כי ההודעה החדשה שתתווסף היא user
 */
export function prepareHistory(rowsNewestFirst: Row[]): Turn[] {
  const cut = rowsNewestFirst.findIndex((r) => r.role === "marker");
  const recent = (cut === -1 ? rowsNewestFirst : rowsNewestFirst.slice(0, cut))
    .slice().reverse()
    .filter((r): r is Turn => r.role === "user" || r.role === "assistant");
  const merged: Turn[] = [];
  for (const m of recent) {
    if (merged.length && merged.at(-1)!.role === m.role) merged.at(-1)!.content += `\n\n${m.content}`;
    else merged.push({ role: m.role, content: m.content });
  }
  while (merged.length && merged[0].role !== "user") merged.shift();
  while (merged.length && merged.at(-1)!.role !== "assistant") merged.pop();
  return merged;
}
