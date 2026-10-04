import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Archive, Download, LoaderCircle, MailPlus, RefreshCw, UserMinus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, Panel } from "@/components/app/Panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";

type Invite = {
  email: string;
  note: string;
  invited_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
};

type CustomerGym = {
  gym_id: string;
  gym_name: string;
  owner_id: string;
  owner_email: string;
  status: string;
  current_period_end: string | null;
  days_remaining: number;
};

function displayDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(new Date(value));
}

function inviteError(error: { message?: string } | null) {
  const message = error?.message ?? "";
  if (message.includes("PLATFORM_ADMIN_REQUIRED"))
    return "Your account is not authorized for the CEO Hub.";
  if (message.includes("INVALID_INVITE_EMAIL")) return "Enter a valid email address.";
  if (message.includes("ACCOUNT_ALREADY_EXISTS")) return "That email already has an account.";
  if (message.includes("INVITE_ALREADY_USED")) return "That invitation has already been used.";
  if (message.includes("INVITE_NOT_PENDING"))
    return "That invitation is already used or no longer exists.";
  return "The request could not be completed. Check your connection and try again.";
}

export function CeoOperations() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [gyms, setGyms] = useState<CustomerGym[]>([]);
  const [selectedGymId, setSelectedGymId] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [inviteResult, gymResult] = await Promise.all([
        supabase.rpc("platform_list_signup_invites"),
        supabase.rpc("platform_list_owners"),
      ]);
      if (inviteResult.error) throw inviteResult.error;
      if (gymResult.error) throw gymResult.error;
      setInvites((inviteResult.data ?? []) as Invite[]);
      const nextGyms = (gymResult.data ?? []) as CustomerGym[];
      setGyms(nextGyms);
      setSelectedGymId((current) =>
        nextGyms.some((gym) => gym.gym_id === current) ? current : (nextGyms[0]?.gym_id ?? ""),
      );
    } catch (error) {
      toast.error(inviteError(error as { message?: string }));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    try {
      const { error } = await supabase.rpc("platform_add_signup_invite", {
        p_email: email.trim(),
        p_note: note.trim(),
      });
      if (error) return toast.error(inviteError(error));
      setEmail("");
      setNote("");
      toast.success("Invitation added. They can now create one account with this email.");
      await refresh();
    } catch {
      toast.error("The invitation could not be saved. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const revokeInvite = async (invite: Invite) => {
    setBusy(true);
    try {
      const { error } = await supabase.rpc("platform_revoke_signup_invite", {
        p_email: invite.email,
      });
      if (error) return toast.error(inviteError(error));
      toast.success("Unused invitation removed. Existing accounts are not affected.");
      await refresh();
    } catch {
      toast.error("The invitation could not be removed. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const downloadGymBackup = async () => {
    if (!selectedGymId) return toast.error("There are no customer gyms to export.");
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("platform_export_gym_backup", {
        p_gym_id: selectedGymId,
      });
      if (error) return toast.error(inviteError(error));
      const backup = data as Json;
      const gym = gyms.find((item) => item.gym_id === selectedGymId);
      const file = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(file);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `ironvault-${(gym?.gym_name || "gym").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-backup-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success("Workspace backup downloaded.");
    } catch {
      toast.error("The backup could not be downloaded. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="CEO Hub"
        subtitle="Owner-only controls for customer access, subscriptions and workspace backups."
        actions={
          <Button
            type="button"
            variant="secondary"
            onClick={() => void refresh()}
            disabled={loading || busy}
          >
            {loading ? (
              <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Refresh
          </Button>
        }
      />

      <Panel
        title="Approve new gym owners"
        description="Only invited email addresses can create new accounts once the Supabase Auth hook is enabled."
      >
        <form
          onSubmit={addInvite}
          className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
        >
          <div className="space-y-2">
            <Label htmlFor="ceo-invite-email">Owner email</Label>
            <Input
              id="ceo-invite-email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="owner@example.com"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ceo-invite-note">Note (optional)</Label>
            <Input
              id="ceo-invite-note"
              maxLength={200}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="e.g. Friend's gym"
            />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? (
              <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <MailPlus className="mr-2 h-4 w-4" />
            )}
            Approve email
          </Button>
        </form>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          An invitation permits one new account for that email. Removing an unused invitation blocks
          its future sign-up; it does not disable accounts that already exist.
        </p>
        <div className="mt-5 space-y-2">
          {invites.length ? (
            invites.map((invite) => (
              <div
                key={invite.email}
                className="flex flex-col gap-2 rounded-lg border border-border bg-secondary/15 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="break-all font-medium">{invite.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {invite.note || "No note"} · Added {displayDate(invite.invited_at)}
                  </p>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span
                    className={
                      invite.consumed_at || invite.revoked_at
                        ? "text-muted-foreground"
                        : "text-success"
                    }
                  >
                    {invite.consumed_at
                      ? `Used ${displayDate(invite.consumed_at)}`
                      : invite.revoked_at
                        ? `Revoked ${displayDate(invite.revoked_at)}`
                        : "Pending"}
                  </span>
                  {!invite.consumed_at && !invite.revoked_at && (
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => void revokeInvite(invite)}
                    >
                      <UserMinus className="mr-1.5 h-3.5 w-3.5" /> Remove
                    </Button>
                  )}
                </div>
              </div>
            ))
          ) : (
            <p className="rounded-lg bg-secondary/20 p-3 text-sm text-muted-foreground">
              No invitations yet.
            </p>
          )}
        </div>
      </Panel>

      <Panel
        title="Customer workspace backup"
        description="Export one gym workspace's JSON data without accessing it through the customer account."
      >
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div className="space-y-2">
            <Label htmlFor="ceo-backup-gym">Customer gym</Label>
            <select
              id="ceo-backup-gym"
              value={selectedGymId}
              onChange={(event) => setSelectedGymId(event.target.value)}
              disabled={!gyms.length || busy}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {!gyms.length && <option value="">No customer gyms found</option>}
              {gyms.map((gym) => (
                <option key={gym.gym_id} value={gym.gym_id}>
                  {gym.gym_name} — {gym.owner_email}
                </option>
              ))}
            </select>
          </div>
          <Button
            type="button"
            onClick={() => void downloadGymBackup()}
            disabled={!selectedGymId || busy}
          >
            {busy ? (
              <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            Download backup
          </Button>
        </div>
        {selectedGymId &&
          (() => {
            const gym = gyms.find((item) => item.gym_id === selectedGymId);
            return (
              <p className="mt-3 text-xs text-muted-foreground">
                {gym?.status === "active"
                  ? `Pro · ${gym.days_remaining} days remaining`
                  : "Free plan"}{" "}
                · Entitlement through {displayDate(gym?.current_period_end ?? null)}
              </p>
            );
          })()}
        <div className="mt-4 flex items-start gap-3 rounded-lg border border-gold/25 bg-gold/5 p-3 text-xs leading-5 text-muted-foreground">
          <Archive className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
          This download includes the gym's workspace data as JSON. Private files referenced by the
          data (such as uploaded images) are not bundled. Keep customer backups encrypted and share
          them only with the gym owner.
        </div>
      </Panel>
    </div>
  );
}
