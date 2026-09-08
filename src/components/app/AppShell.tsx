import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
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
import { getCurrentSession, logoutSecurely, useGym, validateCurrentSession } from "@/lib/gym/store";
import { toast } from "sonner";
import { isSupabaseConfigured, supabase } from "@/integrations/supabase/client";
import { NotificationBell } from "./NotificationBell";
import { GlobalSearch } from "./GlobalSearch";

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
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [desktopCollapsed, setDesktopCollapsed] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    // A fresh local clone intentionally has no Supabase .env values. In that
    // case the app uses its existing local demo/session flow instead of
    // mounting cloud auth and throwing from the Supabase client.
    if (!isSupabaseConfigured()) return;
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT" && getCurrentSession()?.role === "admin") {
        setSessionChecked(false);
        void navigate({ to: "/login", replace: true });
      }
    });
    return () => data.subscription.unsubscribe();
  }, [navigate]);

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
              {(session.role === "admin" || session.permissions?.notifications) && (
                <NotificationBell />
              )}
              {(session.role === "admin" || session.permissions?.members) && (
                <Button asChild size="sm" className="hidden font-semibold sm:inline-flex">
                  <Link to="/members" search={{ filter: "all", q: "", page: 1, new: true }}>
                    Add Member
                  </Link>
                </Button>
              )}
            </div>
          </div>
        </header>

        <main className="px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
