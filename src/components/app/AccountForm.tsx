import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { isSupabaseConfigured, supabase } from "@/integrations/supabase/client";
import { completeCloudLogin, getCurrentSession, logoutSecurely } from "@/lib/gym/store";
import { signInWithGoogle } from "@/lib/gym/cloud";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Mode = "signin" | "signup" | "forgot" | "reset";
export function AccountForm() {
  const cloudAuthAvailable = isSupabaseConfigured();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("signin");
  const [staff, setStaff] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [name, setName] = useState("");
  const [gym, setGym] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [recoverySession, setRecoverySession] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [restoreFailed, setRestoreFailed] = useState(false);
  const lock = useRef(false);
  const recovering = useRef(false);
  useEffect(() => {
    let active = true;
    setChecking(true);
    setRestoreFailed(false);
    // Remove the old development-only fake account and its cached sample data.
    try {
      window.sessionStorage.removeItem("ironvault.local-demo-session");
      window.localStorage.removeItem("ironvault.local-demo-state");
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    recovering.current =
      fragment.get("type") === "recovery" ||
      sessionStorage.getItem("ironvault.recovery") === "true";
    if (recovering.current) {
      setMode("reset");
      sessionStorage.setItem("ironvault.recovery", "true");
    }
    if (fragment.has("error")) {
      setError("This link is invalid or expired. Please request a new link.");
      window.history.replaceState(null, "", window.location.pathname);
    }
    if (!cloudAuthAvailable) {
      // Local clones do not contain Supabase credentials. The development
      // owner/receptionist login below still works without cloud auth.
      setChecking(false);
      return () => {
        active = false;
      };
    }
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") {
        recovering.current = true;
        sessionStorage.setItem("ironvault.recovery", "true");
        if (active) {
          setMode("reset");
          setRecoverySession(Boolean(session));
          setChecking(false);
        }
      }
    });
    void (async () => {
      let sessionLoaded = false;
      try {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        sessionLoaded = true;
        if (!active) return;
        if (recovering.current) {
          setRecoverySession(Boolean(data.session));
          if (!data.session) setError("Your reset link has expired. Request a new reset email.");
        } else if (data.session && (await completeCloudLogin()) && active)
          await navigate({ to: "/", replace: true });
      } catch (err) {
        if (active) {
          // Do not swallow the distinction between a stale auth session and a
          // workspace/API failure: they have different recovery paths.
          console.error("[Auth] Could not restore the saved sign-in", err);
          setRestoreFailed(true);
          setError(
            sessionLoaded
              ? "Your sign-in is valid, but we could not load your gym workspace. Check your connection and try again."
              : "We could not restore your saved sign-in. Your session may have expired or the connection was interrupted.",
          );
        }
      } finally {
        if (active) setChecking(false);
      }
    })();
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [cloudAuthAvailable, navigate, restoreAttempt]);
  function switchMode(next: Mode) {
    setMode(next);
    setPassword("");
    setConfirm("");
    setError("");
    setNotice("");
    setVisible(false);
  }
  async function run(action: () => Promise<void>) {
    if (lock.current || checking) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await run(async () => {
      const normalized = email.trim().toLowerCase();
      if (mode === "forgot") {
        if (!cloudAuthAvailable && staff) {
          setNotice(
            "Ask the gym owner to reset the receptionist password in Settings → Staff Access.",
          );
          return;
        }
        if (!cloudAuthAvailable)
          throw new Error(
            "Account recovery is temporarily unavailable because the authentication service is not configured.",
          );
        const { error } = await supabase.auth.resetPasswordForEmail(normalized, {
          redirectTo: `${window.location.origin}/login`,
        });
        if (error) throw error;
        setNotice(
          "If this email has an account, a reset link will arrive shortly. Check your spam folder too.",
        );
        return;
      }
      if (mode === "signup" || mode === "reset") {
        if (password.length < 12) throw new Error("Use at least 12 characters for your password.");
        if (password !== confirm) throw new Error("The passwords do not match.");
      }
      if (mode === "reset") {
        if (!cloudAuthAvailable)
          throw new Error("Password reset is not configured for this deployment.");
        if (!recoverySession)
          throw new Error("Request a new reset link before changing your password.");
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        sessionStorage.removeItem("ironvault.recovery");
        recovering.current = false;
        setPassword("");
        setConfirm("");
        setRecoverySession(false);
        const { error: signOutError } = await supabase.auth.signOut({ scope: "local" });
        if (signOutError) throw signOutError;
        switchMode("signin");
        setNotice("Password updated. Sign in with your new password.");
        return;
      }
      if (mode === "signup") {
        if (!cloudAuthAvailable)
          throw new Error(
            "Account creation is unavailable because the authentication service is not configured.",
          );
        if (!name.trim() || !gym.trim()) throw new Error("Enter your name and gym name.");
        const { data, error } = await supabase.auth.signUp({
          email: normalized,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/login`,
            data: { full_name: name.trim(), gym_name: gym.trim() },
          },
        });
        if (error) throw error;
        setPassword("");
        setConfirm("");
        if (!data.session) {
          setNotice(
            "Check your email to confirm your account. If you already have an account, sign in or reset your password.",
          );
          return;
        }
      } else {
        if (!cloudAuthAvailable)
          throw new Error(
            "Authentication is not configured for this build. Connect the production authentication service before deployment.",
          );
        const { error } = await supabase.auth.signInWithPassword({ email: normalized, password });
        if (error)
          throw new Error(
            "Unable to sign in. Check your email and password, confirm your email, or choose Forgot password.",
          );
      }
      if (!(await completeCloudLogin()))
        throw new Error("Your session could not be loaded. Please try again.");
      const verified = getCurrentSession();
      const expectedRole = staff ? "receptionist" : "admin";
      if (!verified || verified.role !== expectedRole) {
        await logoutSecurely().catch(() => undefined);
        throw new Error(
          staff
            ? "This account is not an active receptionist account for a gym."
            : "This account is a staff account. Choose Receptionist to sign in.",
        );
      }
      await navigate({ to: "/", replace: true });
    });
  }
  const title =
    mode === "signup"
      ? "Create your account"
      : mode === "forgot"
        ? "Forgot password?"
        : mode === "reset"
          ? "Set a new password"
          : "Welcome back";
  const field = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
    type = "text",
    autoComplete = "off",
  ) => (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        required
        type={type}
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => set(e.target.value)}
      />
    </div>
  );
  return (
    <div className="w-full space-y-5">
      <div>
        <h1 className="font-display text-3xl tracking-wide">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {mode === "signup"
            ? "Create an owner account with your own empty gym workspace."
            : "Sign in to your gym workspace."}
        </p>
      </div>
      {mode === "signin" && (
        <div className="grid grid-cols-2 gap-2">
          {[false, true].map((value) => (
            <Button
              key={String(value)}
              type="button"
              variant={staff === value ? "default" : "secondary"}
              aria-pressed={staff === value}
              disabled={busy || checking}
              onClick={() => {
                setStaff(value);
                setError("");
                setPassword("");
              }}
            >
              {value ? "Receptionist" : "Gym owner"}
            </Button>
          ))}
        </div>
      )}
      {!staff && cloudAuthAvailable && (mode === "signin" || mode === "signup") && (
        <>
          <Button
            type="button"
            variant="secondary"
            className="h-11 w-full"
            disabled={busy || checking}
            onClick={() =>
              void run(async () => {
                const { error } = await signInWithGoogle();
                if (error) throw error;
              })
            }
          >
            Continue with Google
          </Button>
          <p className="text-center text-xs text-muted-foreground">or continue with email</p>
        </>
      )}
      <form onSubmit={submit}>
        <fieldset disabled={busy || checking} className="space-y-4">
          {mode === "signup" && (
            <>
              {field("owner-name", "Your name", name, setName, "text", "name")}
              {field("gym-name", "Gym name", gym, setGym, "text", "organization")}
            </>
          )}
          {mode !== "reset" &&
            field("account-email", "Email address", email, setEmail, "email", "email")}
          {mode !== "forgot" && (
            <div className="space-y-2">
              <Label htmlFor="account-password">
                {mode === "reset" ? "New password" : "Password"}
              </Label>
              <div className="relative">
                <Input
                  id="account-password"
                  required
                  type={visible ? "text" : "password"}
                  minLength={mode === "signin" ? 1 : 12}
                  className="pr-12"
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  aria-label={visible ? "Hide password" : "Show password"}
                  aria-pressed={visible}
                  className="absolute right-1 top-0 grid h-9 w-10 place-items-center rounded focus-visible:ring-2 focus-visible:ring-primary"
                  onClick={() => setVisible(!visible)}
                >
                  {visible ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {mode !== "signin" && (
                <p className="text-xs text-muted-foreground">At least 12 characters.</p>
              )}
            </div>
          )}
          {(mode === "signup" || mode === "reset") &&
            field(
              "confirm-password",
              "Confirm password",
              confirm,
              setConfirm,
              visible ? "text" : "password",
              "new-password",
            )}
          {mode === "signin" && (
            <button
              type="button"
              className="text-sm text-primary hover:underline"
              onClick={() => switchMode("forgot")}
            >
              Forgot password?
            </button>
          )}
          {error && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {error}
            </p>
          )}
          {restoreFailed && (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={busy || checking}
                onClick={() => {
                  setError("");
                  setRestoreAttempt((attempt) => attempt + 1);
                }}
              >
                Try again
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy || checking}
                onClick={() =>
                  void run(async () => {
                    const { error } = await supabase.auth.signOut({ scope: "local" });
                    if (error) throw error;
                    setRestoreFailed(false);
                    setError("");
                    setNotice("Saved sign-in cleared. Sign in again with your email and password.");
                  })
                }
              >
                Clear saved sign-in
              </Button>
            </div>
          )}
          {notice && (
            <p
              role="status"
              className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm"
            >
              {notice}
            </p>
          )}
          <Button
            type="submit"
            disabled={mode === "reset" && !recoverySession}
            className="h-11 w-full"
          >
            {(busy || checking) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {checking
              ? "Checking your session…"
              : busy
                ? "Please wait…"
                : mode === "signup"
                  ? "Create account"
                  : mode === "forgot"
                    ? staff
                      ? "Show recovery steps"
                      : "Send reset link"
                    : mode === "reset"
                      ? "Save new password"
                      : "Sign in"}
          </Button>
        </fieldset>
      </form>
      {mode !== "reset" && (
        <button
          type="button"
          disabled={busy || checking}
          className="w-full text-sm text-primary hover:underline"
          onClick={() => {
            setStaff(false);
            switchMode(mode === "signin" ? "signup" : "signin");
          }}
        >
          {mode === "signin" ? "New here? Sign up" : "Already have an account? Sign in"}
        </button>
      )}
      {mode === "signin" && !cloudAuthAvailable && import.meta.env.DEV && (
        <p className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs text-muted-foreground">
          Supabase authentication is not configured for this local build. Connect the authentication
          service to sign in or create an account.
        </p>
      )}
      {mode === "reset" && !recoverySession && (
        <Button
          variant="secondary"
          onClick={() => {
            recovering.current = false;
            sessionStorage.removeItem("ironvault.recovery");
            switchMode("forgot");
          }}
        >
          Request a new link
        </Button>
      )}
    </div>
  );
}
