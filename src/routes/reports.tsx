import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Download, Printer } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app/AppShell";
import { PageHeader, Panel } from "@/components/app/Panel";
import { Button } from "@/components/ui/button";
import { AppDatePicker } from "@/components/app/AppDatePicker";
import { useGym } from "@/lib/gym/store";
import { formatDayMonth, localDateInput } from "@/lib/gym/calendar";
import type { GymState } from "@/lib/gym/types";
import {
  activeMembers,
  gymMembers,
  currentMembership,
  metricMeta,
  metricStart,
  money,
  planDistribution,
  profitOfSales,
  rangeToMetric,
  revenueForMetric,
  revenueSeries,
  shortDate,
  statusOf,
  topProducts,
  totalDue,
  inWindow,
} from "@/lib/gym/selectors";

export const Route = createFileRoute("/reports")({
  head: () => ({
    meta: [
      { title: "Reports & Analytics — IRONVAULT Gym Management" },
      {
        name: "description",
        content:
          "Daily, weekly, monthly and yearly reports on revenue, memberships, dues and product sales — exportable as CSV.",
      },
      { property: "og:title", content: "Reports & Analytics — IRONVAULT Gym Management" },
      {
        property: "og:description",
        content: "Revenue trends, membership breakdowns, sales performance and CSV export.",
      },
    ],
  }),
  component: () => (
    <AppShell>
      <ReportsPage />
    </AppShell>
  ),
});

const RANGES = ["daily", "weekly", "monthly", "yearly"] as const;
type RangeKey = (typeof RANGES)[number];
type ReportRange = RangeKey | "custom";
const GOLDS = ["#D4AF37", "#B8912C", "#E8CE7A", "#8C6D1F", "#F2E2AC"];

const daysAgoInput = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return localDateInput(date);
};

function customWindow(start: string, end: string) {
  const from = new Date(`${start}T00:00:00`);
  const to = new Date(`${end}T23:59:59.999`);
  return { start: from, end: to };
}

function customRevenueSeries(state: GymState, start: string, end: string) {
  const window = customWindow(start, end);
  if (window.end < window.start) return [];
  const day = 86_400_000;
  const spanDays = Math.floor((window.end.getTime() - window.start.getTime()) / day) + 1;
  const bucketDays = spanDays <= 45 ? 1 : spanDays <= 370 ? 7 : 30;
  const buckets: Array<{ label: string; start: Date; end: Date }> = [];
  for (let cursor = new Date(window.start); cursor <= window.end;) {
    const bucketStart = new Date(cursor);
    const bucketEnd = new Date(cursor);
    bucketEnd.setDate(bucketEnd.getDate() + bucketDays - 1);
    bucketEnd.setHours(23, 59, 59, 999);
    if (bucketEnd > window.end) bucketEnd.setTime(window.end.getTime());
    buckets.push({
      label:
        bucketDays === 1
          ? formatDayMonth(bucketStart)
          : `${formatDayMonth(bucketStart)}–${formatDayMonth(bucketEnd)}`,
      start: bucketStart,
      end: bucketEnd,
    });
    cursor = new Date(bucketEnd);
    cursor.setMilliseconds(cursor.getMilliseconds() + 1);
  }
  return buckets.map((bucket) => {
    const inBucket = (date: string) => inWindow(date, bucket);
    const membership = state.payments
      .filter((payment) => payment.kind === "membership" && inBucket(payment.date))
      .reduce((sum, payment) => sum + payment.amount, 0);
    const product = state.payments
      .filter((payment) => payment.kind === "product" && inBucket(payment.date))
      .reduce((sum, payment) => sum + payment.amount, 0);
    return { label: bucket.label, membership, product, total: membership + product };
  });
}

