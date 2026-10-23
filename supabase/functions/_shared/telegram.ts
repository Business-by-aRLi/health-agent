// =====================================================================
// Telegram Bot API: עטיפה דקה על fetch. רק מה שאנחנו צריכים.
// =====================================================================

const API = "https://api.telegram.org";

function token(): string {
  const t = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN missing");
  return t;
}

async function call<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API}/bot${token()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`telegram ${method} failed: ${json.description ?? res.status}`);
  return json.result as T;
}

/** טלגרם מגביל הודעה ל-4096 תווים. מפצלים בגבול של פסקה, ואם אין, בגבול של שורה. */
export function splitMessage(text: string, max = 4000): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** שולח טקסט פשוט (בלי parse_mode, כדי שתווים כמו * או _ לא ישברו את ההודעה). מחזיר את ה-id של ההודעה האחרונה. */
export async function sendMessage(chatId: number, text: string): Promise<number | null> {
  let last: number | null = null;
  for (const part of splitMessage(text)) {
    const msg = await call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: part,
      link_preview_options: { is_disabled: true },
    });
    last = msg.message_id;
  }
  return last;
}

export async function sendTyping(chatId: number): Promise<void> {
  await call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
}

/** מוריד קובץ (הודעה קולית, תמונה) מהשרתים של טלגרם */
export async function downloadFile(fileId: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; path: string }> {
  const file = await call<{ file_path: string }>("getFile", { file_id: fileId });
  const res = await fetch(`${API}/file/bot${token()}/${file.file_path}`);
  if (!res.ok) throw new Error(`telegram file download failed: ${res.status}`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), path: file.file_path };
}

export async function setWebhook(url: string, secretToken: string): Promise<void> {
  await call("setWebhook", {
    url,
    secret_token: secretToken,
    allowed_updates: ["message"],
    drop_pending_updates: false,
  });
  await call("setMyCommands", {
    commands: [
      { command: "new", description: "שיחה חדשה (הסוכן שוכח את ההקשר של השיחה, לא את הזיכרון)" },
      { command: "help", description: "מה אפשר לעשות כאן" },
    ],
  });
}

export function webhookSecret(): Promise<string> {
  // נגזר מטוקן הבוט: אין צורך ב-secret נוסף, ומי שלא מחזיק את הטוקן לא יכול לזייף update
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(`tg-webhook:${token()}`))
    .then((buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""));
}

// הטיפוסים המינימליים של Update שאנחנו קוראים
export interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
    voice?: { file_id: string; duration: number; mime_type?: string };
    audio?: { file_id: string; duration: number; mime_type?: string };
    photo?: Array<{ file_id: string; width: number; height: number }>;
    document?: { file_id: string; mime_type?: string; file_name?: string };
    caption?: string;
  };
}
