import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Users,
  Wallet,
  AlertTriangle,
  CalendarX,
  UserPlus,
  RefreshCw,
  BadgeX,
  IndianRupee,
  ShoppingBag,
  PackagePlus,
  FileText,
  TrendingUp,
} from "lucide-react";
import { AppShell } from "@/components/app/AppShell";
import { PageHeader, Panel } from "@/components/app/Panel";
import { StatCard } from "@/components/app/StatCard";
import { Button } from "@/components/ui/button";
import { useGym } from "@/lib/gym/store";
import {
  activeMembers,
  currentMembership,
  metricMeta,
  money,
  planDistribution,
  profitOfSales,
  relative,
  revenueForMetric,
  revenueSeries,
  statusOf,
  topProducts,
  totalDue,
  totalRevenue,
  type Range,
  type RevenueMetric,
} from "@/lib/gym/selectors";
import type { ActivityType } from "@/lib/gym/types";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Dashboard — IRONVAULT Gym Management" },
      {
        name: "description",
        content:
          "Track active members, collected revenue, pending dues and expired memberships from one premium offline gym dashboard.",
      },
      { property: "og:title", content: "Dashboard — IRONVAULT Gym Management" },
      {
        property: "og:description",
        content: "Track active members, collected revenue, pending dues and expired memberships from one premium offline gym dashboard.",
      },
    ],
  }),
  component: () => (
    <AppShell>
      <Dashboard />
    </AppShell>
  ),
});

const ACTIVITY_ICON: Record<ActivityType, typeof UserPlus> = {
  member_added: UserPlus,
  membership_renewed: RefreshCw,
  membership_expired: BadgeX,
  payment_received: IndianRupee,
  product_sold: ShoppingBag,
  product_added: PackagePlus,
  invoice_generated: FileText,
  member_trashed: BadgeX,
  member_restored: RefreshCw,
  member_deleted: BadgeX,
  expense_added: IndianRupee,
  expense_updated: RefreshCw,
  expense_trashed: BadgeX,

};

const RANGES: Range[] = ["daily", "weekly", "monthly", "yearly"];

/** Muted premium palette: gold, emerald, sky, slate, soft orange. */
const PLAN_COLORS = [
  "oklch(0.775 0.128 87.5)",
  "oklch(0.68 0.11 160)",
  "oklch(0.68 0.09 235)",
  "oklch(0.6 0.02 250)",
  "oklch(0.72 0.115 55)",
];

