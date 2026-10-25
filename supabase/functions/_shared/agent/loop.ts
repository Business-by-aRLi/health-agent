// =====================================================================
// לולאת הסוכן (tool-use loop).
//
// 🧠 איך זה עובד: שולחים למודל את ההיסטוריה + ההודעה החדשה + רשימת כלים.
//    אם הוא מחזיר tool_use, מריצים את הכלים, מחזירים tool_result, וחוזרים.
//    כשהוא מסיים (end_turn), התשובה מוכנה.
//
// בתוך תור אחד ההיסטוריה היא append-only: מוסיפים את response.content כמו שהוא,
// כולל בלוקי thinking, בלי לערוך כלום. זה מה שמאפשר למודל להמשיך לחשוב בין כלים.
// =====================================================================

import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./system-prompt.ts";
import { TOOLS, ToolInputError } from "./tools.ts";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type Message = Anthropic.Beta.Messages.BetaMessage;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;

export const DEFAULT_MODEL = "claude-opus-5-5";
const MAX_ITERATIONS = 10;

// 🧠 לפעמים המודל "כותב" קריאה לכלי כטקסט (תגיות invoke/parameter) במקום לקרוא לו באמת.
//    אז שום דבר לא נרשם, והמשתמש רואה XML ו"רשמתי" שלא קרה. מזהים את זה, ומבקשים פעם
//    אחת לבצע את הקריאות כקריאות אמיתיות. אם זה חוזר, לפחות לא מציגים את ה-XML.
const PSEUDO_TOOL_CALL = /<\/?(?:antml:)?(?:function_calls|invoke|parameter)\b/;
const PSEUDO_TOOL_FIX =
  "[הודעת מערכת, לא מהמשתמש] בתשובה האחרונה כתבת קריאות לכלים כטקסט (תגיות invoke/parameter), ולכן הן לא בוצעו ושום דבר לא נרשם. " +
  "בצע עכשיו את הקריאות הנחוצות באמצעות הכלים עצמם, ואחר כך כתוב שוב את התשובה המלאה למשתמש, בלי שום תגיות.";

export function hasPseudoToolCall(text: string): boolean {
  return PSEUDO_TOOL_CALL.test(text);
}

/** חותך את התשובה לפני תחילת ה-XML שדלף, כדי שלא יגיע לטלגרם */
export function stripPseudoToolCalls(text: string): string {
  const m = text.match(PSEUDO_TOOL_CALL);
  return m ? text.slice(0, m.index).trim() : text;
}

/** רק החלק של הלקוח שהסוכן צריך. בבדיקות מזריקים לקוח מזויף באותה צורה */
export type MessagesClient = Pick<Anthropic, "beta">;

export interface AgentInput {
  client: MessagesClient;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  userText: string;
  context: string;
  runTool: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  images?: Array<{ media_type: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; data: string }>; // base64
  model?: string;
  effort?: "low" | "medium" | "high";
}

export interface AgentResult {
  text: string;
  toolCalls: Array<{ name: string; ok: boolean }>;
  usage: { input: number; output: number; cache_read: number; cache_write: number };
  iterations: number;
  stopReason: string | null;
  model: string;
}

export async function runAgent(a: AgentInput): Promise<AgentResult> {
  const model = a.model ?? DEFAULT_MODEL;
  const messages: MessageParam[] = [
    ...a.history.map((h) => ({ role: h.role, content: h.content })),
    {
      role: "user",
      // תמונה (ארוחה) נכנסת לפני הטקסט, כמו שמומלץ לעבודה עם vision
      content: a.images?.length
        ? [
          ...a.images.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.media_type, data: img.data } })),
          { type: "text" as const, text: `${a.context}\n\n${a.userText}` },
        ]
        : `${a.context}\n\n${a.userText}`,
    },
  ];
  const toolCalls: AgentResult["toolCalls"] = [];
  const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  let response: Message | null = null;
  let i = 0;
  let pseudoRetried = false;

  for (; i < MAX_ITERATIONS; i++) {
    response = await a.client.beta.messages.create({
      model,
      max_tokens: 16000,
      // system + tools קבועים → נשמרים ב-cache. ה-breakpoint על ה-system מכסה גם את tools (שבאים לפניו)
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: TOOLS,
      messages,
      output_config: { effort: a.effort ?? "medium" },
      // אם מסווג הבטיחות דוחה בטעות (למשל שאלה על תרופות), הבקשה רצה מחדש על מודל חלופי בצד השרת
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    usage.input += response.usage.input_tokens ?? 0;
    usage.output += response.usage.output_tokens ?? 0;
    usage.cache_read += response.usage.cache_read_input_tokens ?? 0;
    usage.cache_write += response.usage.cache_creation_input_tokens ?? 0;

    if (response.stop_reason === "refusal") break;
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }
    if (response.stop_reason !== "tool_use") {
      if (!pseudoRetried && response.stop_reason === "end_turn" && hasPseudoToolCall(textOf(response))) {
        pseudoRetried = true;
        console.warn("pseudo tool call in text, asking to retry");
        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: PSEUDO_TOOL_FIX });
        continue;
      }
      break;
    }

    messages.push({ role: "assistant", content: response.content });
    const toolUses = response.content.filter((b) => b.type === "tool_use") as Anthropic.Beta.Messages.BetaToolUseBlock[];

    // כל הכלים של אותו תור רצים במקביל, וכל התוצאות חוזרות בהודעה אחת
    const results: ToolResult[] = await Promise.all(toolUses.map(async (t): Promise<ToolResult> => {
      try {
        const out = await a.runTool(t.name, (t.input ?? {}) as Record<string, unknown>);
        toolCalls.push({ name: t.name, ok: true });
        return { type: "tool_result", tool_use_id: t.id, content: JSON.stringify(out) };
      } catch (e) {
        toolCalls.push({ name: t.name, ok: false });
        // שגיאת קלט חוזרת למודל כדי שיתקן; שגיאה פנימית לא חושפת פרטים
        const msg = e instanceof ToolInputError ? e.message : "שגיאה פנימית בכלי. נסה שוב או ענה בלי הנתון הזה.";
        if (!(e instanceof ToolInputError)) console.error("tool failed", t.name, e);
        return { type: "tool_result", tool_use_id: t.id, content: msg, is_error: true };
      }
    }));
    messages.push({ role: "user", content: results });
  }

  const text = stripPseudoToolCalls(response ? textOf(response) : "");

  return {
    text: response?.stop_reason === "refusal"
      ? "לא הצלחתי לענות על זה. אפשר לנסח אחרת? אם זו שאלה רפואית דחופה, כדאי לפנות לרופא/ה."
      : text || (i >= MAX_ITERATIONS ? "זה לקח לי יותר מדי צעדים. אפשר לשאול בצורה ממוקדת יותר?" : "…"),
    toolCalls,
    usage,
    iterations: i + 1,
    stopReason: response?.stop_reason ?? null,
    model: response?.model ?? model,
  };
}

function textOf(r: Message): string {
  return r.content
    .filter((b) => b.type === "text")
    .map((b) => (b as Anthropic.Beta.Messages.BetaTextBlock).text)
    .join("\n")
    .trim();
}
