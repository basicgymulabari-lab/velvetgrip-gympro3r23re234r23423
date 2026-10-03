import { admin, writeAudit } from "../_shared/auth.ts";
import {
  claimWebhook,
  findGymByProviderSubscription,
  finishWebhook,
  razorpayStatus,
  sha256Hex,
  unixToIso,
  upsertBillingTransaction,
  upsertEntitlement,
  verifyRazorpayWebhook,
} from "../_shared/billing.ts";
import { errorResponse, jsonResponse, optionsResponse } from "../_shared/http.ts";

type Entity = Record<string, unknown> & {
  id?: string;
  status?: string;
  current_end?: number;
  created_at?: number;
  amount?: number;
  currency?: string;
  subscription_id?: string;
  payment_id?: string;
  notes?: Record<string, unknown>;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return optionsResponse(request);
  if (request.method !== "POST") return jsonResponse(request, { error: "Method not allowed" }, 405);

  let eventKey = "";
  try {
    const rawBody = await request.text();
    if (!(await verifyRazorpayWebhook(rawBody, request.headers.get("x-razorpay-signature")))) {
      return jsonResponse(request, { error: "Invalid Razorpay signature" }, 400);
    }
    const event = JSON.parse(rawBody) as {
      event?: string;
      payload?: {
        subscription?: { entity?: Entity };
        payment?: { entity?: Entity };
        refund?: { entity?: Entity };
      };
    };
    eventKey = await sha256Hex(rawBody);
    const fresh = await claimWebhook("razorpay", eventKey, event.event, rawBody);
    if (!fresh) return jsonResponse(request, { received: true, duplicate: true });

    const subscription = event.payload?.subscription?.entity;
    if (event.event?.startsWith("subscription.") && subscription?.id) {
      const known = await findGymByProviderSubscription("razorpay", subscription.id);
      const ownerId = typeof subscription.notes?.owner_id === "string" ? subscription.notes.owner_id : known?.ownerId;
      const gymId = typeof subscription.notes?.gym_id === "string" ? subscription.notes.gym_id : known?.gymId;
      if (ownerId && gymId) {
        await upsertEntitlement({
          ownerId,
          gymId,
          provider: "razorpay",
          status: razorpayStatus(subscription.status),
          subscriptionId: subscription.id,
          periodEnd: unixToIso(subscription.current_end),
        });
      }
    }

    const payment = event.payload?.payment?.entity;
    if (event.event?.startsWith("payment.") && payment?.id) {
      const subscriptionId = typeof payment.subscription_id === "string" ? payment.subscription_id : undefined;
      const known = subscriptionId ? await findGymByProviderSubscription("razorpay", subscriptionId) : null;
      const ownerId = typeof payment.notes?.owner_id === "string" ? payment.notes.owner_id : known?.ownerId;
      const gymId = typeof payment.notes?.gym_id === "string" ? payment.notes.gym_id : known?.gymId;
      if (ownerId && gymId) {
        const status =
          event.event === "payment.captured"
            ? "paid"
            : event.event === "payment.failed"
              ? "failed"
              : payment.status === "authorized"
                ? "authorized"
                : "pending";
        await upsertBillingTransaction({
          gymId,
          ownerId,
          provider: "razorpay",
          paymentId: payment.id,
          subscriptionId,
          status,
          amountMinor: Number(payment.amount ?? 0),
          currency: typeof payment.currency === "string" ? payment.currency : "INR",
          occurredAt: unixToIso(payment.created_at) ?? undefined,
          metadata: { webhook_event: event.event ?? null },
        });
        await writeAudit({
          gymId,
          userId: null,
          role: "system",
          action: status === "paid" ? "subscription_payment_succeeded" : status === "failed" ? "subscription_payment_failed" : "subscription_payment_updated",
          entityType: "billing_transaction",
          entityId: payment.id,
          metadata: { provider: "razorpay", subscription_id: subscriptionId ?? null },
        });
      }
    }

    const refund = event.payload?.refund?.entity;
    if (event.event?.startsWith("refund.") && refund?.id && typeof refund.payment_id === "string") {
      const { data: existing } = await admin
        .from("billing_transactions")
        .select("gym_id,owner_id,provider_subscription_id,amount_minor,currency")
        .eq("provider", "razorpay")
        .eq("provider_payment_id", refund.payment_id)
        .eq("kind", "subscription")
        .maybeSingle();
      if (existing) {
        const amount = Number(refund.amount ?? 0);
        await upsertBillingTransaction({
          gymId: existing.gym_id,
          ownerId: existing.owner_id,
          provider: "razorpay",
          paymentId: refund.payment_id,
          subscriptionId: existing.provider_subscription_id,
          refundId: refund.id,
          kind: "refund",
          status: amount >= Number(existing.amount_minor ?? 0) ? "refunded" : "partially_refunded",
          amountMinor: amount,
          currency: existing.currency,
          occurredAt: unixToIso(refund.created_at) ?? undefined,
          metadata: { webhook_event: event.event ?? null },
        });
        await writeAudit({
          gymId: existing.gym_id,
          userId: null,
          role: "system",
          action: "subscription_refund_recorded",
          entityType: "billing_refund",
          entityId: refund.id,
          metadata: { provider: "razorpay", payment_id: refund.payment_id, amount_minor: amount },
        });
      }
    }

    await finishWebhook("razorpay", eventKey, "processed");
    return jsonResponse(request, { received: true });
  } catch (error) {
    if (eventKey) await finishWebhook("razorpay", eventKey, "failed", "PROCESSING_ERROR").catch(() => undefined);
    return errorResponse(request, error);
  }
});
