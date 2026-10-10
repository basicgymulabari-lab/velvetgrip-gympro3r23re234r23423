import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  LayoutDashboard,
  Users,
  BadgeCheck,
  Wallet,
  Package,
  Receipt,
  BarChart3,
  CircleHelp,
  Bell,
  Trash2,
  Settings as SettingsIcon,
  Menu,
  X,
  LogOut,
  Dumbbell,
  EllipsisVertical,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  getCurrentSession,
  logoutSecurely,
  refreshCloudWorkspaceIfNewer,
  useGym,
  validateCurrentSession,
} from "@/lib/gym/store";
import { toast } from "sonner";
import { isSupabaseConfigured, supabase } from "@/integrations/supabase/client";
import { NotificationBell } from "./NotificationBell";
import { GlobalSearch } from "./GlobalSearch";
import { APP_TOUR_REQUEST_KEY, OnboardingTour } from "./OnboardingTour";
import { SubscriptionPaywall } from "./SubscriptionPaywall";
import {
  localSubscriptionDaysRemaining,
  refreshSubscription,
  SUBSCRIPTION_PAYWALL_EVENT,
  useSubscription,
  verifyStripeCheckout,
} from "@/lib/billing/client";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/members", label: "Members", icon: Users },
  { to: "/memberships", label: "Memberships", icon: BadgeCheck },
  { to: "/payments", label: "Payments", icon: Wallet },
  { to: "/products", label: "Products", icon: Package },
  { to: "/expenses", label: "Expenses", icon: Receipt },
  { to: "/reports", label: "Reports", icon: BarChart3 },
  { to: "/inquiries", label: "Inquiries", icon: CircleHelp },
  { to: "/notifications", label: "Notifications", icon: Bell },
  { to: "/trash", label: "Trash", icon: Trash2 },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
] as const;

const SIDEBAR_COLLAPSED_KEY = "ironvault.sidebar.collapsed";
const APP_TOUR_VERSION = "v1";
// Staff Access and account security live inside Settings, so Settings remains owner-only.
// Every operational area can be delegated individually by the owner.
const OWNER_ONLY_ROUTES = ["/settings"];
const RECEPTIONIST_ROUTE_PERMISSION = {
  "/": "dashboard",
  "/members": "members",
  "/memberships": "memberships",
  "/payments": "payments",
  "/products": "products",
  "/expenses": "expenses",
  "/reports": "reports",
  "/inquiries": "inquiries",
  "/notifications": "notifications",
  "/trash": "trash",
} as const;

