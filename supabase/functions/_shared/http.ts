export class HttpError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = "BAD_REQUEST") {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

function allowedOrigins() {
  const values = [
    Deno.env.get("APP_ORIGIN") ?? "",
    ...(Deno.env.get("EXTRA_ALLOWED_ORIGINS") ?? "").split(","),
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set(values);
}

export function corsHeaders(request: Request) {
  const origin = request.headers.get("origin") ?? "";
  const allowed = allowedOrigins();
  // Match configured origins exactly. Broad localhost exceptions leak into
  // production deployments and can authorize arbitrary local web apps.
  const selected = allowed.has(origin) ? origin : Deno.env.get("APP_ORIGIN") ?? "";
  return {
    "Access-Control-Allow-Origin": selected,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, idempotency-key, stripe-signature, x-razorpay-signature",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function optionsResponse(request: Request) {
  return new Response("ok", { headers: corsHeaders(request) });
}

export function jsonResponse(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;

export async function readLimitedBodyText(
  request: Request,
  maxBytes = DEFAULT_MAX_REQUEST_BYTES,
) {
  const body = request.body;
  if (!body) return "";

  const contentLength = request.headers.get("content-length")?.trim() ?? "";
  if (/^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    void body.cancel().catch(() => undefined);
    throw new HttpError("The request body is too large.", 413, "PAYLOAD_TOO_LARGE");
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new HttpError("The request body is too large.", 413, "PAYLOAD_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function errorResponse(request: Request, error: unknown) {
  if (error instanceof HttpError) {
    return jsonResponse(request, { error: error.message, code: error.code }, error.status);
  }
  console.error("Unhandled Edge Function error", error);
  return jsonResponse(
    request,
    { error: "The service could not complete this request. Please try again.", code: "INTERNAL_ERROR" },
    500,
  );
}

export async function parseJson<T extends Record<string, unknown>>(request: Request): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError("Expected a JSON request body.", 415, "UNSUPPORTED_MEDIA_TYPE");
  }
  try {
    const body = JSON.parse(await readLimitedBodyText(request));
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("not an object");
    }
    return body as T;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError("The request body is invalid.", 400, "INVALID_JSON");
  }
}

export function requireIdempotencyKey(request: Request) {
  const value = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError("A valid Idempotency-Key header is required.", 400, "INVALID_IDEMPOTENCY_KEY");
  }
  return value.toLowerCase();
}
