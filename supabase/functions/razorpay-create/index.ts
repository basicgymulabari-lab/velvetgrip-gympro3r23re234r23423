import { consumeRateLimit, requireOwner } from "../_shared/auth.ts";
import {
  abandonOperation,
  assertNoActiveProviderSubscription,
  beginOperation,
  completeOperation,
  optionalEnv,
  razorpayKeyId,
  razorpayPlanId,
  razorpayRequest,
} from "../_shared/billing.ts";
import { errorResponse, HttpError, jsonResponse, optionsResponse, requireIdempotencyKey } from "../_shared/http.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return optionsResponse(request);
  if (request.method !== "POST") return jsonResponse(request, { error: "Method not allowed" }, 405);

  let operationKey: string | null = null;
  let freshOperation = false;
  try {
    const { user, membership } = await requireOwner(request);
    await consumeRateLimit("billing:razorpay-create", user.id, 8, 60);
    operationKey = requireIdempotencyKey(request);
    const operation = await beginOperation({
      idempotencyKey: operationKey,
      gymId: membership.gym_id,
      userId: user.id,
      provider: "razorpay",
      operation: "checkout",
    });
    if (!operation.fresh) return jsonResponse(request, operation.response);
    freshOperation = true;

    await assertNoActiveProviderSubscription(membership.gym_id);
    const totalCount = Math.max(1, Math.min(1200, Number(optionalEnv("RAZORPAY_TOTAL_COUNT")) || 120));
    const subscription = await razorpayRequest("/v1/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        plan_id: razorpayPlanId(),
        total_count: totalCount,
        quantity: 1,
        customer_notify: true,
        notes: {
          owner_id: user.id,
          gym_id: membership.gym_id,
          email: user.email ?? "",
          idempotency_key: operationKey,
        },
      }),
    });
    if (typeof subscription.id !== "string") {
      throw new HttpError("Razorpay did not return a subscription ID.", 502, "RAZORPAY_SUBSCRIPTION_INVALID");
    }
    const response = {
      keyId: razorpayKeyId(),
      subscriptionId: subscription.id,
      email: user.email ?? "",
    };
    await completeOperation(operationKey, response);
    return jsonResponse(request, response);
  } catch (error) {
    if (freshOperation && operationKey) await abandonOperation(operationKey).catch(() => undefined);
    return errorResponse(request, error);
  }
});