export function AppShell({ children }: { children: ReactNode }) {
  const state = useGym();
  const subscription = useSubscription();
  const accessContext = getCurrentSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [desktopCollapsed, setDesktopCollapsed] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [paywallReason, setPaywallReason] = useState<"member-limit" | "manage">("manage");
  const tourAutoChecked = useRef(false);
  const billingAutoChecked = useRef(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const subscriptionDays = localSubscriptionDaysRemaining(subscription);

  useEffect(() => {
    // Supabase Auth is the only authentication source. A build without public
    // Supabase configuration cannot establish an application session.
    if (!isSupabaseConfigured()) return;
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT" && getCurrentSession()) {
        setSessionChecked(false);
        void navigate({ to: "/login", replace: true });
      }
    });
    return () => data.subscription.unsubscribe();
  }, [navigate]);

  useEffect(() => {
    const handleSyncError = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      toast.error(
        detail?.message ??
          "Your latest change could not be saved. Check your connection and retry.",
      );
    };
    window.addEventListener("ironvault:cloud-sync-error", handleSyncError);
    return () => window.removeEventListener("ironvault:cloud-sync-error", handleSyncError);
  }, []);

  useEffect(() => {
    let active = true;
    void validateCurrentSession()
      .then((valid) => {
        if (!active) return;
        if (valid) setSessionChecked(true);
        else void navigate({ to: "/login", replace: true });
      })
      .catch(() => {
        if (active) {
          toast.error("Could not verify your account. Please sign in again.");
          void navigate({ to: "/login", replace: true });
        }
      });
    return () => {
      active = false;
    };
  }, [navigate]);

  useEffect(() => {
    if (!sessionChecked) return;
    const refresh = () => {
      if (!navigator.onLine) return;
      void refreshCloudWorkspaceIfNewer().catch((error) => {
        console.warn("Could not refresh the gym workspace", error);
      });
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 30_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", handleVisibility);
    refresh();
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [sessionChecked]);

  useEffect(() => {
    if (!sessionChecked) return;
    setReady(false);
    const session = getCurrentSession();
    const permissionEntry = Object.entries(RECEPTIONIST_ROUTE_PERMISSION).find(([route]) =>
      route === "/" ? pathname === "/" : pathname === route || pathname.startsWith(`${route}/`),
    );
    const receptionistDenied =
      session?.role === "receptionist" &&
      permissionEntry &&
      !session.permissions?.[permissionEntry[1]];
    if (!session) {
      navigate({ to: "/login" });
    } else if (
      session.role === "receptionist" &&
      (OWNER_ONLY_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`)) ||
        receptionistDenied)
    ) {
      const firstAllowed =
        Object.entries(RECEPTIONIST_ROUTE_PERMISSION).find(
          ([, permission]) => session.permissions?.[permission],
        )?.[0] ?? "/login";
      navigate({ to: firstAllowed as "/" });
    } else {
      setReady(true);
    }
  }, [navigate, pathname, sessionChecked]);

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    setDesktopCollapsed(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true");
  }, []);

  const setSidebarCollapsed = (collapsed: boolean) => {
    setDesktopCollapsed(collapsed);
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const openPaywall = (event: Event) => {
      const detail = (event as CustomEvent<{ reason?: "member-limit" | "manage" }>).detail;
      setPaywallReason(detail?.reason === "member-limit" ? "member-limit" : "manage");
      setPaywallOpen(true);
    };
    window.addEventListener(SUBSCRIPTION_PAYWALL_EVENT, openPaywall);
    return () => window.removeEventListener(SUBSCRIPTION_PAYWALL_EVENT, openPaywall);
  }, []);

  useEffect(() => {
    if (!sessionChecked || !ready || !state || billingAutoChecked.current) return;
    const currentSession = getCurrentSession();
    if (!currentSession) return;
    billingAutoChecked.current = true;

    const url = new URL(window.location.href);
    const billing = url.searchParams.get("billing");
    const provider = url.searchParams.get("provider");
    const stripeSessionId = url.searchParams.get("session_id");

    const cleanBillingQuery = () => {
      if (!billing) return;
      url.searchParams.delete("billing");
      url.searchParams.delete("provider");
      url.searchParams.delete("session_id");
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
    };

    if (
      currentSession.role === "admin" &&
      billing === "success" &&
      provider === "stripe" &&
      stripeSessionId
    ) {
      void verifyStripeCheckout(stripeSessionId)
        .then((entitlement) => {
          if (entitlement.active)
            toast.success("IRONVAULT Pro is active. Your member limit is unlocked.");
          else toast.info("Payment received. Subscription activation is still being confirmed.");
        })
        .catch((error) => {
          toast.error(
            error instanceof Error ? error.message : "Could not verify the Stripe payment.",
          );
        })
        .finally(cleanBillingQuery);
      return;
    }

    if (billing === "cancelled") {
      toast.info("Subscription checkout was cancelled. No access changes were made.");
      cleanBillingQuery();
    }
    void refreshSubscription();
  }, [ready, sessionChecked, state]);

  useEffect(() => {
    if (!sessionChecked || !ready || !subscription.active || subscriptionDays > 7) return;
    const currentSession = getCurrentSession();
    if (currentSession?.role !== "admin") return;
    const today = new Date().toISOString().slice(0, 10);
    const key = `ironvault.subscription-expiry-warning.${today}`;
    if (window.sessionStorage.getItem(key) === "shown") return;
    window.sessionStorage.setItem(key, "shown");
    toast.warning(
      `IRONVAULT Pro expires in ${subscriptionDays} day${subscriptionDays === 1 ? "" : "s"}. Renew it to keep adding members beyond the free limit.`,
    );
  }, [ready, sessionChecked, subscription.active, subscriptionDays]);

  useEffect(() => {
    if (!sessionChecked || !ready || !state || tourAutoChecked.current) return;
    const currentSession = getCurrentSession();
    if (!currentSession) return;
    tourAutoChecked.current = true;
    const key = `ironvault.app-tour.${APP_TOUR_VERSION}.${currentSession.email.toLowerCase()}`;
    if (window.sessionStorage.getItem(APP_TOUR_REQUEST_KEY) === "true") {
      window.sessionStorage.removeItem(APP_TOUR_REQUEST_KEY);
      if (window.innerWidth >= 1024) setSidebarCollapsed(false);
      setTourOpen(true);
      return;
    }
    if (window.localStorage.getItem(key) !== "done") {
      const timer = window.setTimeout(() => {
        if (window.innerWidth >= 1024) setSidebarCollapsed(false);
        setTourOpen(true);
      }, 450);
      return () => window.clearTimeout(timer);
    }
  }, [ready, sessionChecked, state]);

  if (!sessionChecked || !ready || !state) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Dumbbell className="h-5 w-5 animate-pulse text-gold" />
          <span className="text-sm tracking-widest uppercase">Loading workspace…</span>
        </div>
      </div>
    );
  }

  const session = getCurrentSession();
  if (!session) return null;
  const dismissTour = () => {
    const key = `ironvault.app-tour.${APP_TOUR_VERSION}.${session.email.toLowerCase()}`;
    window.localStorage.setItem(key, "done");
    setTourOpen(false);
  };
  const visibleNav =
    session.role === "receptionist"
      ? NAV.filter(({ to }) => {
          if (OWNER_ONLY_ROUTES.includes(to)) return false;
          const permission =
            RECEPTIONIST_ROUTE_PERMISSION[to as keyof typeof RECEPTIONIST_ROUTE_PERMISSION];
          return permission ? session.permissions?.[permission] : false;
        })
      : NAV;

  return (
    <div className="min-h-screen bg-background">
      {session.role === "admin" && <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />}
      <OnboardingTour open={tourOpen} onDismiss={dismissTour} />
      <SubscriptionPaywall
        open={paywallOpen}
        onOpenChange={setPaywallOpen}
        reason={paywallReason}
        canPurchase={session.role === "admin"}
      />

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-[264px] border-r border-sidebar-border bg-sidebar transition-transform duration-300",
          open ? "translate-x-0" : "-translate-x-full",
          desktopCollapsed ? "lg:-translate-x-full" : "lg:translate-x-0",
        )}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-3 px-5 py-6">
            <button
              type="button"
              data-tour="sidebar-brand"
              className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/70"
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              onClick={() => {
                if (window.innerWidth >= 1024) setSidebarCollapsed(true);
                else setOpen(false);
              }}
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[image:var(--gradient-gold)] text-primary-foreground">
                <Dumbbell className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <span className="block truncate font-display text-xl leading-none tracking-[0.18em] text-gradient-gold">
                  {state.settings.gymName}
                </span>
                <span className="mt-1 block truncate text-[10px] tracking-[0.22em] uppercase text-muted-foreground">
                  Management Suite
                </span>
              </span>
            </button>
            <button
              className="ml-auto rounded-md p-1 text-muted-foreground lg:hidden"
              onClick={() => setOpen(false)}
              aria-label="Close menu"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <nav className="flex-1 space-y-1 overflow-y-auto px-3 pb-4">
            {visibleNav.map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                data-tour={`nav-${label.toLowerCase()}`}
                activeOptions={{ exact: to === "/" }}
                className="group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-sidebar-foreground/70 transition-all hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[status=active]:bg-sidebar-accent data-[status=active]:text-gold"
              >
                <Icon className="h-[18px] w-[18px] shrink-0" />
                <span className="truncate">{label}</span>
              </Link>
            ))}
          </nav>

          <div className="border-t border-sidebar-border p-4">
            <div className="flex items-center gap-3">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-gold/40 text-xs font-semibold text-gold">
                {session.name.slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{session.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {session.role === "admin" ? "Administrator" : "Receptionist"}
                </p>
              </div>
              <button
                aria-label="Log out"
                disabled={signingOut}
                className="rounded-md p-2 text-muted-foreground transition-colors hover:text-destructive"
                onClick={async () => {
                  if (signingOut) return;
                  setSigningOut(true);
                  try {
                    await logoutSecurely();
                    await navigate({ to: "/login", replace: true });
                  } catch {
                    toast.error(
                      "Could not finish saving or sign out. Check your connection and try again.",
                    );
                  } finally {
                    setSigningOut(false);
                  }
                }}
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </aside>

      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Main */}
      <div
        className={cn(
          "transition-[padding] duration-300",
          desktopCollapsed ? "lg:pl-0" : "lg:pl-[264px]",
        )}
      >
        <header className="no-print sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur-xl">
          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 sm:px-6">
            <button
              className="rounded-md p-2 text-muted-foreground lg:hidden"
              onClick={() => setOpen(true)}
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </button>
            {desktopCollapsed && (
              <button
                type="button"
                className="hidden h-9 w-9 place-items-center rounded-lg border border-border bg-secondary/60 text-muted-foreground transition-colors hover:border-gold/40 hover:text-gold lg:grid"
                onClick={() => setSidebarCollapsed(false)}
                aria-label="Show sidebar"
                title="Show sidebar"
              >
                <EllipsisVertical className="h-5 w-5" />
              </button>
            )}
            {session.role === "admin" ? (
              <button
                onClick={() => setSearchOpen(true)}
                data-tour="global-search"
                className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-secondary/60 px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-gold/40 lg:w-[380px]"
              >
                <Search className="h-4 w-4 shrink-0" />
                <span className="truncate">Search members, products, invoices…</span>
                <kbd className="ml-auto hidden rounded border border-border px-1.5 py-0.5 text-[10px] sm:block">
                  ⌘K
                </kbd>
              </button>
            ) : (
              <div />
            )}
            <div className="flex items-center gap-2 justify-self-end">
              <button
                type="button"
                onClick={() => {
                  setPaywallReason("manage");
                  setPaywallOpen(true);
                }}
                className={cn(
                  "hidden items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs font-semibold transition-colors sm:flex",
                  subscription.active
                    ? subscriptionDays <= 7
                      ? "border-warning/40 bg-warning/10 text-warning hover:bg-warning/15"
                      : "border-success/35 bg-success/10 text-success hover:bg-success/15"
                    : subscription.status === "expired"
                      ? "border-warning/35 bg-warning/10 text-warning hover:bg-warning/15"
                      : "border-border bg-secondary/60 text-muted-foreground hover:border-gold/40 hover:text-gold",
                )}
                title={
                  subscription.active && subscription.currentPeriodEnd
                    ? `Pro expires ${new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(new Date(subscription.currentPeriodEnd))}`
                    : subscription.status === "expired"
                      ? "Pro expired — renew access"
                      : `Free plan — up to 10 members`
                }
              >
                <BadgeCheck className="h-3.5 w-3.5" />
                {subscription.active
                  ? `Pro · ${subscriptionDays}d`
                  : subscription.status === "expired"
                    ? "Pro expired"
                    : "Free · 10 max"}
              </button>
              {(session.role === "admin" || session.permissions?.notifications) && (
                <span data-tour="header-notifications">
                  <NotificationBell />
                </span>
              )}
              {(session.role === "admin" || session.permissions?.members) && (
                <Button asChild size="sm" className="hidden font-semibold sm:inline-flex">
                  <Link
                    to="/members"
                    search={{ filter: "all", q: "", page: 1, new: true }}
                    data-tour="add-member"
                  >
                    Add Member
                  </Link>
                </Button>
              )}
            </div>
          </div>
        </header>

        <main className="px-4 py-6 sm:px-6 lg:px-8">
          {(accessContext?.accountStatus === "suspended" ||
            accessContext?.accountStatus === "archived" ||
            accessContext?.accountStatus === "pending" ||
            accessContext?.subscriptionExpired) && (
            <section
              role="status"
              className="mb-5 rounded-xl border border-warning/35 bg-warning/5 px-4 py-3 text-sm leading-6"
            >
              <p className="font-semibold text-warning">
                {accessContext.accountStatus === "suspended" ||
                accessContext.accountStatus === "archived"
                  ? "Gym account suspended — read-only access"
                  : accessContext.accountStatus === "pending"
                    ? "Gym account pending approval — read-only access"
                    : "Pro subscription expired — read-only access"}
              </p>
              <p className="text-muted-foreground">
                Your existing data remains available. Changes are blocked by the secure backend
                until the account is reactivated or Pro access is renewed.
              </p>
            </section>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}