function ReportsPage() {
  const state = useGym();
  const [range, setRange] = useState<ReportRange>("monthly");
  const [customStart, setCustomStart] = useState(daysAgoInput(29));
  const [customEnd, setCustomEnd] = useState(localDateInput(new Date()));

  const series = useMemo(
    () =>
      state
        ? range === "custom"
          ? customRevenueSeries(state, customStart, customEnd)
          : revenueSeries(state, range)
        : [],
    [state, range, customStart, customEnd],
  );

  if (!state) return null;
  const cur = state.settings.currency;
  const dist = planDistribution(state);
  const products = topProducts(state, 5);
  const selectedWindow = customWindow(customStart, customEnd);
  const customValid = selectedWindow.start <= selectedWindow.end;
  const reportRevenue =
    range === "custom"
      ? state.payments
          .filter((payment) => customValid && inWindow(payment.date, selectedWindow))
          .reduce((sum, payment) => sum + payment.amount, 0)
      : revenueForMetric(state, rangeToMetric(range));
  const reportProfit =
    range === "custom"
      ? state.sales
          .filter((sale) => customValid && inWindow(sale.date, selectedWindow))
          .reduce((sum, sale) => sum + sale.total - sale.unitCost * sale.qty, 0)
      : profitOfSales(state, metricStart(rangeToMetric(range)));
  const reportLabel =
    range === "custom" ? "Custom revenue" : metricMeta(rangeToMetric(range)).label;
  const statuses = gymMembers(state).reduce<Record<string, number>>((acc, m) => {
    const s = statusOf(state, m.id);
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});

  const exportCsv = () => {
    const rows = [
      ["Period", "Revenue"],
      ...series.map((d) => [d.label, String(d.total)]),
      [],
      ["Summary", ""],
      ["Selected revenue", String(reportRevenue)],
      ["Pending dues", String(totalDue(state))],
      ["Product profit", String(reportProfit)],
      ["Active members", String(statuses.active ?? 0)],
    ];
    const csv = rows.map((r) => r.join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `ironvault-report-${range}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Report exported");
  };

  return (
    <>
      <PageHeader
        title="Reports & Analytics"
        subtitle={`Generated ${shortDate(new Date())} · all figures computed locally`}
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => window.print()}>
              <Printer className="mr-2 h-4 w-4" /> Print
            </Button>
            <Button onClick={exportCsv}>
              <Download className="mr-2 h-4 w-4" /> Export CSV
            </Button>
          </div>
        }
      />

      <div className="mb-6 flex flex-wrap gap-2">
        {RANGES.map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={`rounded-full border px-4 py-1.5 text-xs font-medium capitalize transition-colors ${
              range === r
                ? "border-gold/50 bg-gold/15 text-gold"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {r}
          </button>
        ))}
        <button
          onClick={() => setRange("custom")}
          className={`rounded-full border px-4 py-1.5 text-xs font-medium transition-colors ${
            range === "custom"
              ? "border-gold/50 bg-gold/15 text-gold"
              : "border-border text-muted-foreground hover:text-foreground"
          }`}
        >
          Custom
        </button>
      </div>

      {range === "custom" && (
        <div className="mb-6 grid gap-4 rounded-2xl border border-gold/25 bg-secondary/25 p-4 sm:grid-cols-2">
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Start date</p>
            <AppDatePicker value={customStart} onChange={setCustomStart} max={new Date()} />
          </div>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">End date</p>
            <AppDatePicker
              value={customEnd}
              onChange={setCustomEnd}
              min={new Date(`${customStart}T00:00:00`)}
              max={new Date()}
            />
          </div>
          {!customValid && (
            <p className="text-xs text-destructive sm:col-span-2">
              End date must be on or after the start date.
            </p>
          )}
        </div>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          [reportLabel, money(reportRevenue, cur)],
          ["Pending dues", money(totalDue(state), cur)],
          ["Product profit", money(reportProfit, cur)],
          ["Active members", String(statuses.active ?? 0)],
        ].map(([label, value]) => (
          <div key={label} className="surface-panel rounded-2xl p-5">
            <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
            <p className="mt-1 font-display text-2xl text-gradient-gold">{value}</p>
          </div>
        ))}
      </div>

      <Panel title={`Revenue — ${range}`} className="mb-6">
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series}>
              <defs>
                <linearGradient id="revGold" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#D4AF37" stopOpacity={0.55} />
                  <stop offset="100%" stopColor="#D4AF37" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis
                dataKey="label"
                stroke="#8b8b8b"
                fontSize={11}
                tickLine={false}
                axisLine={false}
              />
              <YAxis stroke="#8b8b8b" fontSize={11} tickLine={false} axisLine={false} width={56} />
              <Tooltip
                contentStyle={{
                  background: "#111111",
                  border: "1px solid rgba(212,175,55,0.35)",
                  borderRadius: 12,
                  color: "#fff",
                }}
                formatter={(v: number) => money(v, cur)}
              />
              <Area
                type="monotone"
                dataKey="total"
                stroke="#D4AF37"
                strokeWidth={2}
                fill="url(#revGold)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Membership distribution">
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={dist}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={55}
                  outerRadius={90}
                  paddingAngle={3}
                >
                  {dist.map((_, i) => (
                    <Cell key={i} fill={GOLDS[i % GOLDS.length]} stroke="transparent" />
                  ))}
                </Pie>
                <Tooltip
                  content={({ active, payload }) =>
                    active && payload?.length ? (
                      <div className="rounded-xl border border-gold/60 bg-popover px-3.5 py-2.5 text-xs shadow-lg">
                        <p className="font-semibold text-gold">{payload[0].name}</p>
                        <p className="mt-0.5 font-medium text-gold/90">
                          Members: {payload[0].value}
                        </p>
                      </div>
                    ) : null
                  }
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="mt-4 space-y-2 text-sm">
            {dist.map((d, i) => (
              <li key={d.name} className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: GOLDS[i % GOLDS.length] }}
                  />
                  {d.name}
                </span>
                <span className="font-medium">{d.value}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Top selling products">
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={products}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  dataKey="name"
                  stroke="#8b8b8b"
                  fontSize={10}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke="#8b8b8b"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  width={48}
                />
                <Tooltip
                  cursor={{ fill: "rgba(212,175,55,0.08)" }}
                  contentStyle={{
                    background: "#111111",
                    border: "1px solid rgba(212,175,55,0.35)",
                    borderRadius: 12,
                    color: "#fff",
                  }}
                />
                <Bar dataKey="revenue" fill="#D4AF37" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>

      <Panel title="Membership status summary" className="mt-6">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="py-3">Member</th>
                <th className="py-3">Status</th>
                <th className="py-3">Expiry</th>
              </tr>
            </thead>
            <tbody>
              {gymMembers(state)
                .slice(0, 10)
                .map((m) => {
                  const ms = currentMembership(state, m.id);
                  return (
                    <tr key={m.id} className="border-b border-border/50">
                      <td className="py-2.5">{m.name}</td>
                      <td className="py-2.5 capitalize text-muted-foreground">
                        {statusOf(state, m.id)}
                      </td>
                      <td className="py-2.5 text-muted-foreground">
                        {ms ? shortDate(ms.endDate) : "—"}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
