import { consumeRateLimit, requireOwner } from "../_shared/auth.ts";
import {
  abandonOperation,
  assertNoActiveProviderSubscription,
  beginOperation,
  completeOperation,
  stripeFormRequest,
  stripePriceId,
} from "../_shared/billing.ts";
import { errorResponse, HttpError, jsonResponse, optionsResponse, requireIdempotencyKey } from "../_shared/http.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return optionsResponse(request);
  if (request.method !== "POST") return jsonResponse(request, { error: "Method not allowed" }, 405);

  let operationKey: string | null = null;
  let freshOperation = false;
  try {
    const { user, membership } = await requireOwner(request);
    await consumeRateLimit("billing:stripe-checkout", user.id, 8, 60);
    operationKey = requireIdempotencyKey(request);
    const operation = await beginOperation({
      idempotencyKey: operationKey,
      gymId: membership.gym_id,
      userId: user.id,
      provider: "stripe",
      operation: "checkout",
    });
    if (!operation.fresh) return jsonResponse(request, operation.response);
    freshOperation = true;

    await assertNoActiveProviderSubscription(membership.gym_id);
    const appOrigin = Deno.env.get("APP_ORIGIN")?.replace(/\/$/, "");
    if (!appOrigin) throw new HttpError("Billing return URL is not configured.", 503, "APP_ORIGIN_MISSING");

    const form = new URLSearchParams();
    form.set("mode", "subscription");
    form.set("line_items[0][price]", stripePriceId());
    form.set("line_items[0][quantity]", "1");
    form.set("success_url", `${appOrigin}/?billing=success&provider=stripe&session_id={CHECKOUT_SESSION_ID}`);
    form.set("cancel_url", `${appOrigin}/?billing=cancelled&provider=stripe`);
    form.set("client_reference_id", user.id);
    form.set("metadata[owner_id]", user.id);
    form.set("metadata[gym_id]", membership.gym_id);
    form.set("subscription_data[metadata][owner_id]", user.id);
    form.set("subscription_data[metadata][gym_id]", membership.gym_id);
    if (user.email) form.set("customer_email", user.email);

    const session = await stripeFormRequest("/v1/checkout/sessions", form, operationKey);
    if (typeof session.url !== "string" || typeof session.id !== "string") {
      throw new HttpError("Stripe did not return a checkout session.", 502, "STRIPE_SESSION_INVALID");
    }
    const response = { url: session.url, sessionId: session.id };
    await completeOperation(operationKey, response);
    return jsonResponse(request, response);
  } catch (error) {
    if (freshOperation && operationKey) await abandonOperation(operationKey).catch(() => undefined);
    return errorResponse(request, error);
  }
});
