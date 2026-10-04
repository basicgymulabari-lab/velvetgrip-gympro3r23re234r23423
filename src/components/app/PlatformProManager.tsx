import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BadgeCheck,
  Ban,
  Clock3,
  Copy,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Panel } from "@/components/app/Panel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isSupabaseConfigured, supabase } from "@/integrations/supabase/client";

type OwnerAccount = {
  gym_id: string;
  gym_name: string;
  owner_id: string;
  owner_email: string;
  status: string;
  source: string | null;
  current_period_end: string | null;
  days_remaining: number;
  can_revoke_bonus: boolean;
};

type RechargeCode = {
  code_id: string;
  batch_label: string | null;
  duration_days: number;
  created_at: string;
  redeem_by: string | null;
  assigned_owner: string | null;
  issued_by: string | null;
  redeemed_by: string | null;
  redeemed_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  code_status: string;
};

type NewCode = { code: string; target_email: string; duration_days: number; redeem_by: string };
type Action =
  | { kind: "grant"; owner: OwnerAccount }
  | { kind: "revoke-pro"; owner: OwnerAccount }
  | { kind: "revoke-code"; code: RechargeCode };

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(new Date(value));
}

function readableError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("PLATFORM_ADMIN_REQUIRED"))
    return "This account is not enabled for platform management.";
  if (message.includes("OWNER_NOT_FOUND"))
    return "That gym-owner account could not be found. Refresh the list and try again.";
  if (message.includes("CODE_NOT_UNUSED"))
    return "This code has already been used, expired, or revoked; only unused codes can be revoked.";
  if (message.includes("NO_REVOCABLE_PRO_ACCESS"))
    return "There is no manual or recharge Pro access to revoke for this account.";
  if (message.includes("DURATION_DAYS_MUST_BE_1_TO_366"))
    return "Choose a duration from 1 to 366 days.";
  return fallback;
}

