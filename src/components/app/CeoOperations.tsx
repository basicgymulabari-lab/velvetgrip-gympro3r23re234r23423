import { useCallback, useEffect, useState, type FormEvent } from "react";
import { LoaderCircle, MailPlus, RefreshCw, UserMinus } from "lucide-react";
import { toast } from "sonner";
import { Panel } from "@/components/app/Panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { supabase } from "@/integrations/supabase/client";
import { usePlatformLiveUpdates } from "@/components/app/platform-live-updates-context";

type Invite = {
  email: string;
  gym_name: string;
  note: string;
  invited_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
};

type InviteFilter = "all" | "pending" | "used" | "revoked";

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
  const { revision } = usePlatformLiveUpdates();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [email, setEmail] = useState("");
  const [gymName, setGymName] = useState("");
  const [note, setNote] = useState("");
  const [pendingInvite, setPendingInvite] = useState<Invite | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [inviteFilter, setInviteFilter] = useState<InviteFilter>("all");
  const filteredInvites = invites.filter((invite) => {
    if (inviteFilter === "pending") return !invite.consumed_at && !invite.revoked_at;
    if (inviteFilter === "used") return Boolean(invite.consumed_at);
    if (inviteFilter === "revoked") return Boolean(invite.revoked_at) && !invite.consumed_at;
    return true;
  });
  const pendingCount = invites.filter((invite) => !invite.consumed_at && !invite.revoked_at).length;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const inviteResult = await supabase.rpc("platform_list_gym_invites");
      if (inviteResult.error) throw inviteResult.error;
      setInvites((inviteResult.data ?? []) as Invite[]);
    } catch (error) {
      toast.error(inviteError(error as { message?: string }));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, revision]);

  const addInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    try {
      const { error } = await supabase.rpc("platform_invite_gym_owner", {
        p_email: email.trim(),
        p_gym_name: gymName.trim(),
        p_note: note.trim(),
      });
      if (error) return toast.error(inviteError(error));
      setEmail("");
      setGymName("");
      setNote("");
      toast.success("Invitation added. They can now create one account with this email.");
      await refresh();
    } catch {
      toast.error("The invitation could not be saved. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const revokeInvite = async () => {
    if (!pendingInvite) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc("platform_revoke_signup_invite", {
        p_email: pendingInvite.email,
      });
      if (error) return toast.error(inviteError(error));
      setPendingInvite(null);
      toast.success("Unused invitation removed. Existing accounts are not affected.");
      await refresh();
    } catch {
      toast.error("The invitation could not be removed. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <Panel
        title="Create a gym invitation"
        description="Reserve a gym name and allow one matching email to create its owner account."
        collapsible
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
            Refresh invites
          </Button>
        }
      >
        <form
          onSubmit={addInvite}
          className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
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
            <Label htmlFor="ceo-invite-gym">Gym / business name</Label>
            <Input
              id="ceo-invite-gym"
              required
              minLength={2}
              maxLength={120}
              value={gymName}
              onChange={(event) => setGymName(event.target.value)}
              placeholder="e.g. Northstar Fitness"
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
            Invite owner
          </Button>
        </form>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          An invitation permits one new account for that email. Removing an unused invitation blocks
          its future sign-up; it does not disable accounts that already exist.
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Show</span>
            <select
              className="h-9 rounded-md border border-input bg-background px-3"
              value={inviteFilter}
              onChange={(event) => setInviteFilter(event.target.value as InviteFilter)}
            >
              <option value="all">All invitations</option>
              <option value="pending">Pending</option>
              <option value="used">Used</option>
              <option value="revoked">Revoked</option>
            </select>
          </label>
          <p className="text-xs text-muted-foreground">
            {invites.length} total · {pendingCount} pending
          </p>
        </div>
        <div className="mt-3 space-y-2">
          {filteredInvites.length ? (
            filteredInvites.map((invite) => (
              <div
                key={invite.email}
                className="flex flex-col gap-2 rounded-lg border border-border bg-secondary/15 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="break-all font-medium">{invite.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {invite.gym_name || "Gym name not assigned"} · {invite.note || "No note"} ·
                    Added {displayDate(invite.invited_at)}
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
                      onClick={() => setPendingInvite(invite)}
                    >
                      <UserMinus className="mr-1.5 h-3.5 w-3.5" /> Remove
                    </Button>
                  )}
                </div>
              </div>
            ))
          ) : (
            <p className="rounded-lg bg-secondary/20 p-3 text-sm text-muted-foreground">
              {invites.length === 0 ? "No invitations yet." : `No ${inviteFilter} invitations.`}
            </p>
          )}
        </div>
      </Panel>
      <AlertDialog
        open={Boolean(pendingInvite)}
        onOpenChange={(open) => !open && setPendingInvite(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this gym invitation?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingInvite?.email} will no longer be able to create an account using this
              invitation. Existing accounts are not affected; you can issue a new invitation later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep invitation</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void revokeInvite();
              }}
            >
              {busy ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
              Revoke invitation
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
