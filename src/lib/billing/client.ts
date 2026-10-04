import { useSyncExternalStore } from "react";
import { isSupabaseConfigured, supabase } from "../../integrations/supabase/client";
import { invokeEdgeFunction } from "../../integrations/supabase/functions";
import type { GymState } from "../gym/types";

export const FREE_MEMBER_LIMIT = 10;
export const SUBSCRIPTION_PAYWALL_EVENT = "ironvault:subscription-paywall";
const SUBSCRIPTION_CACHE_KEY = "ironvault.subscription-cache.v1";
const LOCAL_SUBSCRIPTION_KEY = "ironvault.local-subscription.v1";

export type SubscriptionSource = "stripe" | "razorpay" | "recharge" | "manual" | "local" | null;

export type SubscriptionSnapshot = {
  loaded: boolean;
  status: "free" | "active" | "past_due" | "canceled" | "expired";
  source: SubscriptionSource;
  currentPeriodEnd: string | null;
  active: boolean;
};

let snapshot: SubscriptionSnapshot = {
  loaded: false,
  status: "free",
  source: null,
  currentPeriodEnd: null,
  active: false,
};
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function setSnapshot(next: Omit<SubscriptionSnapshot, "active">) {
  const active =
    next.status === "active" &&
    Boolean(next.currentPeriodEnd) &&
    new Date(next.currentPeriodEnd as string).getTime() > Date.now();
  snapshot = { ...next, active };
  if (typeof window !== "undefined") {
    window.localStorage.setItem(
      SUBSCRIPTION_CACHE_KEY,
      JSON.stringify({
        status: next.status,
        source: next.source,
        currentPeriodEnd: next.currentPeriodEnd,
      }),
    );
  }
  emit();
}

function readCachedSubscription(): SubscriptionSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SUBSCRIPTION_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as {
      status?: unknown;
      source?: unknown;
      currentPeriodEnd?: unknown;
    };
    const status =
      cached.status === "active" ||
      cached.status === "past_due" ||
      cached.status === "canceled" ||
      cached.status === "expired"
        ? cached.status
        : "free";
    const source =
      cached.source === "stripe" ||
      cached.source === "razorpay" ||
      cached.source === "recharge" ||
      cached.source === "manual" ||
      cached.source === "local"
        ? cached.source
        : null;
    const currentPeriodEnd =
      typeof cached.currentPeriodEnd === "string" ? cached.currentPeriodEnd : null;
    return {
      loaded: true,
      status,
      source,
      currentPeriodEnd,
      active:
        status === "active" &&
        Boolean(currentPeriodEnd) &&
        new Date(currentPeriodEnd as string).getTime() > Date.now(),
    };
  } catch {
    return null;
  }
}

function readLocalSubscription(): SubscriptionSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LOCAL_SUBSCRIPTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { currentPeriodEnd?: unknown };
    const currentPeriodEnd =
      typeof parsed.currentPeriodEnd === "string" ? parsed.currentPeriodEnd : null;
    if (!currentPeriodEnd) return null;
    const active = new Date(currentPeriodEnd).getTime() > Date.now();
    return {
      loaded: true,
      status: active ? "active" : "expired",
      source: "local",
      currentPeriodEnd,
      active,
    };
  } catch {
    return null;
  }
}

function writeLocalSubscription(currentPeriodEnd: string | null) {
  if (typeof window === "undefined") return;
  if (!currentPeriodEnd) {
    window.localStorage.removeItem(LOCAL_SUBSCRIPTION_KEY);
    return;
  }
  window.localStorage.setItem(
    LOCAL_SUBSCRIPTION_KEY,
    JSON.stringify({ currentPeriodEnd, updatedAt: new Date().toISOString() }),
  );
}

export function useSubscription() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => snapshot,
  );
}

export function getSubscriptionSnapshot() {
  return snapshot;
}

export async function refreshSubscription() {
  if (!isSupabaseConfigured()) {
    const local = readLocalSubscription();
    if (local) {
      setSnapshot({
        loaded: true,
        status: local.status,
        source: "local",
        currentPeriodEnd: local.currentPeriodEnd,
      });
    } else {
      setSnapshot({ loaded: true, status: "free", source: null, currentPeriodEnd: null });
    }
    return snapshot;
  }
  try {
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) {
      // Cached billing data is display-only. Never grant a paid entitlement
      // when the authenticated tenant cannot be verified.
      setSnapshot({ loaded: true, status: "free", source: null, currentPeriodEnd: null });
      return snapshot;
    }
    const { data, error } = await supabase
      .from("subscription_entitlements")
      .select("status,source,current_period_end")
      .maybeSingle();
    if (error) throw error;
    const status =
      data?.status === "active" ||
      data?.status === "past_due" ||
      data?.status === "canceled" ||
      data?.status === "expired"
        ? data.status
        : "free";
    const source =
      data?.source === "stripe" ||
      data?.source === "razorpay" ||
      data?.source === "recharge" ||
      data?.source === "manual"
        ? data.source
        : null;
    setSnapshot({
      loaded: true,
      status,
      source,
      currentPeriodEnd: data?.current_period_end ?? null,
    });
  } catch (error) {
    console.error("Could not refresh subscription entitlement", error);
    // Do not grant paid access when the authoritative entitlement cannot be verified.
    setSnapshot({ loaded: true, status: "free", source: null, currentPeriodEnd: null });
  }
  return snapshot;
}

