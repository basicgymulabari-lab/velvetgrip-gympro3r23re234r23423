import { useEffect, useState, type FormEvent } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  BarChart3,
  Building2,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LogOut,
  Mail,
  ShieldAlert,
  ShieldCheck,
  Users,
} from "lucide-react";
import { PlatformProManager } from "@/components/app/PlatformProManager";
import { CeoOperations } from "@/components/app/CeoOperations";
import { CeoControlCenter } from "@/components/app/CeoControlCenter";
import {
  PlatformLiveStatus,
  PlatformLiveUpdatesProvider,
} from "@/components/app/PlatformLiveUpdates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isSupabaseConfigured, supabase } from "@/integrations/supabase/client";

type AccessState = "checking" | "allowed" | "signed-out" | "denied" | "unavailable";
type ConsoleSection = "dashboard" | "invites" | "subscriptions";

export const Route = createFileRoute("/ceo")({
  head: () => ({
    meta: [
      { title: "IRONVAULT Platform — CEO Console" },
      { name: "robots", content: "noindex, nofollow" },
      { name: "description", content: "Private platform-administration console for IRONVAULT." },
    ],
  }),
  component: CeoPage,
});

function CeoPage() {
  const [access, setAccess] = useState<AccessState>("checking");
  const [checking, setChecking] = useState(false);
  const [section, setSection] = useState<ConsoleSection>("dashboard");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");

  const checkAccess = async () => {
    if (!isSupabaseConfigured()) {
      setAccess("unavailable");
      return;
    }
    setChecking(true);
    try {
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData.user) {
        setAccess("signed-out");
        return;
      }
      const { data, error } = await supabase.rpc("iv_is_platform_admin");
      if (error) {
        setAccess("unavailable");
        return;
      }
      setAccess(data === true ? "allowed" : "denied");
    } catch {
      setAccess("unavailable");
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void checkAccess();
  }, []);

  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (checking) return;
    if (!isSupabaseConfigured()) {
      setFormError(
        "CEO sign-in is unavailable because the cloud authentication service is not configured.",
      );
      return;
    }
    setChecking(true);
    setFormError("");
    setNotice("");
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (error) throw new Error("Sign-in failed. Check the email and password, then try again.");

      const { data, error: authorizationError } = await supabase.rpc("iv_is_platform_admin");
      if (authorizationError) {
        await supabase.auth.signOut({ scope: "local" });
        setAccess("unavailable");
        throw new Error("The platform-admin permission could not be verified. Please retry.");
      }
      if (data !== true) {
        await supabase.auth.signOut({ scope: "local" });
        setAccess("denied");
        throw new Error("This account is not authorized for platform administration.");
      }

      setPassword("");
      setFormError("");
      setAccess("allowed");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Sign-in could not be completed.");
    } finally {
      setChecking(false);
    }
  };

  const sendResetLink = async () => {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      setFormError("Enter the platform-owner email first.");
      return;
    }
    if (!isSupabaseConfigured()) {
      setFormError(
        "Password recovery is unavailable because cloud authentication is not configured.",
      );
      return;
    }
    setChecking(true);
    setFormError("");
    setNotice("");
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
        redirectTo: `${window.location.origin}/login`,
      });
      if (error) throw error;
      setNotice(
        "If this platform-owner account exists, a password-reset link will arrive by email.",
      );
    } catch {
      setFormError("A reset link could not be requested. Check the email and try again.");
    } finally {
      setChecking(false);
    }
  };

  const signOut = async () => {
    setChecking(true);
    try {
      await supabase.auth.signOut({ scope: "local" });
    } finally {
      setPassword("");
      setAccess("signed-out");
      setChecking(false);
    }
  };

  if (access !== "allowed") {
    const unavailable = access === "unavailable";
    const denied = access === "denied";
    const checkingAccess = access === "checking";

    return (
      <main className="min-h-screen bg-background px-4 py-8 sm:px-6 lg:grid lg:place-items-center lg:py-12">
        <div className="mx-auto grid w-full max-w-6xl overflow-hidden rounded-3xl border border-border bg-card shadow-2xl lg:grid-cols-[0.9fr_1.1fr]">
          <section className="flex min-h-[260px] flex-col justify-between bg-[image:var(--gradient-surface)] p-6 sm:p-10 lg:min-h-[660px]">
            <Link to="/ceo" className="flex w-fit items-center gap-3 text-gold">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-gold/15">
                <ShieldCheck className="h-6 w-6" />
              </span>
              <span>
                <span className="block font-display text-lg tracking-[0.16em]">IRONVAULT</span>
                <span className="block text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                  Platform administration
                </span>
              </span>
            </Link>

            <div className="mt-10 max-w-lg lg:mt-0">
              <p className="text-xs uppercase tracking-[0.2em] text-gold">Company operations</p>
              <h1 className="mt-3 font-display text-4xl leading-tight sm:text-5xl">
                One console for every gym on the platform.
              </h1>
              <p className="mt-4 max-w-md text-sm leading-6 text-muted-foreground">
                Manage gym accounts, invitations, subscriptions, backups and platform activity
                without entering a gym’s member-management workspace.
              </p>
            </div>

            <div className="mt-8 grid gap-3 border-t border-border pt-5 text-sm text-muted-foreground sm:grid-cols-3 lg:mt-0">
              <span className="flex items-center gap-2">
                <Building2 className="h-4 w-4 text-gold" /> Gym accounts
              </span>
              <span className="flex items-center gap-2">
                <Users className="h-4 w-4 text-gold" /> Owner access
              </span>
              <span className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-gold" /> Platform status
              </span>
            </div>
          </section>

          <section className="flex items-center p-6 sm:p-10 lg:p-12">
            <div className="mx-auto w-full max-w-md">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-gold/30 bg-gold/10 text-gold">
                {checkingAccess ? (
                  <LoaderCircle className="h-5 w-5 animate-spin" />
                ) : (
                  <KeyRound className="h-5 w-5" />
                )}
              </div>
              <p className="mt-6 text-xs uppercase tracking-[0.18em] text-gold">Private console</p>
              <h2 className="mt-2 font-display text-3xl">
                {checkingAccess ? "Verifying access" : "CEO sign in"}
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {denied
                  ? "This account is not a platform administrator. Use the CEO account assigned by the platform owner."
                  : unavailable
                    ? "We could not verify platform access. Check your connection and try again."
                    : "Sign in with the invited platform-owner account. Gym-owner and receptionist access cannot open this console."}
              </p>

              {formError && (
                <div
                  role="alert"
                  className="mt-5 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
                >
                  {formError}
                </div>
              )}
              {notice && (
                <div
                  role="status"
                  className="mt-5 rounded-xl border border-success/30 bg-success/10 px-4 py-3 text-sm text-success"
                >
                  {notice}
                </div>
              )}

              {checkingAccess ? (
                <div className="mt-7 flex items-center gap-3 rounded-xl border border-border p-4 text-sm text-muted-foreground">
                  <LoaderCircle className="h-4 w-4 animate-spin text-gold" /> Checking your secure
                  platform permissions…
                </div>
              ) : (
                <form className="mt-7 space-y-5" onSubmit={(event) => void signIn(event)}>
                  <div className="space-y-2">
                    <Label htmlFor="ceo-email">Platform-owner email</Label>
                    <div className="relative">
                      <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="ceo-email"
                        className="pl-10"
                        type="email"
                        autoComplete="username"
                        maxLength={254}
                        required
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        placeholder="owner@yourcompany.com"
                        disabled={checking || !isSupabaseConfigured()}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ceo-password">Password</Label>
                    <div className="relative">
                      <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="ceo-password"
                        className="pr-11 pl-10"
                        type={showPassword ? "text" : "password"}
                        autoComplete="current-password"
                        required
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        disabled={checking || !isSupabaseConfigured()}
                      />
                      <button
                        type="button"
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        onClick={() => setShowPassword((value) => !value)}
                        aria-label={showPassword ? "Hide password" : "Show password"}
                        disabled={checking}
                      >
                        {showPassword ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                    <div className="flex justify-end">
                      <button
                        type="button"
                        className="text-sm text-gold hover:underline"
                        onClick={() => void sendResetLink()}
                        disabled={checking}
                      >
                        Forgot password?
                      </button>
                    </div>
                  </div>

                  <Button
                    className="w-full"
                    type="submit"
                    disabled={checking || !isSupabaseConfigured()}
                  >
                    {checking ? (
                      <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <ShieldCheck className="mr-2 h-4 w-4" />
                    )}
                    Sign in to CEO console
                    {!checking && <ArrowRight className="ml-2 h-4 w-4" />}
                  </Button>

                  {!isSupabaseConfigured() && (
                    <p className="text-sm text-destructive">
                      Cloud authentication is not configured in this deployment.
                    </p>
                  )}
                </form>
              )}

              <div className="mt-7 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5 text-sm">
                <Link className="text-muted-foreground hover:text-foreground" to="/login">
                  Gym workspace sign in
                </Link>
              </div>
              <p className="mt-5 flex items-start gap-2 text-xs leading-5 text-muted-foreground">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gold" />
                No CEO sign-up is available here. Platform access is checked by Supabase for every
                privileged action.
              </p>
              {unavailable && (
                <Button
                  className="mt-5 w-full"
                  type="button"
                  variant="secondary"
                  onClick={() => void checkAccess()}
                  disabled={checking}
                >
                  {checking ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}Retry
                  secure check
                </Button>
              )}
            </div>
          </section>
        </div>
      </main>
    );
  }

  const sections: { id: ConsoleSection; label: string; description: string }[] = [
    {
      id: "dashboard",
      label: "Dashboard & gyms",
      description: "Platform health, gym accounts, backups and audit",
    },
    { id: "invites", label: "Gym invitations", description: "Authorize new gym-owner accounts" },
    {
      id: "subscriptions",
      label: "Subscriptions & codes",
      description: "Manage Pro access and one-time codes",
    },
  ];

  return (
    <PlatformLiveUpdatesProvider>
      <main className="min-h-screen bg-background px-4 py-6 sm:px-6 lg:px-10">
        <div className="mx-auto max-w-7xl">
          <header className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-border pb-5">
            <div className="flex items-center gap-3 text-gold">
              <span className="grid h-11 w-11 place-items-center rounded-xl border border-gold/30 bg-gold/10">
                <ShieldCheck className="h-6 w-6" />
              </span>
              <div>
                <p className="font-display tracking-[0.18em]">IRONVAULT PLATFORM</p>
                <p className="text-xs text-muted-foreground">
                  CEO Control Center · Company operations
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <PlatformLiveStatus />
              <Button
                type="button"
                variant="secondary"
                onClick={() => void signOut()}
                disabled={checking}
              >
                <LogOut className="mr-2 h-4 w-4" /> Sign out
              </Button>
            </div>
          </header>

          <div className="mb-6 rounded-2xl border border-gold/20 bg-[image:var(--gradient-surface)] p-5 sm:p-7">
            <p className="text-xs uppercase tracking-[0.18em] text-gold">Platform administration</p>
            <h1 className="mt-2 font-display text-3xl sm:text-4xl">Company operations</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
              This is the separate operator console for all gym workspaces—not a gym’s
              member-management dashboard.
            </p>
          </div>

          <nav aria-label="Platform console sections" className="mb-6 grid gap-2 sm:grid-cols-3">
            {sections.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setSection(item.id)}
                aria-current={section === item.id ? "page" : undefined}
                className={`rounded-xl border p-4 text-left transition-colors ${section === item.id ? "border-gold/50 bg-gold/10" : "border-border bg-card hover:bg-secondary/30"}`}
              >
                <span
                  className={`font-medium ${section === item.id ? "text-gold" : "text-foreground"}`}
                >
                  {item.label}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">{item.description}</span>
              </button>
            ))}
          </nav>

          {section === "dashboard" && <CeoControlCenter />}
          {section === "invites" && <CeoOperations />}
          {section === "subscriptions" && <PlatformProManager />}

          <footer className="mt-8 border-t border-border pt-4 text-xs leading-5 text-muted-foreground">
            All company-level actions require a Supabase platform-admin role and are checked again
            by the database. This console does not expose gym members’ individual management
            screens.
          </footer>
        </div>
      </main>
    </PlatformLiveUpdatesProvider>
  );
}
