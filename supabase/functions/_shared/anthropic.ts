import Anthropic from "@anthropic-ai/sdk";

// ANTHROPIC_API_KEY מה-secrets של Supabase. מפתח שלא משויך ל-workspace מחייב גם את
// ה-header של ה-workspace, ולכן אם הוגדר ANTHROPIC_WORKSPACE_ID הוא נשלח בכל בקשה.
export function anthropicClient(): Anthropic {
  const workspaceId = Deno.env.get("ANTHROPIC_WORKSPACE_ID");
  return new Anthropic(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {});
}
