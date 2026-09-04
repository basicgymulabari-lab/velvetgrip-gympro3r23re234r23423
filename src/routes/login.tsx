import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Dumbbell, Loader2, Lock, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  completeCloudLogin,
  getState,
  isLoggedIn,
  login,
  receptionistLoginIssue,
} from "@/lib/gym/store";
import { signInWithGoogle } from "@/lib/gym/cloud";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Staff Sign In — IRONVAULT Gym Management" },
      {
        name: "description",
        content:
          "Secure offline admin sign in for the IRONVAULT gym management suite: members, memberships, payments and inventory.",
      },
      { property: "og:title", content: "Admin Sign In — IRONVAULT Gym Management" },
      {
        property: "og:description",
        content: "Secure offline admin sign in for the IRONVAULT gym management suite.",
      },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const finishSignIn = async () => {
      if (isLoggedIn()) {
        navigate({ to: "/" });
        return;
      }
      try {
        const connected = await completeCloudLogin();
        if (active && connected) navigate({ to: "/" });
      } catch (cloudError) {
        console.error(cloudError);
        if (active) setError("Cloud sign-in completed, but the workspace could not be loaded.");
      }
    };
    void finishSignIn();
    return () => {
      active = false;
    };
  }, [navigate]);

  const googleSignIn = async () => {
    setError("");
    setBusy(true);
    const { error: oauthError } = await signInWithGoogle();
    if (oauthError) {
      setError(oauthError.message);
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!email.trim() || password.length < 4) {
      setError("Enter a valid email and password (min 4 characters).");
      return;
    }
    if (email.trim().toLowerCase() === getState().auth.email.toLowerCase()) {
      setError("Gym owners must use Continue with Google.");
      return;
    }
    setBusy(true);
    const ok = await login(email, password);
    setBusy(false);
    if (ok) navigate({ to: "/" });
    else {
      const isAdminEmail = email.trim().toLowerCase() === getState().auth.email.toLowerCase();
      setError(
        isAdminEmail ? "Administrator password is incorrect." : await receptionistLoginIssue(email),
      );
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <div
        className="pointer-events-none absolute -left-40 -top-40 h-[420px] w-[420px] rounded-full opacity-25 blur-[120px]"
        style={{ background: "var(--gradient-gold)" }}
      />
      <div
        className="pointer-events-none absolute -bottom-52 -right-32 h-[460px] w-[460px] rounded-full opacity-15 blur-[130px]"
        style={{ background: "var(--gradient-gold)" }}
      />

      <div className="relative grid w-full max-w-5xl overflow-hidden rounded-3xl border border-border lg:grid-cols-2">
        <div className="hidden flex-col justify-between bg-[image:var(--gradient-surface)] p-10 lg:flex">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-xl bg-[image:var(--gradient-gold)] text-primary-foreground">
              <Dumbbell className="h-5 w-5" />
            </div>
            <p className="font-display text-2xl tracking-[0.22em] text-gradient-gold">IRONVAULT</p>
          </div>
          <div>
            <h2 className="font-display text-5xl leading-[1.05] tracking-wide">
              Run your gym like a<br />
              <span className="text-gradient-gold">premium brand.</span>
            </h2>
            <p className="mt-4 max-w-sm text-sm text-muted-foreground">
              Members, memberships, payments, inventory and reporting — all in one elegant, fully
              synchronized workspace, protected by your Google account.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-4 border-t border-border pt-6 text-center">
            {[
              ["Live", "Cloud sync"],
              ["1", "Secure backend"],
              ["2", "Staff roles"],
            ].map(([v, l]) => (
              <div key={l}>
                <p className="font-display text-2xl text-gold">{v}</p>
                <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{l}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col justify-center bg-card p-8 sm:p-10 lg:min-h-[560px]">
          <h1 className="font-display text-3xl tracking-wide">Staff Sign In</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Owners sign in with Google. Receptionists use their staff credentials.
          </p>

          <Button
            type="button"
            variant="secondary"
            className="mt-8 h-11 w-full border border-border font-semibold"
            disabled={busy}
            onClick={googleSignIn}
          >
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Continue with Google
          </Button>

          <div className="my-6 flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            Receptionist sign in
            <span className="h-px flex-1 bg-border" />
          </div>

          <form onSubmit={submit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email">Email address</Label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="email"
                  type="email"
                  className="pl-9"
                  value={email}
                  autoComplete="username"
                  placeholder="you@yourgym.com"
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="password"
                  type="password"
                  className="pl-9"
                  value={password}
                  autoComplete="current-password"
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                />
              </div>
            </div>

            {error && (
              <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" className="h-11 w-full text-base font-semibold" disabled={busy}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Sign in
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
