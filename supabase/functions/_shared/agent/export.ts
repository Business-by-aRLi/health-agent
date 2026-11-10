// =====================================================================
// ייצוא השיחה לקובץ Markdown קריא (פקודת /export), למשל כדי לבדוק אותה במקום אחר.
// 🧠 פונקציה טהורה: מקבלת שורות מ-messages ומחזירה טקסט. בלי מטא-דאטה טכני (טוקנים,
//    מזהים), רק מה שעוזר להבין את השיחה: זמן, מי כתב, סוג ההודעה ואילו פעולות נרשמו.
// =====================================================================

export interface ExportRow {
  role: string;                       // user / assistant / marker
  content: string;
  created_at: string;
  input_kind?: string | null;         // text / voice / photo ...
  meta?: Record<string, unknown> | null;
}

const KIND_HE: Record<string, string> = { voice: "הודעה קולית, תומללה", photo: "תמונה" };

export function formatTranscript(rows: ExportRow[], tz: string, name: string | null, now = new Date()): string {
  const fmt = new Intl.DateTimeFormat("he-IL", {
    timeZone: tz, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const when = (iso: string) => fmt.format(new Date(iso)).replace(",", "");
  const out = [
    `# שיחה עם המאמן${name ? `: ${name}` : ""}`,
    "",
    `יוצא ב-${when(now.toISOString())}. ${rows.filter((r) => r.role !== "marker").length} הודעות.`,
    "\"פעולות\" הן מה שהמאמן רשם במערכת באותה תשובה (ארוחה, מדד, זיכרון וכו'). \"יזומה\" היא הודעה שהמאמן שלח בלי שנשאל.",
    "",
  ];
  for (const r of rows) {
    if (r.role === "marker") {
      out.push("---", "*(התחלה של שיחה חדשה)*", "");
      continue;
    }
    const tags: string[] = [];
    if (r.role === "user" && r.input_kind && KIND_HE[r.input_kind]) tags.push(KIND_HE[r.input_kind]);
    const proactive = r.meta?.proactive;
    if (r.role === "assistant" && proactive) tags.push(`יזומה: ${proactive}`);
    const who = r.role === "user" ? "משתמש/ת" : "המאמן";
    out.push(`**[${when(r.created_at)}] ${who}**${tags.length ? ` *(${tags.join(", ")})*` : ""}`);
    out.push(r.content.trim() || "*(ריק)*");
    const tools = (r.meta?.tools ?? []) as Array<{ name: string; ok: boolean }>;
    if (r.role === "assistant" && tools.length) {
      out.push(`*פעולות: ${tools.map((t) => (t.ok ? t.name : `${t.name} (נכשל)`)).join(", ")}*`);
    }
    out.push("");
  }
  return out.join("\n");
}
