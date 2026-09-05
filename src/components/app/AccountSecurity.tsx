import { useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export function AccountSecurity() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const lock = useRef(false);
  async function perform(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to update your account. Try again.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border p-4">
        <div>
          <p className="font-medium">Account password</p>
          <p className="text-sm text-muted-foreground">
            Change your email sign-in password or request a reset link.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            setCurrent("");
            setPassword("");
            setConfirm("");
            setError("");
            setMessage("");
            setOpen(true);
          }}
        >
          Manage password
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Manage account password</DialogTitle>
            <DialogDescription>
              Google passwords are managed by Google. To add an email password to your Google
              account, use the reset email option below.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                if (password.length < 12) throw new Error("Use at least 12 characters.");
                if (password !== confirm) throw new Error("The passwords do not match.");
                if (password === current) throw new Error("Choose a different password.");
                const { data, error: identityError } = await supabase.auth.getUser();
                if (identityError || !data.user?.email)
                  throw new Error("Sign in again to manage your password.");
                const { error: verifyError } = await supabase.auth.signInWithPassword({
                  email: data.user.email,
                  password: current,
                });
                if (verifyError)
                  throw new Error(
                    "Current password could not be verified. Use a reset email if you sign in with Google.",
                  );
                const { error: updateError } = await supabase.auth.updateUser({ password });
                if (updateError) throw updateError;
                setCurrent("");
                setPassword("");
                setConfirm("");
                setMessage("Your account password has been updated.");
              });
            }}
          >
            <fieldset disabled={busy} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="cloud-current">Current password</Label>
                <Input
                  id="cloud-current"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cloud-new">New password</Label>
                <Input
                  id="cloud-new"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cloud-confirm">Confirm new password</Label>
                <Input
                  id="cloud-confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </div>
              <Button type="submit" className="w-full">
                {busy ? "Please wait…" : "Change password"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                onClick={() =>
                  void perform(async () => {
                    const { data, error } = await supabase.auth.getUser();
                    if (error || !data.user?.email)
                      throw new Error("Sign in again to request a reset email.");
                    const result = await supabase.auth.resetPasswordForEmail(data.user.email, {
                      redirectTo: `${window.location.origin}/login`,
                    });
                    if (result.error) throw result.error;
                    setMessage("Password reset email requested. Check your inbox and spam folder.");
                  })
                }
              >
                Forgot password? Send reset email
              </Button>
            </fieldset>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {message && (
              <p role="status" className="text-sm text-primary">
                {message}
              </p>
            )}
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
