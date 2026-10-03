import { supabase } from "./client";

export async function invokeEdgeFunction<T>(
  name: string,
  options: { body?: Record<string, unknown>; idempotent?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.idempotent) headers["Idempotency-Key"] = crypto.randomUUID();
  const { data, error } = await supabase.functions.invoke<T>(name, {
    body: options.body ?? {},
    headers,
  });
  if (!error) return data as T;

  let message = error.message || "The service could not complete this request.";
  const context = (error as { context?: unknown }).context;
  if (context instanceof Response) {
    try {
      const body = (await context.clone().json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error.trim()) message = body.error;
    } catch {
      // Keep the SDK error when the response is not JSON.
    }
  }
  throw new Error(message);
}
