// =====================================================================
// לולאת הסוכן מול OpenAI (GPT), דרך ה-Responses API.
//
// 🧠 אותו חוזה כמו הלולאה של Claude (AgentInput → AgentResult), כך שה-webhook והמתזמן
//    לא יודעים מי המודל. ההבדלים בפרוטוקול:
//    - system prompt נשלח ב-instructions, והכלים מוגדרים "שטוחים" (type/name/parameters/strict).
//    - קריאה לכלי חוזרת כ-item מסוג function_call, והתוצאה נשלחת כ-function_call_output עם call_id.
//    - store: false, ולכן בתוך תור שולחים בחזרה את כל ה-output כמו שהוא, כולל items של
//      reasoning עם encrypted_content, כדי שהמודל ימשיך לחשוב בין כלים (append-only, כמו ב-Claude).
//    - cache של הפרומפט אוטומטי ב-OpenAI. prompt_cache_key לפי משתמש משפר את הפגיעה בו.
// =====================================================================

import type { AgentInput, AgentResult } from "./loop.ts";
import { hasPseudoToolCall, PSEUDO_TOOL_FIX, stripPseudoToolCalls } from "./loop.ts";
import { SYSTEM_PROMPT } from "./system-prompt.ts";
import { TOOLS, ToolInputError } from "./tools.ts";

const API = "https://api.openai.com/v1/responses";
const MAX_ITERATIONS = 10;

type Item = Record<string, unknown>;

interface OpenAIResponse {
  id: string;
  model: string;
  status: string; // completed / incomplete / failed
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string } | null;
  output: Item[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
}

/** הכלים בפורמט של OpenAI. strict רק לכלים שהסכמה שלהם עומדת בכללים (כמו ב-Claude) */
export const OPENAI_TOOLS = TOOLS.map((t) => ({
  type: "function",
  name: t.name,
  description: t.description,
  parameters: t.input_schema,
  strict: t.strict === true,
}));

export async function runOpenAIAgent(a: AgentInput, model: string): Promise<AgentResult> {
  const doFetch = a.fetch ?? fetch;
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key && !a.fetch) throw new Error("OPENAI_API_KEY missing");

  const userText = `${a.context}\n\n${a.userText}`;
  const input: Item[] = [
    ...a.history.map((h) => ({ role: h.role, content: h.content })),
    {
      role: "user",
      content: [
        // תמונה (ארוחה) לפני הטקסט, כמו בלולאה של Claude
        ...(a.images ?? []).map((img) => ({ type: "input_image", image_url: `data:${img.media_type};base64,${img.data}` })),
        { type: "input_text", text: userText },
      ],
    },
  ];
  const toolCalls: AgentResult["toolCalls"] = [];
  const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  let response: OpenAIResponse | null = null;
  let refused = false;
  let pseudoRetried = false;
  let i = 0;

  for (; i < MAX_ITERATIONS; i++) {
    const res = await doFetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key ?? "test"}` },
      body: JSON.stringify({
        model,
        instructions: SYSTEM_PROMPT,
        input,
        tools: OPENAI_TOOLS,
        reasoning: { effort: a.effort ?? "medium" },
        max_output_tokens: 16000,
        store: false,
        include: ["reasoning.encrypted_content"],
        ...(a.cacheKey ? { prompt_cache_key: a.cacheKey } : {}),
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new OpenAIError(res.status, body?.error?.message ?? `HTTP ${res.status}`);
    response = body as OpenAIResponse;

    const u = response.usage ?? {};
    const cached = u.input_tokens_details?.cached_tokens ?? 0;
    usage.input += (u.input_tokens ?? 0) - cached;
    usage.cache_read += cached;
    usage.output += u.output_tokens ?? 0;

    refused = response.output.some((o) =>
      o.type === "message" && (o.content as Item[] | undefined)?.some((c) => c.type === "refusal")
    );
    if (refused) break;

    const calls = response.output.filter((o) => o.type === "function_call");
    if (!calls.length) {
      if (!pseudoRetried && response.status === "completed" && hasPseudoToolCall(textOf(response))) {
        pseudoRetried = true;
        console.warn("pseudo tool call in text, asking to retry");
        input.push(...response.output, { role: "user", content: PSEUDO_TOOL_FIX });
        continue;
      }
      break;
    }

    // ה-output חוזר כמו שהוא (כולל reasoning), ואחריו כל התוצאות. הכלים רצים במקביל
    input.push(...response.output);
    const results = await Promise.all(calls.map(async (c): Promise<Item> => {
      const name = String(c.name);
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(String(c.arguments ?? "{}"));
      } catch {
        toolCalls.push({ name, ok: false });
        return { type: "function_call_output", call_id: c.call_id, output: "הקלט לכלי לא היה JSON תקין. נסה שוב." };
      }
      try {
        const out = await a.runTool(name, args);
        toolCalls.push({ name, ok: true });
        return { type: "function_call_output", call_id: c.call_id, output: JSON.stringify(out) };
      } catch (e) {
        toolCalls.push({ name, ok: false });
        const msg = e instanceof ToolInputError ? e.message : "שגיאה פנימית בכלי. נסה שוב או ענה בלי הנתון הזה.";
        if (!(e instanceof ToolInputError)) console.error("tool failed", name, e);
        return { type: "function_call_output", call_id: c.call_id, output: msg };
      }
    }));
    input.push(...results);
  }

  const text = stripPseudoToolCalls(response ? textOf(response) : "");
  const truncated = response?.status === "incomplete";
  return {
    text: refused
      ? "לא הצלחתי לענות על זה. אפשר לנסח אחרת? אם זו שאלה רפואית דחופה, כדאי לפנות לרופא/ה."
      : text || (i >= MAX_ITERATIONS ? "זה לקח לי יותר מדי צעדים. אפשר לשאול בצורה ממוקדת יותר?" : "…"),
    toolCalls,
    usage,
    iterations: i + 1,
    stopReason: refused ? "refusal" : truncated ? `incomplete:${response?.incomplete_details?.reason ?? ""}` : response?.status ?? null,
    model: response?.model ?? model,
  };
}

export class OpenAIError extends Error {
  constructor(readonly status: number, message: string) {
    super(`openai ${status}: ${message}`);
  }
}

function textOf(r: OpenAIResponse): string {
  return r.output
    .filter((o) => o.type === "message")
    .flatMap((o) => (o.content as Item[] | undefined) ?? [])
    .filter((c) => c.type === "output_text")
    .map((c) => String(c.text ?? ""))
    .join("\n")
    .trim();
}
