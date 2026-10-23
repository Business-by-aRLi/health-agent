// בדיקות לסוכן: הלולאה (עם לקוח מזויף), היסטוריה, וכלי עזר.  הרצה: deno task test
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type Anthropic from "@anthropic-ai/sdk";
import { type MessagesClient, runAgent } from "../../supabase/functions/_shared/agent/loop.ts";
import { prepareHistory } from "../../supabase/functions/_shared/agent/history.ts";
import { dateRange, downsample, isoWeekStart, localDayBounds, TOOLS, ToolInputError } from "../../supabase/functions/_shared/agent/tools.ts";
import { addDays, ageFrom } from "../../supabase/functions/_shared/agent/context.ts";
import { splitMessage } from "../../supabase/functions/_shared/telegram.ts";
import { SYSTEM_PROMPT } from "../../supabase/functions/_shared/agent/system-prompt.ts";

type Msg = Anthropic.Beta.Messages.BetaMessage;

/** לקוח מזויף: מחזיר תשובות מוכנות לפי הסדר, ושומר את הבקשות לבדיקה */
function fakeClient(responses: Array<Partial<Msg>>) {
  const requests: Array<Record<string, unknown>> = [];
  let i = 0;
  const client = {
    beta: {
      messages: {
        create: (params: Record<string, unknown>) => {
          // structuredClone: הלולאה ממשיכה לדחוף ל-messages, ואנחנו רוצים צילום של מה שנשלח באותו רגע
          requests.push(structuredClone(params));
          const r = responses[i++];
          return Promise.resolve({
            id: `msg_${i}`, type: "message", role: "assistant", model: "claude-opus-5-5",
            stop_reason: "end_turn", content: [],
            usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 },
            ...r,
          });
        },
      },
    },
  } as unknown as MessagesClient;
  return { client, requests };
}

const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const text = (t: string) => ({ type: "text", text: t });

Deno.test("loop: tool_use → הרצת כלים במקביל → תשובה", async () => {
  const { client, requests } = fakeClient([
    { stop_reason: "tool_use", content: [{ type: "thinking", thinking: "", signature: "sig" }, toolUse("t1", "get_sleep", { from: "2026-10-16", to: "2026-10-22" }), toolUse("t2", "get_daily_summaries", { from: "2026-10-16", to: "2026-10-22" })] as Msg["content"] },
    { stop_reason: "end_turn", content: [text("ישנת בממוצע 6:20 השבוע.")] as Msg["content"] },
  ]);
  const ran: string[] = [];
  const res = await runAgent({
    client, history: [{ role: "user", content: "היי" }, { role: "assistant", content: "שלום!" }],
    userText: "איך ישנתי?", context: "<context>x</context>",
    runTool: (name) => { ran.push(name); return Promise.resolve({ ok: true }); },
  });

  assertEquals(res.text, "ישנת בממוצע 6:20 השבוע.");
  assertEquals(ran.sort(), ["get_daily_summaries", "get_sleep"]);
  assertEquals(res.iterations, 2);
  assertEquals(res.usage, { input: 200, output: 40, cache_read: 100, cache_write: 0 });

  // בקשה ראשונה: היסטוריה + context בתוך הודעת המשתמש, system קבוע עם cache_control
  const first = requests[0];
  assertEquals(first.model, "claude-opus-5-5");
  assertEquals((first.messages as unknown[]).length, 3);
  assertEquals((first.messages as Array<{ content: string }>)[2].content, "<context>x</context>\n\nאיך ישנתי?");
  assertEquals((first.system as Array<{ text: string; cache_control: unknown }>)[0].text, SYSTEM_PROMPT);
  assertEquals(first.fallbacks, "default");
  assertEquals(first.output_config, { effort: "medium" });

  // בקשה שנייה: append-only. התור של המודל (כולל thinking) נשמר כמו שהוא, ושתי התוצאות בהודעה אחת
  const second = requests[1].messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  assertEquals(second.length, 5);
  assertEquals(second[3].content[0].type, "thinking");
  assertEquals(second[4].role, "user");
  assertEquals(second[4].content.map((c) => c.tool_use_id), ["t1", "t2"]);
});

Deno.test("loop: שגיאת קלט חוזרת למודל כ-is_error, שגיאה פנימית מוסתרת", async () => {
  const { client, requests } = fakeClient([
    { stop_reason: "tool_use", content: [toolUse("a", "get_sleep", {}), toolUse("b", "get_workouts", {})] as Msg["content"] },
    { stop_reason: "end_turn", content: [text("אין לי נתונים.")] as Msg["content"] },
  ]);
  const res = await runAgent({
    client, history: [], userText: "?", context: "",
    runTool: (name) => name === "get_sleep" ? Promise.reject(new ToolInputError("טווח לא תקין")) : Promise.reject(new Error("db down: secret details")),
  });
  const results = (requests[1].messages as Array<{ content: Array<{ content: string; is_error: boolean }> }>)[2].content;
  assertEquals(results[0], { type: "tool_result", tool_use_id: "a", content: "טווח לא תקין", is_error: true } as never);
  assert(!results[1].content.includes("secret"), "internal error details must not leak to the model");
  assertEquals(res.toolCalls.map((t) => t.ok), [false, false]);
});

