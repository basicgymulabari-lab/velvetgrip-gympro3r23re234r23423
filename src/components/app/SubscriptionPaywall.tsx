import { useEffect, useMemo, useState } from "react";
import {
  BadgeCheck,
  CreditCard,
  KeyRound,
  Loader2,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  activateLocalPro,
  expireLocalProNow,
  FREE_MEMBER_LIMIT,
  localSubscriptionDaysRemaining,
  redeemRechargeCode,
  refreshSubscription,
  resetLocalPro,
  useSubscription,
} from "@/lib/billing/client";
import { isSupabaseConfigured } from "@/integrations/supabase/client";
import { invokeEdgeFunction } from "@/integrations/supabase/functions";

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

let razorpayScriptPromise: Promise<void> | null = null;

function loadRazorpayCheckout() {
  if (window.Razorpay) return Promise.resolve();
  if (razorpayScriptPromise) return razorpayScriptPromise;
  razorpayScriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Razorpay Checkout could not be loaded."));
    document.head.appendChild(script);
  });
  return razorpayScriptPromise;
}

export function SubscriptionPaywall({
  open,
  onOpenChange,
  reason,
  canPurchase = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reason: "member-limit" | "manage";
  canPurchase?: boolean;
}) {
  const subscription = useSubscription();
  const [busy, setBusy] = useState<"stripe" | "razorpay" | "recharge" | null>(null);
  const [code, setCode] = useState("");
  const cloudReady = isSupabaseConfigured();
  const planName = import.meta.env.VITE_PRO_PLAN_NAME || "IRONVAULT Pro";
  const priceLabel = import.meta.env.VITE_PRO_PLAN_PRICE_LABEL || "Monthly subscription";

  useEffect(() => {
    if (open) void refreshSubscription();
  }, [open]);

  const expiryLabel = useMemo(() => {
    if (!subscription.currentPeriodEnd) return null;
    return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(
      new Date(subscription.currentPeriodEnd),
    );
  }, [subscription.currentPeriodEnd]);
  const daysRemaining = localSubscriptionDaysRemaining(subscription);

  const startStripe = async () => {
    setBusy("stripe");
    try {
      const body = await invokeEdgeFunction<{ url?: unknown }>("stripe-checkout", {
        body: {},
        idempotent: true,
      });
      if (typeof body.url !== "string") throw new Error("Stripe did not return a checkout page.");
      window.location.assign(body.url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Stripe checkout could not start.");
      setBusy(null);
    }
  };

  const startRazorpay = async () => {
    setBusy("razorpay");
    try {
      const [created] = await Promise.all([
        invokeEdgeFunction<{ keyId?: unknown; subscriptionId?: unknown; email?: unknown }>(
          "razorpay-create",
          {
            body: {},
            idempotent: true,
          },
        ),
        loadRazorpayCheckout(),
      ]);
      if (
        typeof created.keyId !== "string" ||
        typeof created.subscriptionId !== "string" ||
        !window.Razorpay
      ) {
        throw new Error("Razorpay checkout is not configured correctly.");
      }

      const checkout = new window.Razorpay({
        key: created.keyId,
        subscription_id: created.subscriptionId,
        name: "IRONVAULT",
        description: `${planName} · ${priceLabel}`,
        prefill: { email: typeof created.email === "string" ? created.email : "" },
        theme: { color: "#D4AF37" },
        handler: async (payment: Record<string, unknown>) => {
          try {
            await invokeEdgeFunction<{ success: boolean }>("razorpay-verify", {
              body: {
                paymentId: payment.razorpay_payment_id,
                subscriptionId: payment.razorpay_subscription_id,
                signature: payment.razorpay_signature,
              },
              idempotent: true,
            });
            await refreshSubscription();
            toast.success("Subscription activated successfully.");
            onOpenChange(false);
          } catch (error) {
            toast.error(error instanceof Error ? error.message : "Payment verification failed.");
          } finally {
            setBusy(null);
          }
        },
        modal: { ondismiss: () => setBusy(null) },
      });
      checkout.open();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Razorpay checkout could not start.");
      setBusy(null);
    }
  };

  const redeem = async () => {
    if (!code.trim()) return;
    setBusy("recharge");
    try {
      const result = (await redeemRechargeCode(code)) as {
        days_added?: number;
        already_redeemed?: boolean;
      } | null;
      setCode("");
      toast.success(
        result?.already_redeemed
          ? "This code was already redeemed by your account; your current Pro access is unchanged."
          : `Recharge successful — Pro access is active for ${result?.days_added ?? "the granted number of"} day${result?.days_added === 1 ? "" : "s"}.`,
      );
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Recharge failed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-2xl border border-gold/30 bg-gold/10 text-gold">
            <Sparkles className="h-6 w-6" />
          </div>
          <DialogTitle className="font-display text-3xl tracking-wide">
            {reason === "member-limit" ? "Unlock more members" : "Subscription & Billing"}
          </DialogTitle>
          <DialogDescription>
            {reason === "member-limit"
              ? `Your free workspace supports up to ${FREE_MEMBER_LIMIT} gym members. Activate Pro to keep growing your roster.`
              : "Activate or extend your IRONVAULT Pro access using your preferred payment method."}
          </DialogDescription>
        </DialogHeader>

        {subscription.active && (
          <div className="flex gap-3 rounded-xl border border-success/35 bg-success/10 p-4">
            <BadgeCheck className="mt-0.5 h-5 w-5 shrink-0 text-success" />
            <div>
              <p className="text-sm font-semibold text-success">Pro is active</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {expiryLabel
                  ? `Current access is active through ${expiryLabel} · ${daysRemaining} day${daysRemaining === 1 ? "" : "s"} remaining.`
                  : "Your paid access is active."}
              </p>
            </div>
          </div>
        )}

        {!subscription.active && subscription.status === "expired" && (
          <div className="flex gap-3 rounded-xl border border-warning/35 bg-warning/10 p-4">
            <CreditCard className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
            <div>
              <p className="text-sm font-semibold">Pro has expired</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {expiryLabel
                  ? `Your previous access ended on ${expiryLabel}. Your existing records remain available, but the free 10-member growth limit is active again.`
                  : "Renew Pro to unlock roster growth beyond the free member limit."}
              </p>
            </div>
          </div>
        )}

        {!canPurchase && (
          <div className="flex gap-3 rounded-xl border border-warning/35 bg-warning/10 p-4">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
            <div>
              <p className="text-sm font-semibold">Owner action required</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Ask the gym owner to activate or extend IRONVAULT Pro. Billing and recharge-code
                activation are available only from the owner account.
              </p>
            </div>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-border bg-secondary/25 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Users className="h-4 w-4 text-muted-foreground" /> Free
            </div>
            <p className="mt-3 font-display text-2xl tracking-wide">Up to {FREE_MEMBER_LIMIT}</p>
            <p className="mt-1 text-xs text-muted-foreground">gym members in the roster</p>
          </div>
          <div className="rounded-2xl border border-gold/35 bg-gold/5 p-4 shadow-[var(--shadow-gold)]">
            <div className="flex items-center gap-2 text-sm font-semibold text-gold">
              <ShieldCheck className="h-4 w-4" /> {planName}
            </div>
            <p className="mt-3 font-display text-2xl tracking-wide">Grow beyond 10</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {priceLabel} · all current app tools stay available
            </p>
          </div>
        </div>

        {!cloudReady && canPurchase && (
          <div className="rounded-2xl border border-gold/35 bg-gold/5 p-4">
            <div className="flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gold/10 text-gold">
                <ShieldCheck className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">Local subscription mode</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Use this only to verify the complete Free → Pro → Expired → Renew experience
                  before deploying online. These controls disappear automatically when Supabase
                  billing is configured.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      activateLocalPro(30);
                      toast.success(
                        subscription.active
                          ? "Local Pro extended by 30 days."
                          : "Local Pro activated for 30 days.",
                      );
                    }}
                  >
                    {subscription.active ? "Extend +30 days" : "Activate 30 days"}
                  </Button>
                  {subscription.active && (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        expireLocalProNow();
                        toast.info("Local Pro expiry simulated.");
                      }}
                    >
                      Simulate expiry
                    </Button>
                  )}
                  {(subscription.source === "local" || subscription.status === "expired") && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        resetLocalPro();
                        toast.info("Returned to the Free plan.");
                      }}
                    >
                      Reset to Free
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Pay online
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              type="button"
              className="h-11"
              disabled={Boolean(busy) || !cloudReady || !canPurchase}
              onClick={() => void startRazorpay()}
            >
              {busy === "razorpay" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <CreditCard className="mr-2 h-4 w-4" />
              )}
              Pay with Razorpay
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="h-11"
              disabled={Boolean(busy) || !cloudReady || !canPurchase}
              onClick={() => void startStripe()}
            >
              {busy === "stripe" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <CreditCard className="mr-2 h-4 w-4" />
              )}
              Pay with Stripe
            </Button>
          </div>
          {!cloudReady && (
            <p className="text-xs text-warning">
              Stripe and Razorpay are online payment services and cannot charge while fully offline.
              They can be tested from localhost when this computer has internet access and Supabase
              + provider credentials are configured.
            </p>
          )}
        </div>

        <div className="rounded-2xl border border-border bg-secondary/20 p-4">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gold/10 text-gold">
              <KeyRound className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Have a 30-day recharge code?</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Enter the single-use scratch/recharge code supplied by IRONVAULT to extend Pro
                access.
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <div className="flex-1 space-y-1">
                  <Label htmlFor="subscription-recharge-code" className="sr-only">
                    Recharge code
                  </Label>
                  <Input
                    id="subscription-recharge-code"
                    value={code}
                    onChange={(event) => setCode(event.target.value.toUpperCase())}
                    placeholder="IV-202609-XXXX-XXXX-XXXX"
                    autoComplete="off"
                    disabled={Boolean(busy) || !cloudReady || !canPurchase}
                  />
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={Boolean(busy) || !code.trim() || !cloudReady || !canPurchase}
                  onClick={() => void redeem()}
                >
                  {busy === "recharge" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Apply code
                </Button>
              </div>
            </div>
          </div>
        </div>

        <p className="text-[11px] leading-5 text-muted-foreground">
          Payment access is activated only after server-side provider verification or a valid
          recharge-code redemption. Closing the payment window does not unlock Pro.
        </p>
      </DialogContent>
    </Dialog>
  );
}
