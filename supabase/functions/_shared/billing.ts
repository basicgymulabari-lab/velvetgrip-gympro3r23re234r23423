import { admin } from "./auth.ts";
import { HttpError } from "./http.ts";

export type Provider = "stripe" | "razorpay";
export type EntitlementStatus = "free" | "active" | "past_due" | "canceled" | "expired";

function env(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new HttpError(`Billing is not configured: ${name} is missing.`, 503, "BILLING_NOT_CONFIGURED");
  return value;
}

export function optionalEnv(name: string) {
  return Deno.env.get(name)?.trim() || undefined;
}

export async function beginOperation(input: {
  idempotencyKey: string;
  gymId: string;
  userId: string;
  provider: Provider;
  operation: "checkout" | "verify";
}) {
  const row = {
    idempotency_key: input.idempotencyKey,
    gym_id: input.gymId,
    user_id: input.userId,
    provider: input.provider,
    operation: input.operation,
  };
  const { error } = await admin.from("billing_operations").insert(row);
  if (!error) return { fresh: true as const, response: null };
  if (error.code !== "23505") throw new HttpError("Could not start the billing operation.", 502, "BILLING_OPERATION_FAILED");

  const { data: existing, error: existingError } = await admin
    .from("billing_operations")
    .select("gym_id,user_id,provider,operation,response")
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
  if (existingError || !existing) throw new HttpError("Could not resume the billing operation.", 502, "BILLING_OPERATION_FAILED");
  if (
    existing.gym_id !== input.gymId ||
    existing.user_id !== input.userId ||
    existing.provider !== input.provider ||
    existing.operation !== input.operation
  ) {
    throw new HttpError("This idempotency key is already in use.", 409, "IDEMPOTENCY_CONFLICT");
  }
  if (existing.response) return { fresh: false as const, response: existing.response as Record<string, unknown> };
  throw new HttpError("This request is already being processed.", 409, "OPERATION_IN_PROGRESS");
}

export async function completeOperation(idempotencyKey: string, response: Record<string, unknown>) {
  const { error } = await admin
    .from("billing_operations")
    .update({ response, completed_at: new Date().toISOString() })
    .eq("idempotency_key", idempotencyKey);
  if (error) throw new HttpError("Could not save the billing operation result.", 502, "BILLING_OPERATION_FAILED");
}

export async function abandonOperation(idempotencyKey: string) {
  await admin.from("billing_operations").delete().eq("idempotency_key", idempotencyKey);
}

export async function assertNoActiveProviderSubscription(gymId: string) {
  const { data, error } = await admin
    .from("subscription_entitlements")
    .select("provider_source,provider_period_end")
    .eq("gym_id", gymId)
    .eq("provider_status", "active")
    .maybeSingle();
  if (error) throw new HttpError("Could not verify your current subscription.", 502, "ENTITLEMENT_LOOKUP_FAILED");
  if (data?.provider_period_end && new Date(data.provider_period_end).getTime() > Date.now()) {
    const provider = data.provider_source === "razorpay" ? "Razorpay" : "Stripe";
    throw new HttpError(`An active ${provider} recurring subscription already exists.`, 409, "SUBSCRIPTION_EXISTS");
  }
}

export async function upsertEntitlement(input: {
  ownerId: string;
  gymId: string;
  provider: Provider;
  status: EntitlementStatus;
  customerId?: string | null;
  subscriptionId: string;
  periodEnd?: string | null;
}) {
  const now = new Date().toISOString();
  const { error } = await admin.from("subscription_entitlements").upsert(
    {
      owner_id: input.ownerId,
      gym_id: input.gymId,
      provider_status: input.status,
      provider_source: input.provider,
      provider_customer_id: input.customerId ?? null,
      provider_subscription_id: input.subscriptionId,
      provider_period_end: input.periodEnd ?? null,
      last_verified_at: now,
      updated_at: now,
    },
    { onConflict: "owner_id" },
  );
  if (error) {
    console.error("Entitlement upsert failed", error);
    throw new HttpError("Could not update subscription status.", 502, "ENTITLEMENT_UPDATE_FAILED");
  }
}

export async function findGymByProviderSubscription(provider: Provider, subscriptionId: string) {
  const { data, error } = await admin
    .from("subscription_entitlements")
    .select("owner_id,gym_id")
    .eq("provider_source", provider)
    .eq("provider_subscription_id", subscriptionId)
    .maybeSingle();
  if (error) return null;
  return data?.gym_id && data?.owner_id ? { gymId: data.gym_id, ownerId: data.owner_id } : null;
}

function bytesToHex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(message: string) {
  const bytes = new TextEncoder().encode(message);
  return bytesToHex(await crypto.subtle.digest("SHA-256", bytes));
}

export async function hmacSha256Hex(secret: string, message: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

export function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export async function verifyStripeWebhook(rawBody: string, signatureHeader: string | null) {
  if (!signatureHeader) return false;
  const parts = signatureHeader.split(",").map((part) => part.trim().split("=", 2));
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!timestamp || signatures.length === 0) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > 300) return false;
  const expected = await hmacSha256Hex(env("STRIPE_WEBHOOK_SECRET"), `${timestamp}.${rawBody}`);
  return signatures.some((signature) => constantTimeEqual(signature, expected));
}