Deno.test("loop: refusal → הודעה מנומסת, לא טקסט ריק", async () => {
  const { client } = fakeClient([{ stop_reason: "refusal", content: [] }]);
  const res = await runAgent({ client, history: [], userText: "?", context: "", runTool: () => Promise.resolve(null) });
  assert(res.text.includes("לא הצלחתי"));
  assertEquals(res.stopReason, "refusal");
});

Deno.test("loop: עצירה אחרי מספר צעדים מקסימלי", async () => {
  const loopForever = Array.from({ length: 12 }, (_, i) => ({ stop_reason: "tool_use", content: [toolUse(`t${i}`, "get_sleep", {})] as Msg["content"] }));
  const { client, requests } = fakeClient(loopForever as Array<Partial<Msg>>);
  const res = await runAgent({ client, history: [], userText: "?", context: "", runTool: () => Promise.resolve({}) });
  assertEquals(requests.length, 10);
  assert(res.text.length > 0);
});

Deno.test("history: חיתוך ב-/new, איחוד רצפים, מתחיל ב-user ומסתיים ב-assistant", () => {
  const newestFirst = [
    { role: "user", content: "שאלה בלי תשובה (נכשלה)" },
    { role: "assistant", content: "ת2" },
    { role: "user", content: "ש2" },
    { role: "user", content: "ש2-המשך" },
    { role: "assistant", content: "ת1" },
    { role: "user", content: "ש1" },
    { role: "marker", content: "new conversation" },
    { role: "user", content: "ישן, לפני /new" },
  ];
  assertEquals(prepareHistory(newestFirst), [
    { role: "user", content: "ש1" },
    { role: "assistant", content: "ת1" },
    { role: "user", content: "ש2-המשך\n\nש2" },
    { role: "assistant", content: "ת2" },
  ]);
  assertEquals(prepareHistory([{ role: "assistant", content: "x" }]), []);
  assertEquals(prepareHistory([]), []);
});

Deno.test("dateRange: תקין, הפוך, ארוך מדי, פורמט שגוי", () => {
  assertEquals(dateRange({ from: "2026-10-01", to: "2026-10-07" }, 30), { from: "2026-10-01", to: "2026-10-07" });
  assertThrows(() => dateRange({ from: "2026-10-07", to: "2026-10-01" }, 30), ToolInputError);
  assertThrows(() => dateRange({ from: "2026-01-01", to: "2026-12-31" }, 120), ToolInputError);
  assertThrows(() => dateRange({ from: "yesterday", to: "2026-10-01" }, 30), ToolInputError);
});

Deno.test("localDayBounds: חצות מקומי ב-UTC, כולל מעבר שעון חורף", () => {
  // שעון קיץ בישראל (UTC+3)
  assertEquals(localDayBounds("2026-10-22", "Asia/Jerusalem"), "2026-10-21T21:00:00.000Z");
  assertEquals(localDayBounds("2026-10-22", "Asia/Jerusalem", true), "2026-10-22T21:00:00.000Z");
  // שעון חורף (UTC+2)
  assertEquals(localDayBounds("2026-12-01", "Asia/Jerusalem"), "2026-11-30T22:00:00.000Z");
  assertEquals(localDayBounds("2026-10-22", "UTC"), "2026-10-22T00:00:00.000Z");
});

Deno.test("עזרים: שבוע מתחיל ביום ראשון, גיל, דילול, חלוקת הודעות", () => {
  assertEquals(isoWeekStart("2026-10-23"), "2026-10-18"); // שישי → ראשון
  assertEquals(isoWeekStart("2026-10-18"), "2026-10-18");
  assertEquals(addDays("2026-10-01", -1), "2026-09-30");
  assertEquals(ageFrom("1990-10-24", "2026-10-23"), 35);
  assertEquals(ageFrom("1990-10-23", "2026-10-23"), 36);
  assertEquals(downsample([...Array(100).keys()], 10).length, 10);
  const long = Array.from({ length: 30 }, (_, i) => `פסקה ${i} ${"א".repeat(300)}`).join("\n\n");
  const parts = splitMessage(long);
  assert(parts.length > 1 && parts.every((p) => p.length <= 4000));
  assertEquals(parts.join("\n\n"), long);
});

Deno.test("כלים: כולם strict עם additionalProperties: false, וכל property ב-required", () => {
  for (const t of TOOLS) {
    const schema = t.input_schema as unknown as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
    assertEquals(t.strict, true, t.name);
    assertEquals(schema.additionalProperties, false, t.name);
    assertEquals(Object.keys(schema.properties).sort(), [...schema.required].sort(), t.name);
  }
});

Deno.test("system prompt קבוע (בלי תאריכים או משתנים שישברו את ה-cache)", () => {
  assert(!/\$\{|\d{4}-\d{2}-\d{2}/.test(SYSTEM_PROMPT));
});

Deno.test("executeTool: כלי לא מוכר נדחה", async () => {
  const { executeTool } = await import("../../supabase/functions/_shared/agent/tools.ts");
  await assertRejects(() => executeTool("drop_tables", {}, { db: {} as never, userId: "u", timezone: "UTC" }), ToolInputError);
});
