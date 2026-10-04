import { createClient, type User } from "npm:@supabase/supabase-js@2.112.0";
import { admin } from "../_shared/auth.ts";
import { errorResponse, HttpError, jsonResponse, optionsResponse, parseJson } from "../_shared/http.ts";
import { consumeRateLimit } from "../_shared/auth.ts";

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function secureChunk(length: number) {
  const random = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(random, (value) => alphabet[value % alphabet.length]).join("");
}

async function hashCode(code: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bearerToken(request: Request) {
  const header = request.headers.get("authorization")?.trim() ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

async function requireBillingAdmin(request: Request): Promise<User> {
  const token = bearerToken(request);
  if (!token) throw new HttpError("Sign in with the billing administrator account.", 401, "AUTH_REQUIRED");

  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new HttpError("Your session has expired. Sign in again.", 401, "SESSION_EXPIRED");
  const allowedEmails = (Deno.env.get("BILLING_ADMIN_EMAILS") ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  const email = data.user.email?.trim().toLowerCase();
  if (!email || !data.user.email_confirmed_at || !allowedEmails.includes(email)) {
    throw new HttpError("Recharge-code management is restricted to the billing administrator.", 403, "BILLING_ADMIN_REQUIRED");
  }
  return data.user;
}

function validInteger(value: unknown, min: number, max: number, fallback: number) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new HttpError(`Choose a whole number from ${min} to ${max}.`, 400, "INVALID_NUMBER");
  }
  return number;
}

async function listCodes(request: Request) {
  const { data, error } = await admin
    .from("recharge_codes")
    .select("id,duration_days,batch_label,valid_until,redeemed_by,redeemed_at,revoked_at,created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new HttpError("Could not load recharge codes.", 502, "CODE_LIST_FAILED");
  return jsonResponse(request, { codes: data ?? [] });
}

async function createCodes(request: Request, user: User, body: Record<string, unknown>) {
  const days = validInteger(body.days, 1, 366, 30);
  const count = validInteger(body.count, 1, 50, 1);
  const validDays = validInteger(body.validDays, 1, 366, 30);
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 80) : "";
  const month = new Date().toISOString().slice(0, 7).replace("-", "");
  const codes = Array.from(
    { length: count },
    () => `IV-${month}-${secureChunk(4)}-${secureChunk(4)}-${secureChunk(4)}`,
  );
  const hashes = await Promise.all(codes.map(hashCode));
  const validUntil = new Date(Date.now() + validDays * 86_400_000).toISOString();
  const rows = hashes.map((code_hash) => ({
    code_hash,
    duration_days: days,
    batch_label: label || `Issued ${new Date().toISOString().slice(0, 10)}`,
    valid_until: validUntil,
    created_by: user.id,
  }));

  const { error } = await admin.from("recharge_codes").insert(rows);
  if (error) {
    console.error("Recharge-code creation failed", error);
    throw new HttpError("Could not create these recharge codes. Please try again.", 502, "CODE_CREATE_FAILED");
  }

  return jsonResponse(request, { codes, days, validUntil, count });
}

async function revokeCode(request: Request, codeId: unknown) {
  if (typeof codeId !== "string" || !/^[0-9a-f-]{36}$/i.test(codeId)) {
    throw new HttpError("Select a valid recharge code.", 400, "INVALID_CODE_ID");
  }
  const { data, error } = await admin
    .from("recharge_codes")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", codeId)
    .is("redeemed_at", null)
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();
  if (error) throw new HttpError("Could not revoke this code.", 502, "CODE_REVOKE_FAILED");
  if (!data) throw new HttpError("This code was already redeemed or revoked.", 409, "CODE_NOT_REVOCABLE");
  return jsonResponse(request, { revoked: true });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return optionsResponse(request);
  if (request.method !== "POST") return jsonResponse(request, { error: "Method not allowed" }, 405);

  try {
    const user = await requireBillingAdmin(request);
    await consumeRateLimit("billing:recharge-admin", user.id, 60, 60);
    const body = await parseJson<Record<string, unknown>>(request);
    const action = body.action;
    if (action === "list") return await listCodes(request);
    if (action === "create") return await createCodes(request, user, body);
    if (action === "revoke") return await revokeCode(request, body.codeId);
    throw new HttpError("Choose a valid recharge-code action.", 400, "INVALID_ACTION");
  } catch (error) {
    return errorResponse(request, error);
  }
});