export function PlatformProManager() {
  const [adminChecked, setAdminChecked] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [owners, setOwners] = useState<OwnerAccount[]>([]);
  const [codes, setCodes] = useState<RechargeCode[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ownerId, setOwnerId] = useState("");
  const [days, setDays] = useState("30");
  const [validDays, setValidDays] = useState("14");
  const [label, setLabel] = useState("");
  const [newCode, setNewCode] = useState<NewCode | null>(null);
  const [pendingAction, setPendingAction] = useState<Action | null>(null);

  const selectedOwner = useMemo(
    () => owners.find((owner) => owner.owner_id === ownerId) ?? owners[0] ?? null,
    [ownerId, owners],
  );

  const loadData = useCallback(async () => {
    if (!isSupabaseConfigured()) return;
    setLoading(true);
    try {
      const [ownerResult, codeResult] = await Promise.all([
        supabase.rpc("platform_list_owners"),
        supabase.rpc("platform_list_recharge_codes"),
      ]);
      if (ownerResult.error) throw ownerResult.error;
      if (codeResult.error) throw codeResult.error;
      const nextOwners = (ownerResult.data ?? []) as OwnerAccount[];
      setOwners(nextOwners);
      setCodes((codeResult.data ?? []) as RechargeCode[]);
      setOwnerId((current) =>
        nextOwners.some((owner) => owner.owner_id === current)
          ? current
          : (nextOwners[0]?.owner_id ?? ""),
      );
    } catch (error) {
      toast.error(readableError(error, "Could not load Pro access records."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    if (!isSupabaseConfigured()) {
      setAdminChecked(true);
      return;
    }
    void supabase.rpc("iv_is_platform_admin").then(({ data, error }) => {
      if (!active) return;
      if (error) {
        setIsAdmin(false);
        setAdminChecked(true);
        return;
      }
      setIsAdmin(data === true);
      setAdminChecked(true);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (isAdmin) void loadData();
  }, [isAdmin, loadData]);

  const generateCode = async () => {
    if (!selectedOwner) return toast.error("There are no registered owner accounts yet.");
    const duration = Number(days);
    const redeemWindow = Number(validDays);
    if (!Number.isInteger(duration) || duration < 1 || duration > 366)
      return toast.error("Choose a Pro duration from 1 to 366 days.");
    if (!Number.isInteger(redeemWindow) || redeemWindow < 1 || redeemWindow > 366)
      return toast.error("Choose a redemption deadline from 1 to 366 days.");

    setBusy(true);
    setNewCode(null);
    try {
      const { data, error } = await supabase.rpc("platform_generate_recharge_code", {
        p_owner_id: selectedOwner.owner_id,
        p_days: duration,
        p_valid_days: redeemWindow,
        p_batch_label: label.trim() || null,
      });
      if (error) throw error;
      const result = data?.[0];
      if (!result) throw new Error("Supabase did not return a recharge code.");
      setNewCode(result);
      setLabel("");
      await loadData();
      toast.success("Code created and assigned to this account.");
    } catch (error) {
      toast.error(readableError(error, "The code could not be created."));
    } finally {
      setBusy(false);
    }
  };

  const performAction = async () => {
    if (!pendingAction) return;
    setBusy(true);
    try {
      if (pendingAction.kind === "grant") {
        const duration = Number(days);
        if (!Number.isInteger(duration) || duration < 1 || duration > 366)
          throw new Error("Choose a Pro duration from 1 to 366 days.");
        const { error } = await supabase.rpc("platform_grant_manual_pro", {
          p_gym_id: pendingAction.owner.gym_id,
          p_days: duration,
        });
        if (error) throw error;
        toast.success(`Pro access granted to ${pendingAction.owner.owner_email}.`);
      } else if (pendingAction.kind === "revoke-pro") {
        const { data, error } = await supabase.rpc("platform_revoke_pro", {
          p_gym_id: pendingAction.owner.gym_id,
        });
        if (error) throw error;
        const result = data as { provider_still_active?: boolean } | null;
        toast.success(
          result?.provider_still_active
            ? "Bonus access removed. Their paid subscription remains active."
            : `Bonus Pro access revoked for ${pendingAction.owner.owner_email}.`,
        );
      } else {
        const { error } = await supabase.rpc("platform_revoke_recharge_code", {
          p_code_id: pendingAction.code.code_id,
        });
        if (error) throw error;
        toast.success("Unused code revoked. It can no longer be redeemed.");
      }
      setPendingAction(null);
      setNewCode(null);
      await loadData();
    } catch (error) {
      toast.error(readableError(error, "That change could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  if (!adminChecked || !isAdmin) return null;

  return (
    <Panel
      title="Pro Access Manager"
      description="Issue account-bound codes, grant or remove bonus access, and check expiry"
      collapsible
    >
      <div className="mb-5 flex items-start gap-3 rounded-xl border border-success/30 bg-success/5 p-4 text-sm">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-success" />
        <p className="text-muted-foreground">
          These controls are protected by Supabase. Recharge codes are assigned to one existing
          gym-owner account, work once, and are shown only when created. Payment-provider
          subscriptions must be canceled with Stripe or Razorpay.
        </p>
      </div>

      <section className="rounded-xl border border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 font-semibold">
              <KeyRound className="h-4 w-4 text-gold" /> Create a one-time code
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Choose the recipient first. Other accounts will be rejected.
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void loadData()}
            disabled={loading || busy}
          >
            {loading ? (
              <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Refresh
          </Button>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="space-y-2 sm:col-span-2 xl:col-span-1">
            <Label htmlFor="pro-code-owner">Account</Label>
            <select
              id="pro-code-owner"
              value={selectedOwner?.owner_id ?? ""}
              onChange={(event) => setOwnerId(event.target.value)}
              disabled={!owners.length || busy}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {owners.map((owner) => (
                <option key={owner.owner_id} value={owner.owner_id}>
                  {owner.owner_email} — {owner.gym_name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="pro-code-days">Pro days</Label>
            <Input
              id="pro-code-days"
              type="number"
              min={1}
              max={366}
              value={days}
              onChange={(event) => setDays(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pro-code-valid-days">Redeem within (days)</Label>
            <Input
              id="pro-code-valid-days"
              type="number"
              min={1}
              max={366}
              value={validDays}
              onChange={(event) => setValidDays(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pro-code-label">Note (optional)</Label>
            <Input
              id="pro-code-label"
              maxLength={80}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="e.g. October offer"
            />
          </div>
        </div>
        {selectedOwner?.status === "active" && selectedOwner.days_remaining > 0 && (
          <p className="mt-3 rounded-lg border border-gold/25 bg-gold/5 px-3 py-2 text-xs text-muted-foreground">
            This account already has {selectedOwner.days_remaining} Pro days. A new code adds its
            days after the existing entitlement; it does not replace it.
          </p>
        )}
        <div className="mt-4 flex justify-end">
          <Button onClick={() => void generateCode()} disabled={busy || !selectedOwner}>
            {busy ? (
              <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <KeyRound className="mr-2 h-4 w-4" />
            )}
            Generate assigned code
          </Button>
        </div>
        {newCode && (
          <div className="mt-4 rounded-xl border border-success/35 bg-success/5 p-4">
            <p className="text-sm font-semibold text-success">
              Code ready — send it only to {newCode.target_email}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {newCode.duration_days} Pro days · redeem by {formatDate(newCode.redeem_by)} · one
              account, one use
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <code className="rounded-md border border-border bg-background px-3 py-2 font-mono text-sm">
                {newCode.code}
              </code>
              <Button
                variant="secondary"
                size="sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(newCode.code);
                    toast.success("Code copied. Save it now; it cannot be displayed again.");
                  } catch {
                    toast.error("Clipboard access failed. Select and copy the code manually.");
                  }
                }}
              >
                <Copy className="mr-2 h-4 w-4" /> Copy code
              </Button>
            </div>
          </div>
        )}
      </section>

      <section className="mt-5 rounded-xl border border-border p-4">
        <h3 className="flex items-center gap-2 font-semibold">
          <Users className="h-4 w-4 text-gold" /> Customer accounts
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Remaining days are calculated from the server-side expiry. A direct grant starts or
          extends access immediately.
        </p>
        {owners.length ? (
          <div className="mt-3 space-y-2">
            {owners.map((owner) => (
              <div
                key={owner.gym_id}
                className="flex flex-col gap-3 rounded-lg border border-border bg-secondary/15 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{owner.owner_email}</p>
                  <p className="truncate text-xs text-muted-foreground">{owner.gym_name}</p>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                  <span
                    className={
                      owner.status === "active" && owner.days_remaining > 0
                        ? "text-success"
                        : "text-muted-foreground"
                    }
                  >
                    {owner.status === "active" && owner.days_remaining > 0
                      ? `Pro · ${owner.days_remaining} days`
                      : "Free"}
                  </span>
                  <span className="text-muted-foreground">
                    Expires {formatDate(owner.current_period_end)}
                  </span>
                  <span className="capitalize text-muted-foreground">{owner.source ?? "—"}</span>
                  {owner.status === "active" && owner.can_revoke_bonus ? (
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      onClick={() => setPendingAction({ kind: "revoke-pro", owner })}
                    >
                      <Ban className="mr-1.5 h-3.5 w-3.5" /> Revoke bonus access
                    </Button>
                  ) : owner.status === "active" ? (
                    <span className="text-muted-foreground">Manage in payment provider</span>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setOwnerId(owner.owner_id);
                        setPendingAction({ kind: "grant", owner });
                      }}
                    >
                      <BadgeCheck className="mr-1.5 h-3.5 w-3.5" /> Grant Pro
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 rounded-lg bg-secondary/20 p-3 text-sm text-muted-foreground">
            No registered gym-owner accounts found.
          </p>
        )}
      </section>

      <section className="mt-5 rounded-xl border border-border p-4">
        <div className="flex items-center gap-2 font-semibold">
          <Clock3 className="h-4 w-4 text-gold" /> Recent codes
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Codes are never stored in readable form. You can copy a new code only at the moment it is
          generated.
        </p>
        {codes.length ? (
          <div className="mt-3 space-y-2">
            {codes.map((code) => (
              <div
                key={code.code_id}
                className="flex flex-col gap-2 rounded-lg border border-border bg-secondary/15 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 text-sm">
                  <p className="font-medium">
                    {code.batch_label || "Recharge code"} · {code.duration_days} days
                  </p>
                  <p className="break-all text-xs text-muted-foreground">
                    Assigned: {code.assigned_owner || "First eligible account"} · Issued by:{" "}
                    {code.issued_by || "SQL Editor"} · {code.code_status}
                    {code.redeemed_by ? ` by ${code.redeemed_by}` : ""}
                    {code.revoked_by ? ` · revoked by ${code.revoked_by}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Redeem by {formatDate(code.redeem_by)}</span>
                  {code.code_status === "unused" && (
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      onClick={() => setPendingAction({ kind: "revoke-code", code })}
                    >
                      <Ban className="mr-1.5 h-3.5 w-3.5" /> Revoke code
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 rounded-lg bg-secondary/20 p-3 text-sm text-muted-foreground">
            No codes have been issued.
          </p>
        )}
      </section>

      <AlertDialog
        open={Boolean(pendingAction)}
        onOpenChange={(open) => !open && !busy && setPendingAction(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingAction?.kind === "grant"
                ? "Grant Pro access now?"
                : pendingAction?.kind === "revoke-pro"
                  ? "Revoke bonus Pro access?"
                  : "Revoke this unused code?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAction?.kind === "grant"
                ? `This immediately adds ${days || "0"} days to ${pendingAction.owner.owner_email}.`
                : pendingAction?.kind === "revoke-pro"
                  ? `This removes active manual/recharge access for ${pendingAction.owner.owner_email}. A separately paid provider subscription, if any, will remain active.`
                  : `This permanently blocks the unused code assigned to ${pendingAction?.kind === "revoke-code" ? pendingAction.code.assigned_owner || "the first eligible account" : ""}. It cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void performAction();
              }}
            >
              {busy && <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />}
              Confirm change
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  );
}
