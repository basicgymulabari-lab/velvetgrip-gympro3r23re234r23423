import { consumeRateLimit, requireOwner, writeAudit } from "../_shared/auth.ts";
import {
  abandonOperation,
  beginOperation,
  completeOperation,
  stripeGet,
  stripeStatus,
  unixToIso,
  upsertEntitlement,
} from "../_shared/billing.ts";
import { errorResponse, HttpError, jsonResponse, optionsResponse, parseJson, requireIdempotencyKey } from "../_shared/http.ts";

type Checkout = {
  client_reference_id?: string;
  subscription?: string;
  customer?: string;
  metadata?: Record<string, string>;
};
type Subscription = {
  id?: string;
  status?: string;
  customer?: string;
  current_period_end?: number;
  metadata?: Record<string, string>;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return optionsResponse(request);
  if (request.method !== "POST") return jsonResponse(request, { error: "Method not allowed" }, 405);

  let operationKey: string | null = null;
  let freshOperation = false;
  try {
    const { user, membership } = await requireOwner(request);
    await consumeRateLimit("billing:stripe-verify", user.id, 20, 60);
    operationKey = requireIdempotencyKey(request);
    const operation = await beginOperation({
      idempotencyKey: operationKey,
      gymId: membership.gym_id,
      userId: user.id,
      provider: "stripe",
      operation: "verify",
    });
    if (!operation.fresh) return jsonResponse(request, operation.response);
    freshOperation = true;

    const body = await parseJson<{ sessionId?: unknown }>(request);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId) || sessionId.length > 255) {
      throw new HttpError("Missing or invalid Stripe Checkout session.", 400, "INVALID_STRIPE_SESSION");
    }

    const checkout = (await stripeGet(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`)) as Checkout;
    if (
      checkout.client_reference_id !== user.id ||
      checkout.metadata?.gym_id !== membership.gym_id
    ) {
      throw new HttpError("This checkout belongs to another account.", 403, "CHECKOUT_OWNERSHIP_MISMATCH");
    }
    if (typeof checkout.subscription !== "string") {
      throw new HttpError("Stripe subscription is not ready yet.", 409, "SUBSCRIPTION_NOT_READY");
    }

    const subscription = (await stripeGet(
      `/v1/subscriptions/${encodeURIComponent(checkout.subscription)}`,
    )) as Subscription;
    if (subscription.metadata?.gym_id && subscription.metadata.gym_id !== membership.gym_id) {
      throw new HttpError("This subscription belongs to another gym.", 403, "SUBSCRIPTION_OWNERSHIP_MISMATCH");
    }
    await upsertEntitlement({
      ownerId: user.id,
      gymId: membership.gym_id,
      provider: "stripe",
      status: stripeStatus(subscription.status),
      customerId:
        typeof subscription.customer === "string"
          ? subscription.customer
          : typeof checkout.customer === "string"
            ? checkout.customer
            : null,
      subscriptionId: checkout.subscription,
      periodEnd: unixToIso(subscription.current_period_end),
    });
    await writeAudit({
      gymId: membership.gym_id,
      userId: user.id,
      role: "owner",
      action: "subscription_verified",
      entityType: "subscription",
      entityId: checkout.subscription,
      metadata: { provider: "stripe" },
    });

    const response = { success: true };
    await completeOperation(operationKey, response);
    return jsonResponse(request, response);
  } catch (error) {
    if (freshOperation && operationKey) await abandonOperation(operationKey).catch(() => undefined);
    return errorResponse(request, error);
  }
});