function Dashboard() {
  const state = useGym();
  const [range, setRange] = useState<Range>("monthly");

  const data = useMemo(() => {
    if (!state) return null;
    const members = activeMembers(state);
    const statuses = members.map((m) => statusOf(state, m.id));
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    return {
      active: statuses.filter((s) => s === "active" || s === "expiring").length,
      expired: statuses.filter((s) => s === "expired").length,
      frozen: statuses.filter((s) => s === "frozen").length,
      revenue: totalRevenue(state),
      cardRevenue: revenueForMetric(state, (state.settings.revenueCardMetric ?? "today") as RevenueMetric),
      monthRevenue: totalRevenue(state, monthStart),
      due: totalDue(state),
      series: revenueSeries(state, range),
      plans: planDistribution(state),
      products: topProducts(state, 5),
      profit: profitOfSales(state),
      totalMembers: members.length,
    };
  }, [state, range]);

  if (!state || !data) return null;
  const cur = state.settings.currency;

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`${state.settings.gymName} · ${new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}`}
        actions={
          <Button asChild variant="secondary">
            <Link to="/reports">View reports</Link>
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Active Members"
          value={String(data.active)}
          hint={`${data.totalMembers} total on roster`}
          icon={Users}
          tone="gold"
          to="/members"
          search={{ filter: "active", q: "", page: 1 }}
        />
        <StatCard
          label={metricMeta((state.settings.revenueCardMetric ?? "today") as RevenueMetric).label}
          value={money(data.cardRevenue, cur)}
          hint={metricMeta((state.settings.revenueCardMetric ?? "today") as RevenueMetric).hint}
          icon={Wallet}
          tone="success"
          to="/payments"
          search={{ tab: "collected", q: "", page: 1 }}
        />
        <StatCard
          label="Pending Due"
          value={money(data.due, cur)}
          hint="Outstanding member balances"
          icon={AlertTriangle}
          tone="warning"
          to="/payments"
          search={{ tab: "pending", q: "", page: 1 }}
        />
        <StatCard
          label="Expired Members"
          value={String(data.expired)}
          hint="Needs renewal follow-up"
          icon={CalendarX}
          tone="danger"
          to="/members"
          search={{ filter: "expired", q: "", page: 1 }}
        />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Panel
          className="xl:col-span-2"
          title="Revenue Chart"
          description="Membership vs product income"
          actions={
            <div className="flex rounded-lg border border-border bg-secondary/50 p-0.5">
              {RANGES.map((r) => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
                    range === r ? "bg-[image:var(--gradient-gold)] text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          }
        >
          <div className="h-[290px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.series} margin={{ left: -18, right: 8, top: 8 }}>
                <defs>
                  <linearGradient id="gGold" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-gold)" stopOpacity={0.55} />
                    <stop offset="100%" stopColor="var(--color-gold)" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="gGreen" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-success)" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="var(--color-success)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 6" stroke="var(--color-border)" vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} stroke="var(--color-muted-foreground)" />
                <YAxis tickLine={false} axisLine={false} fontSize={11} stroke="var(--color-muted-foreground)" />
                <Tooltip
                  contentStyle={{
                    background: "var(--color-popover)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 12,
                    fontSize: 12,
                  }}
                  formatter={(v: number, n: string) => [money(v, cur), n === "membership" ? "Membership" : "Products"]}
                />
                <Area
                  type="monotone"
                  dataKey="membership"
                  stroke="var(--color-gold)"
                  strokeWidth={2}
                  fill="url(#gGold)"
                />
                <Area
                  type="monotone"
                  dataKey="product"
                  stroke="var(--color-success)"
                  strokeWidth={2}
                  fill="url(#gGreen)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Membership Statistics" description="Active members by plan">
          <div className="h-[290px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data.plans}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="45%"
                  innerRadius="55%"
                  outerRadius="80%"
                  paddingAngle={5}
                  cornerRadius={6}
                  minAngle={2}
                  stroke="var(--color-background)"
                  strokeWidth={2}
                  isAnimationActive
                  animationDuration={700}
                >
                  {data.plans.map((_, i) => (
                    <Cell
                      key={i}
                      fill={PLAN_COLORS[i % PLAN_COLORS.length]}
                      style={{ transition: "opacity 200ms ease, filter 200ms ease" }}
                    />
                  ))}
                </Pie>
                <Legend
                  verticalAlign="bottom"
                  align="center"
                  iconType="circle"
                  iconSize={9}
                  wrapperStyle={{ paddingTop: 8, lineHeight: "20px" }}
                  formatter={(v: string, entry) => (
                    <span
                      style={{ fontSize: 12, fontWeight: 500 }}
                      className="text-muted-foreground"
                    >
                      {v}
                      <span className="ml-1.5 text-foreground">
                        {(entry as unknown as { payload?: { value?: number } })?.payload?.value ?? 0}
                      </span>
                    </span>
                  )}
                />
                <Tooltip
                  cursor={false}
                  content={({ active, payload }) =>
                    active && payload?.length ? (
                      <div className="rounded-xl border border-gold/60 bg-popover px-3.5 py-2.5 text-xs shadow-lg">
                        <p className="font-semibold text-gold">{payload[0].name}</p>
                        <p className="mt-0.5 font-medium text-gold/90">Members: {payload[0].value}</p>
                      </div>
                    ) : null
                  }
                />


              </PieChart>
            </ResponsiveContainer>
          </div>

        </Panel>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Panel
          className="xl:col-span-2"
          title="Sales Statistics"
          description="Best performing products by revenue"
          actions={
            <span className="flex items-center gap-1.5 text-xs text-success">
              <TrendingUp className="h-3.5 w-3.5" /> {money(data.profit, cur)} profit
            </span>
          }
        >
          <div className="h-[270px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.products} margin={{ left: -18, right: 8, top: 8 }}>
                <CartesianGrid strokeDasharray="3 6" stroke="var(--color-border)" vertical={false} />
                <XAxis
                  dataKey="name"
                  tickLine={false}
                  axisLine={false}
                  fontSize={10}
                  stroke="var(--color-muted-foreground)"
                  tickFormatter={(v: string) => v.split(" ")[0]}
                />
                <YAxis tickLine={false} axisLine={false} fontSize={11} stroke="var(--color-muted-foreground)" />
                <Tooltip
                  cursor={{ fill: "var(--color-secondary)", opacity: 0.4 }}
                  contentStyle={{
                    background: "var(--color-popover)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 12,
                    fontSize: 12,
                  }}
                  formatter={(v: number) => money(v, cur)}
                />
                <Bar dataKey="revenue" radius={[6, 6, 0, 0]} fill="var(--color-gold)" />
                <Bar dataKey="profit" radius={[6, 6, 0, 0]} fill="var(--color-chart-3)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel
          title="Recent Activities"
          description="Latest events across the club"
          actions={
            <Button asChild variant="ghost" size="sm" className="text-xs text-gold">
              <Link to="/notifications">View all</Link>
            </Button>
          }
        >
          <ul className="space-y-1">
            {state.activities.slice(0, 8).map((a) => {
              const Icon = ACTIVITY_ICON[a.type] ?? FileText;
              return (
                <li key={a.id} className="flex gap-3 rounded-lg p-2 transition-colors hover:bg-secondary/50">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-gold/25 bg-gold/10 text-gold">
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{a.title}</p>
                    <p className="truncate text-xs text-muted-foreground">{a.description}</p>
                  </div>
                  <span className="shrink-0 text-[11px] text-muted-foreground/70">{relative(a.date)}</span>
                </li>
              );
            })}
          </ul>
        </Panel>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Frozen memberships", String(data.frozen)],
          ["Products in catalogue", String(state.products.length)],
          ["Invoices generated", String(state.payments.length)],
          [
            "Expiring this week",
            String(
              activeMembers(state).filter((m) => {
                const ms = currentMembership(state, m.id);
                return ms && statusOf(state, m.id) === "expiring";
              }).length,
            ),
          ],
        ].map(([label, value]) => (
          <div key={label} className="surface-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
            <p className="mt-1 font-display text-2xl text-gold">{value}</p>
          </div>
        ))}
      </div>
    </>
  );
}