export function isLocalBillingMode() {
  // Local subscription simulation is explicit QA-only behavior. A deployed
  // build always relies on the authoritative Supabase entitlement.
  return (
    import.meta.env.DEV &&
    !isSupabaseConfigured() &&
    String(import.meta.env.VITE_ENABLE_LOCAL_BILLING ?? "").toLowerCase() === "true"
  );
}

export function localSubscriptionDaysRemaining(value: SubscriptionSnapshot = snapshot) {
  if (!value.currentPeriodEnd) return 0;
  return Math.max(
    0,
    Math.ceil((new Date(value.currentPeriodEnd).getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
  );
}

export function activateLocalPro(days = 30) {
  if (!isLocalBillingMode())
    throw new Error("Local Pro controls are disabled. Use the configured subscription backend.");
  const safeDays = Math.min(365, Math.max(1, Math.round(days)));
  const current = readLocalSubscription();
  const now = Date.now();
  const existingEnd = current?.currentPeriodEnd ? new Date(current.currentPeriodEnd).getTime() : 0;
  const base = Math.max(now, existingEnd);
  const currentPeriodEnd = new Date(base + safeDays * 24 * 60 * 60 * 1000).toISOString();
  writeLocalSubscription(currentPeriodEnd);
  setSnapshot({ loaded: true, status: "active", source: "local", currentPeriodEnd });
  return snapshot;
}

export function expireLocalProNow() {
  if (!isLocalBillingMode())
    throw new Error("Local Pro controls are disabled. Use the configured subscription backend.");
  const currentPeriodEnd = new Date(Date.now() - 1000).toISOString();
  writeLocalSubscription(currentPeriodEnd);
  setSnapshot({ loaded: true, status: "expired", source: "local", currentPeriodEnd });
  return snapshot;
}

export function resetLocalPro() {
  if (!isLocalBillingMode())
    throw new Error("Local Pro controls are disabled. Use the configured subscription backend.");
  writeLocalSubscription(null);
  setSnapshot({ loaded: true, status: "free", source: null, currentPeriodEnd: null });
  return snapshot;
}

export async function verifyStripeCheckout(sessionId: string) {
  if (!isSupabaseConfigured()) throw new Error("Cloud billing is not configured for this build.");
  await invokeEdgeFunction<{ success: boolean }>("stripe-verify", {
    body: { sessionId },
    idempotent: true,
  });
  return refreshSubscription();
}

export async function redeemRechargeCode(code: string) {
  if (!isSupabaseConfigured()) throw new Error("Cloud billing is not configured for this build.");
  const normalized = code.trim().toUpperCase();
  if (normalized.length < 8) throw new Error("Enter a valid recharge code.");
  const { data, error } = await supabase.rpc("redeem_recharge_code", { p_code: normalized });
  if (error) {
    if (error.message.includes("NOT_ASSIGNED_TO_ACCOUNT"))
      throw new Error("This code is assigned to a different gym-owner account. Sign in with the assigned account.");
    if (error.message.includes("ALREADY_USED"))
      throw new Error("This recharge code has already been used.");
    if (error.message.includes("EXPIRED")) throw new Error("This recharge code has expired.");
    if (error.message.includes("REVOKED")) throw new Error("This recharge code has been revoked.");
    if (error.message.includes("INVALID_RECHARGE_CODE"))
      throw new Error("That recharge code is not valid.");
    throw new Error("The recharge code could not be activated. Please try again.");
  }
  await refreshSubscription();
  return data;
}

export function regularMemberCount(state: GymState) {
  return state.members.filter(
    (member) => !member.deletedAt && (member.type === undefined || member.type === "member"),
  ).length;
}

export function canAddRegularMember(state: GymState) {
  if (regularMemberCount(state) < FREE_MEMBER_LIMIT) return true;
  return snapshot.active;
}

export function openSubscriptionPaywall(reason: "member-limit" | "manage" = "manage") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SUBSCRIPTION_PAYWALL_EVENT, { detail: { reason } }));
}