export async function verifyRazorpayWebhook(rawBody: string, signature: string | null) {
  if (!signature) return false;
  const expected = await hmacSha256Hex(env("RAZORPAY_WEBHOOK_SECRET"), rawBody);
  return constantTimeEqual(signature.trim(), expected);
}

export async function verifyRazorpayPaymentSignature(paymentId: string, subscriptionId: string, signature: string) {
  const expected = await hmacSha256Hex(env("RAZORPAY_KEY_SECRET"), `${paymentId}|${subscriptionId}`);
  return constantTimeEqual(expected, signature.trim());
}

export async function claimWebhook(provider: Provider, eventKey: string, eventType: string | undefined, rawBody: string) {
  const hash = await sha256Hex(rawBody);
  const { error } = await admin.from("billing_webhook_events").insert({
    provider,
    event_key: eventKey,
    event_type: eventType ?? null,
    payload_sha256: hash,
    status: "processing",
  });
  if (!error) return true;
  if (error.code === "23505") return false;
  throw new HttpError("Could not register webhook event.", 502, "WEBHOOK_REGISTER_FAILED");
}

export async function finishWebhook(provider: Provider, eventKey: string, status: "processed" | "failed", errorCode?: string) {
  await admin
    .from("billing_webhook_events")
    .update({ status, error_code: errorCode ?? null, processed_at: new Date().toISOString() })
    .eq("provider", provider)
    .eq("event_key", eventKey);
}

export async function stripeFormRequest(path: string, form: URLSearchParams, idempotencyKey?: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env("STRIPE_SECRET_KEY")}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(`https://api.stripe.com${path}`, {
    method: "POST",
    headers,
    body: form.toString(),
  });
  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const providerError = data.error as { message?: string } | undefined;
    throw new HttpError(providerError?.message ?? "Stripe request failed.", 502, "STRIPE_REQUEST_FAILED");
  }
  return data;
}

export async function stripeGet(path: string) {
  const response = await fetch(`https://api.stripe.com${path}`, {
    headers: { Authorization: `Bearer ${env("STRIPE_SECRET_KEY")}` },
  });
  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new HttpError("Could not verify the Stripe subscription.", 502, "STRIPE_VERIFY_FAILED");
  return data;
}

function basicAuth(user: string, password: string) {
  return `Basic ${btoa(`${user}:${password}`)}`;
}

export async function razorpayRequest(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", basicAuth(env("RAZORPAY_KEY_ID"), env("RAZORPAY_KEY_SECRET")));
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`https://api.razorpay.com${path}`, { ...init, headers });
  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const providerError = data.error as { description?: string } | undefined;
    throw new HttpError(providerError?.description ?? "Razorpay request failed.", 502, "RAZORPAY_REQUEST_FAILED");
  }
  return data;
}

export function stripeStatus(value: unknown): EntitlementStatus {
  if (value === "active" || value === "trialing") return "active";
  if (value === "past_due" || value === "unpaid") return "past_due";
  if (value === "canceled") return "canceled";
  return "expired";
}

export function razorpayStatus(value: unknown): EntitlementStatus {
  if (value === "active" || value === "authenticated") return "active";
  if (value === "halted" || value === "pending") return "past_due";
  if (value === "cancelled" || value === "completed") return "canceled";
  return "expired";
}

export function unixToIso(value: unknown) {
  const seconds = typeof value === "number" ? value : Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

export async function upsertBillingTransaction(input: {
  gymId: string;
  ownerId: string;
  provider: Provider;
  paymentId: string;
  subscriptionId?: string | null;
  refundId?: string | null;
  kind?: "subscription" | "refund";
  status: "pending" | "authorized" | "paid" | "failed" | "refunded" | "partially_refunded";
  amountMinor?: number;
  currency?: string;
  occurredAt?: string;
  metadata?: Record<string, unknown>;
}) {
  const row = {
    gym_id: input.gymId,
    owner_id: input.ownerId,
    provider: input.provider,
    provider_payment_id: input.paymentId,
    provider_subscription_id: input.subscriptionId ?? null,
    provider_refund_id: input.refundId ?? "",
    kind: input.kind ?? "subscription",
    status: input.status,
    amount_minor: Math.max(0, Math.round(input.amountMinor ?? 0)),
    currency: (input.currency ?? "inr").toLowerCase().slice(0, 3),
    occurred_at: input.occurredAt ?? new Date().toISOString(),
    metadata: input.metadata ?? {},
  };
  const conflict = "provider,provider_payment_id,kind,provider_refund_id";
  const { error } = await admin.from("billing_transactions").upsert(row, { onConflict: conflict });
  if (error) console.error("Billing transaction upsert failed", error);
}

export function stripePriceId() {
  return env("STRIPE_PRICE_ID");
}

export function razorpayPlanId() {
  return env("RAZORPAY_PLAN_ID");
}

export function razorpayKeyId() {
  return env("RAZORPAY_KEY_ID");
}
