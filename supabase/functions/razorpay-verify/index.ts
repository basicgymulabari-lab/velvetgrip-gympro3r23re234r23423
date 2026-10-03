import { consumeRateLimit, requireOwner, writeAudit } from "../_shared/auth.ts";
import {
  abandonOperation,
  beginOperation,
  completeOperation,
  razorpayRequest,
  razorpayStatus,
  unixToIso,
  upsertBillingTransaction,
  upsertEntitlement,
  verifyRazorpayPaymentSignature,
} from "../_shared/billing.ts";
import { errorResponse, HttpError, jsonResponse, optionsResponse, parseJson, requireIdempotencyKey } from "../_shared/http.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return optionsResponse(request);
  if (request.method !== "POST") return jsonResponse(request, { error: "Method not allowed" }, 405);

  let operationKey: string | null = null;
  let freshOperation = false;
  try {
    const { user, membership } = await requireOwner(request);
    await consumeRateLimit("billing:razorpay-verify", user.id, 20, 60);
    operationKey = requireIdempotencyKey(request);
    const operation = await beginOperation({
      idempotencyKey: operationKey,
      gymId: membership.gym_id,
      userId: user.id,
      provider: "razorpay",
      operation: "verify",
    });
    if (!operation.fresh) return jsonResponse(request, operation.response);
    freshOperation = true;

    const body = await parseJson<{ paymentId?: unknown; subscriptionId?: unknown; signature?: unknown }>(request);
    const paymentId = typeof body.paymentId === "string" ? body.paymentId.trim() : "";
    const subscriptionId = typeof body.subscriptionId === "string" ? body.subscriptionId.trim() : "";
    const signature = typeof body.signature === "string" ? body.signature.trim() : "";
    if (!/^pay_[A-Za-z0-9]+$/.test(paymentId) || !/^sub_[A-Za-z0-9]+$/.test(subscriptionId) || !/^[a-f0-9]{64}$/i.test(signature)) {
      throw new HttpError("Incomplete or invalid Razorpay payment response.", 400, "INVALID_RAZORPAY_RESPONSE");
    }
    if (!(await verifyRazorpayPaymentSignature(paymentId, subscriptionId, signature))) {
      throw new HttpError("Invalid Razorpay payment signature.", 400, "INVALID_RAZORPAY_SIGNATURE");
    }

    const subscription = await razorpayRequest(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
    const notes = subscription.notes as Record<string, unknown> | undefined;
    if (notes?.owner_id !== user.id || notes?.gym_id !== membership.gym_id) {
      throw new HttpError("This subscription belongs to another account.", 403, "SUBSCRIPTION_OWNERSHIP_MISMATCH");
    }
    await upsertEntitlement({
      ownerId: user.id,
      gymId: membership.gym_id,
      provider: "razorpay",
      status: razorpayStatus(subscription.status),
      subscriptionId,
      periodEnd: unixToIso(subscription.current_end),
    });

    const payment = await razorpayRequest(`/v1/payments/${encodeURIComponent(paymentId)}`);
    await upsertBillingTransaction({
      gymId: membership.gym_id,
      ownerId: user.id,
      provider: "razorpay",
      paymentId,
      subscriptionId,
      status: payment.status === "captured" ? "paid" : payment.status === "authorized" ? "authorized" : "pending",
      amountMinor: Number(payment.amount ?? 0),
      currency: typeof payment.currency === "string" ? payment.currency : "INR",
      occurredAt: unixToIso(payment.created_at) ?? undefined,
      metadata: { verified_by_client_signature: true },
    });
    await writeAudit({
      gymId: membership.gym_id,
      userId: user.id,
      role: "owner",
      action: "subscription_verified",
      entityType: "subscription",
      entityId: subscriptionId,
      metadata: { provider: "razorpay", payment_id: paymentId },
    });

    const response = { success: true };
    await completeOperation(operationKey, response);
    return jsonResponse(request, response);
  } catch (error) {
    if (freshOperation && operationKey) await abandonOperation(operationKey).catch(() => undefined);
    return errorResponse(request, error);
  }
});
