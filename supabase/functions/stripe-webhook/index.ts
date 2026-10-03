import { admin, writeAudit } from "../_shared/auth.ts";
import {
  claimWebhook,
  findGymByProviderSubscription,
  finishWebhook,
  stripeGet,
  stripeStatus,
  unixToIso,
  upsertBillingTransaction,
  upsertEntitlement,
  verifyStripeWebhook,
} from "../_shared/billing.ts";
import { errorResponse, jsonResponse, optionsResponse } from "../_shared/http.ts";

type StripeObject = Record<string, unknown> & {
  id?: string;
  status?: string;
  customer?: string;
  subscription?: string;
  payment_intent?: string;
  charge?: string;
  amount_paid?: number;
  amount_due?: number;
  amount_refunded?: number;
  currency?: string;
  current_period_end?: number;
  created?: number;
  metadata?: Record<string, string>;
  refunds?: { data?: Array<{ id?: string; amount?: number; created?: number }> };
};

async function subscriptionIdentity(object: StripeObject, ownerHint?: string | null, gymHint?: string | null) {
  const subscriptionId = object.id ?? "";
  if (!subscriptionId) return null;
  const known = await findGymByProviderSubscription("stripe", subscriptionId);
  const ownerId = object.metadata?.owner_id ?? ownerHint ?? known?.ownerId ?? null;
  const gymId = object.metadata?.gym_id ?? gymHint ?? known?.gymId ?? null;
  return ownerId && gymId ? { ownerId, gymId, subscriptionId } : null;
}

async function syncSubscription(object: StripeObject, ownerHint?: string | null, gymHint?: string | null) {
  const identity = await subscriptionIdentity(object, ownerHint, gymHint);
  if (!identity) return;
  await upsertEntitlement({
    ownerId: identity.ownerId,
    gymId: identity.gymId,
    provider: "stripe",
    status: stripeStatus(object.status),
    customerId: typeof object.customer === "string" ? object.customer : null,
    subscriptionId: identity.subscriptionId,
    periodEnd: unixToIso(object.current_period_end),
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return optionsResponse(request);
  if (request.method !== "POST") return jsonResponse(request, { error: "Method not allowed" }, 405);

  let eventKey = "";
  try {
    const rawBody = await request.text();
    if (!(await verifyStripeWebhook(rawBody, request.headers.get("stripe-signature")))) {
      return jsonResponse(request, { error: "Invalid Stripe signature" }, 400);
    }
    const event = JSON.parse(rawBody) as { id?: string; type?: string; data?: { object?: StripeObject } };
    eventKey = event.id ?? "";
    if (!eventKey) return jsonResponse(request, { error: "Stripe event ID is missing" }, 400);
    const fresh = await claimWebhook("stripe", eventKey, event.type, rawBody);
    if (!fresh) return jsonResponse(request, { received: true, duplicate: true });

    const object = event.data?.object;
    if (!object) {
      await finishWebhook("stripe", eventKey, "processed");
      return jsonResponse(request, { received: true });
    }

    if (event.type === "checkout.session.completed") {
      const subscriptionId = typeof object.subscription === "string" ? object.subscription : "";
      const ownerId = object.metadata?.owner_id;
      const gymId = object.metadata?.gym_id;
      if (subscriptionId && ownerId && gymId) {
        const subscription = (await stripeGet(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`)) as StripeObject;
        await syncSubscription(subscription, ownerId, gymId);
      }
    } else if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      await syncSubscription(object);
    } else if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
      const subscriptionId = typeof object.subscription === "string" ? object.subscription : "";
      const identity = subscriptionId ? await findGymByProviderSubscription("stripe", subscriptionId) : null;
      if (identity) {
        const paymentId =
          (typeof object.charge === "string" && object.charge) ||
          (typeof object.payment_intent === "string" && object.payment_intent) ||
          object.id ||
          eventKey;
        await upsertBillingTransaction({
          gymId: identity.gymId,
          ownerId: identity.ownerId,
          provider: "stripe",
          paymentId,
          subscriptionId,
          status: event.type === "invoice.paid" ? "paid" : "failed",
          amountMinor: Number(object.amount_paid ?? object.amount_due ?? 0),
          currency: typeof object.currency === "string" ? object.currency : "inr",
          occurredAt: unixToIso(object.created) ?? undefined,
          metadata: { stripe_event_id: eventKey, invoice_id: object.id ?? null },
        });
        await writeAudit({
          gymId: identity.gymId,
          userId: null,
          role: "system",
          action: event.type === "invoice.paid" ? "subscription_payment_succeeded" : "subscription_payment_failed",
          entityType: "billing_transaction",
          entityId: paymentId,
          metadata: { provider: "stripe", subscription_id: subscriptionId },
        });
      }
    } else if (event.type === "charge.refunded") {
      const paymentId = object.id ?? "";
      if (paymentId) {
        const { data: existing } = await admin
          .from("billing_transactions")
          .select("gym_id,owner_id,provider_subscription_id,amount_minor,currency")
          .eq("provider", "stripe")
          .eq("provider_payment_id", paymentId)
          .eq("kind", "subscription")
          .maybeSingle();
        if (existing) {
          const refund = object.refunds?.data?.[0];
          const refundId = refund?.id ?? `refund:${eventKey}`;
          const refundAmount = Number(refund?.amount ?? object.amount_refunded ?? 0);
          await upsertBillingTransaction({
            gymId: existing.gym_id,
            ownerId: existing.owner_id,
            provider: "stripe",
            paymentId,
            subscriptionId: existing.provider_subscription_id,
            refundId,
            kind: "refund",
            status: refundAmount >= Number(existing.amount_minor ?? 0) ? "refunded" : "partially_refunded",
            amountMinor: refundAmount,
            currency: existing.currency,
            occurredAt: unixToIso(refund?.created) ?? undefined,
            metadata: { stripe_event_id: eventKey },
          });
          await writeAudit({
            gymId: existing.gym_id,
            userId: null,
            role: "system",
            action: "subscription_refund_recorded",
            entityType: "billing_refund",
            entityId: refundId,
            metadata: { provider: "stripe", payment_id: paymentId, amount_minor: refundAmount },
          });
        }
      }
    }

    await finishWebhook("stripe", eventKey, "processed");
    return jsonResponse(request, { received: true });
  } catch (error) {
    if (eventKey) await finishWebhook("stripe", eventKey, "failed", "PROCESSING_ERROR").catch(() => undefined);
    return errorResponse(request, error);
  }
});
