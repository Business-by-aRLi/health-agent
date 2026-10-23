// =====================================================================
// תמלול הודעות קוליות (OpenAI Whisper). עברית.
// =====================================================================

export async function transcribe(bytes: Uint8Array<ArrayBuffer>, filename = "voice.ogg"): Promise<string> {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY missing");

  const form = new FormData();
  form.append("file", new Blob([bytes]), filename); // טלגרם שולח OGG/Opus, ו-Whisper תומך בו ישירות
  form.append("model", "whisper-1");
  form.append("language", "he");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) throw new Error(`transcription failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return String(json.text ?? "").trim();
}
