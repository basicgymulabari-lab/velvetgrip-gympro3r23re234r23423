import { useEffect, useState } from "react";
import { createFileRoute, Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { Dumbbell, LoaderCircle, LogOut, ShieldAlert } from "lucide-react";
import { PlatformProManager } from "@/components/app/PlatformProManager";
import { CeoOperations } from "@/components/app/CeoOperations";
import { Button } from "@/components/ui/button";
import { isSupabaseConfigured, supabase } from "@/integrations/supabase/client";

type AccessState = "checking" | "allowed" | "signed-out" | "denied" | "unavailable";

export const Route = createFileRoute("/ceo")({
  head: () => ({
    meta: [
      { title: "CEO Hub — IRONVAULT" },
      { name: "robots", content: "noindex, nofollow" },
      { name: "description", content: "Private platform-owner controls for IRONVAULT." },
    ],
  }),
  component: CeoPage,
});

function CeoPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [access, setAccess] = useState<AccessState>("checking");
  const [checking, setChecking] = useState(false);

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

  const signOut = async () => {
    setChecking(true);
    try {
      await supabase.auth.signOut();
    } finally {
      await navigate({ to: "/login", replace: true });
      setChecking(false);
    }
  };

  // The demo is a child URL but a distinct, public sample-only experience.
  if (location.pathname === "/ceo/demo") return <Outlet />;

  if (access !== "allowed") {
    const title =
      access === "signed-out"
        ? "Sign in to continue"
        : access === "denied"
          ? "CEO access required"
          : access === "unavailable"
            ? "Cloud access unavailable"
            : "Checking platform access";
    const description =
      access === "signed-out"
        ? "Use the platform-owner account to open this private area. A gym owner or receptionist account is not enough."
        : access === "denied"
          ? "This account is not enabled as a platform administrator. The backend has denied access to customer controls."
          : access === "unavailable"
            ? "Could not verify CEO access with Supabase. Check the connection and confirm the database migrations are applied."
            : "Verifying your signed-in account with the server.";

    return (
      <main className="grid min-h-screen place-items-center bg-background px-4 py-10">
        <section className="surface-panel w-full max-w-lg rounded-2xl border border-border p-6 sm:p-8">
          <div className="flex items-center gap-3 text-gold">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-gold/15">
              <Dumbbell className="h-6 w-6" />
            </span>
            <div>
              <p className="font-display text-lg tracking-[0.18em]">IRONVAULT</p>
              <p className="text-xs text-muted-foreground">Platform Owner Console</p>
            </div>
          </div>
          <div className="mt-8 flex items-start gap-3">
            {access === "checking" ? (
              <LoaderCircle className="mt-0.5 h-5 w-5 animate-spin text-gold" />
            ) : (
              <ShieldAlert className="mt-0.5 h-5 w-5 text-gold" />
            )}
            <div>
              <h1 className="font-display text-2xl">{title}</h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
            </div>
          </div>
          <div className="mt-6 flex flex-wrap gap-2">
            {access === "signed-out" && (
              <>
                <Button asChild>
                  <Link to="/login">Platform owner sign in</Link>
                </Button>
                <Button asChild variant="secondary">
                  <a href="/ceo/demo">Explore demo</a>
                </Button>
              </>
            )}
            {(access === "unavailable" || access === "checking") && (
              <Button type="button" onClick={() => void checkAccess()} disabled={checking}>
                <RefreshLabel checking={checking} />
              </Button>
            )}
            {access === "denied" && (
              <Button
                variant="secondary"
                type="button"
                onClick={() => void signOut()}
                disabled={checking}
              >
                <LogOut className="mr-2 h-4 w-4" /> Sign out
              </Button>
            )}
            <Button asChild variant="secondary">
              <Link to="/">Return to gym app</Link>
            </Button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
          <div className="flex items-center gap-3 text-gold">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-gold/15">
              <Dumbbell className="h-5 w-5" />
            </span>
            <div>
              <p className="font-display tracking-[0.18em]">IRONVAULT</p>
              <p className="text-xs text-muted-foreground">Platform Owner Console</p>
            </div>
          </div>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void signOut()}
            disabled={checking}
          >
            <LogOut className="mr-2 h-4 w-4" /> Sign out
          </Button>
        </header>
        <CeoOperations />
        <div className="mt-6">
          <PlatformProManager />
        </div>
        <footer className="mt-8 border-t border-border pt-4 text-xs leading-5 text-muted-foreground">
          Privileged operations are checked by Supabase on every request. Do not share this account.
          Customer gym users cannot access this console or its data.
        </footer>
      </div>
    </main>
  );
}

function RefreshLabel({ checking }: { checking: boolean }) {
  return <>{checking ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}Try again</>;
}
