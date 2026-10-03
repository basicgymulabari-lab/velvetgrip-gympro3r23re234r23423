import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2.112.0";
import { HttpError } from "./http.ts";

const url = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const publicKey =
  Deno.env.get("SUPABASE_ANON_KEY") ??
  Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
  "";

if (!url || !serviceKey || !publicKey) {
  throw new Error("Supabase Edge Function environment is not configured.");
}

export const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export type GymRole = "owner" | "receptionist";
export type GymMembership = {
  gym_id: string;
  user_id: string;
  role: GymRole;
  display_name: string;
  email: string;
  enabled: boolean;
  permissions: Record<string, boolean>;
};

function bearerToken(request: Request) {
  const header = request.headers.get("authorization")?.trim() ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return "";
  return header.slice(7).trim();
}

export async function requireGymUser(request: Request) {
  const token = bearerToken(request);
  if (!token) throw new HttpError("Sign in before continuing.", 401, "AUTH_REQUIRED");

  const userClient = createClient(url, publicKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await userClient.auth.getUser(token);
  const user = data.user;
  if (error || !user) throw new HttpError("Your session has expired. Sign in again.", 401, "SESSION_EXPIRED");

  const { data: membership, error: membershipError } = await admin
    .from("gym_users")
    .select("gym_id,user_id,role,display_name,email,enabled,permissions")
    .eq("user_id", user.id)
    .maybeSingle();
  if (membershipError) throw new HttpError("Could not verify gym access.", 502, "GYM_LOOKUP_FAILED");
  if (!membership || membership.enabled === false) {
    throw new HttpError("Your gym access is not active.", 403, "GYM_ACCESS_DENIED");
  }
  if (membership.role !== "owner" && membership.role !== "receptionist") {
    throw new HttpError("This account is not authorized for the management application.", 403, "ROLE_DENIED");
  }

  return {
    token,
    user: user as User,
    membership: {
      ...membership,
      permissions:
        membership.permissions && typeof membership.permissions === "object"
          ? (membership.permissions as Record<string, boolean>)
          : {},
    } as GymMembership,
    userClient: userClient as SupabaseClient,
  };
}

export async function requireOwner(request: Request) {
  const context = await requireGymUser(request);
  if (context.membership.role !== "owner") {
    throw new HttpError("Only the gym owner can perform this action.", 403, "OWNER_REQUIRED");
  }
  return context;
}

export async function consumeRateLimit(scope: string, subject: string, limit: number, windowSeconds: number) {
  const { data, error } = await admin.rpc("consume_api_rate_limit", {
    p_scope: scope,
    p_subject: subject,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) {
    console.error("Rate limit RPC failed", error);
    throw new HttpError("Could not verify request limits.", 502, "RATE_LIMIT_FAILED");
  }
  if (data !== true) throw new HttpError("Too many requests. Please try again shortly.", 429, "RATE_LIMITED");
}

export async function writeAudit(input: {
  gymId: string;
  userId: string | null;
  role: "owner" | "receptionist" | "system";
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const { error } = await admin.from("audit_logs").insert({
    gym_id: input.gymId,
    user_id: input.userId,
    role: input.role,
    action: input.action,
    entity_type: input.entityType ?? null,
    entity_id: input.entityId ?? null,
    metadata: input.metadata ?? {},
  });
  if (error) console.error("Audit insert failed", error);
}
