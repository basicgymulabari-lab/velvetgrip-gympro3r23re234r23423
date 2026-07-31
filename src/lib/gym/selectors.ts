import type {
  GymState,
  Member,
  MemberStatus,
  Membership,
  Payment,
  Product,
} from "./types";

export const DAY = 24 * 60 * 60 * 1000;

export const money = (n: number, currency = "₹") =>
  `${currency}${Math.round(n).toLocaleString("en-IN")}`;

export const shortDate = (d: string | Date) =>
  new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

export const dateTime = (d: string | Date) =>
  new Date(d).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

export const relative = (d: string | Date) => {
  const diff = Date.now() - new Date(d).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return shortDate(d);
};

export const daysUntil = (d: string | Date) =>
  Math.ceil((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / DAY);

export const activeMembers = (s: GymState) => s.members.filter((m) => !m.deletedAt);
export const trashedMembers = (s: GymState) => s.members.filter((m) => m.deletedAt);

export function currentMembership(s: GymState, memberId: string): Membership | undefined {
  return s.memberships
    .filter((m) => m.memberId === memberId)
    .sort((a, b) => +new Date(b.endDate) - +new Date(a.endDate))[0];
}

export function membershipHistory(s: GymState, memberId: string) {
  return s.memberships
    .filter((m) => m.memberId === memberId)
    .sort((a, b) => +new Date(b.startDate) - +new Date(a.startDate));
}

export function statusOf(s: GymState, memberId: string): MemberStatus {
  const ms = currentMembership(s, memberId);
  if (!ms) return "expired";
  if (ms.frozen) return "frozen";
  const left = daysUntil(ms.endDate);
  if (left < 0) return "expired";
  if (left <= s.settings.expiryReminderDays) return "expiring";
  return "active";
}

export function paidFor(s: GymState, membershipId: string) {
  return s.payments
    .filter((p) => p.membershipId === membershipId)
    .reduce((sum, p) => sum + p.amount, 0);
}

export function dueFor(s: GymState, memberId: string) {
  return s.memberships
    .filter((m) => m.memberId === memberId)
    .reduce((sum, m) => sum + Math.max(0, m.price - m.discount - paidFor(s, m.id)), 0);
}

export function totalDue(s: GymState) {
  return activeMembers(s).reduce((sum, m) => sum + dueFor(s, m.id), 0);
}

export function totalRevenue(s: GymState, from?: Date) {
  return s.payments
    .filter((p) => (from ? new Date(p.date) >= from : true))
    .reduce((sum, p) => sum + p.amount, 0);
}

export function lowStock(s: GymState): Product[] {
  return s.products.filter((p) => p.stock <= p.lowStockAt);
}

export function profitOfSales(s: GymState, from?: Date) {
  return s.sales
    .filter((x) => (from ? new Date(x.date) >= from : true))
    .reduce((sum, x) => sum + (x.unitPrice - x.unitCost) * x.qty, 0);
}

export type Range = "daily" | "weekly" | "monthly" | "yearly";

export function revenueSeries(s: GymState, range: Range) {
  const now = new Date();
  const buckets: Array<{ label: string; start: Date; end: Date }> = [];

  const mk = (label: string, start: Date, end: Date) => buckets.push({ label, start, end });

  if (range === "daily") {
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const e = new Date(d);
      e.setHours(23, 59, 59, 999);
      mk(d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }), d, e);
    }
  } else if (range === "weekly") {
    for (let i = 11; i >= 0; i--) {
      const e = new Date(now);
      e.setDate(e.getDate() - i * 7);
      e.setHours(23, 59, 59, 999);
      const d = new Date(e);
      d.setDate(d.getDate() - 6);
      d.setHours(0, 0, 0, 0);
      mk(`W${12 - i}`, d, e);
    }
  } else if (range === "monthly") {
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const e = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      mk(d.toLocaleDateString("en-IN", { month: "short" }), d, e);
    }
  } else {
    for (let i = 4; i >= 0; i--) {
      const y = now.getFullYear() - i;
      mk(String(y), new Date(y, 0, 1), new Date(y, 11, 31, 23, 59, 59));
    }
  }

  return buckets.map((b) => {
    const inRange = (date: string) => {
      const t = new Date(date).getTime();
      return t >= b.start.getTime() && t <= b.end.getTime();
    };
    const membership = s.payments
      .filter((p) => p.kind === "membership" && inRange(p.date))
      .reduce((sum, p) => sum + p.amount, 0);
    const product = s.payments
      .filter((p) => p.kind === "product" && inRange(p.date))
      .reduce((sum, p) => sum + p.amount, 0);
    return { label: b.label, membership, product, total: membership + product };
  });
}

export function planDistribution(s: GymState) {
  return s.plans
    .map((plan) => ({
      name: plan.name,
      value: activeMembers(s).filter((m) => currentMembership(s, m.id)?.planId === plan.id).length,
    }))
    .filter((p) => p.value > 0);
}

export function topProducts(s: GymState, limit = 5) {
  const map = new Map<string, { name: string; units: number; revenue: number; profit: number }>();
  s.sales.forEach((sale) => {
    const entry = map.get(sale.productId) ?? {
      name: sale.productName,
      units: 0,
      revenue: 0,
      profit: 0,
    };
    entry.units += sale.qty;
    entry.revenue += sale.total;
    entry.profit += (sale.unitPrice - sale.unitCost) * sale.qty;
    map.set(sale.productId, entry);
  });
  return Array.from(map.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit);
}

export function memberOf(s: GymState, id?: string | null): Member | undefined {
  return s.members.find((m) => m.id === id);
}

export function planOf(s: GymState, id?: string | null) {
  return s.plans.find((p) => p.id === id);
}

export function paymentsWithNames(s: GymState): Array<Payment & { who: string }> {
  return s.payments
    .slice()
    .sort((a, b) => +new Date(b.date) - +new Date(a.date))
    .map((p) => ({
      ...p,
      who:
        memberOf(s, p.memberId)?.name ??
        s.sales.find((x) => x.id === p.saleId)?.buyer ??
        "Walk-in customer",
    }));
}

/* ---------------- Notifications ---------------- */

export type NotificationCategory = "due" | "expiry" | "birthday" | "inventory" | "system";

export type Notification = {
  id: string;
  category: NotificationCategory;
  title: string;
  description: string;
  date: string;
  tone: "danger" | "warning" | "success" | "info";
  href?: string;
};

const birthdayOffset = (dob: string) => {
  const d = new Date(dob);
  const now = new Date();
  const next = new Date(now.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((next.setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / DAY);
  return diff;
};

export function buildNotifications(s: GymState): Notification[] {
  const list: Notification[] = [];

  activeMembers(s).forEach((m) => {
    const due = dueFor(s, m.id);
    if (due > 0) {
      const ms = currentMembership(s, m.id);
      const overdueDays = ms ? Math.max(0, -daysUntil(ms.endDate)) : 0;
      list.push({
        id: `due_${m.id}`,
        category: "due",
        title: m.name,
        description:
          overdueDays > 0
            ? `Payment overdue (${overdueDays} days) — ${money(due, s.settings.currency)}`
            : `Pending payment — ${money(due, s.settings.currency)}`,
        date: ms?.endDate ?? m.joinDate,
        tone: overdueDays > 0 ? "danger" : "warning",
        href: "/payments",
      });
    }

    const ms = currentMembership(s, m.id);
    if (ms && !ms.frozen) {
      const left = daysUntil(ms.endDate);
      if (left <= s.settings.expiryReminderDays && left >= -30) {
        list.push({
          id: `exp_${m.id}`,
          category: "expiry",
          title: m.name,
          description:
            left < 0
              ? `Membership expired ${Math.abs(left)} day(s) ago`
              : left === 0
                ? "Membership expires today"
                : left === 1
                  ? "Membership expires tomorrow"
                  : `Membership expires in ${left} days`,
          date: ms.endDate,
          tone: left < 0 ? "danger" : "warning",
          href: "/memberships",
        });
      }
    }

    const bday = birthdayOffset(m.dob);
    if (bday === 0 || bday === 1) {
      list.push({
        id: `bday_${m.id}`,
        category: "birthday",
        title: m.name,
        description: bday === 0 ? "Birthday today" : "Birthday tomorrow",
        date: new Date().toISOString(),
        tone: "success",
        href: `/members/${m.id}`,
      });
    }
  });

  if (s.settings.lowStockAlerts) {
    lowStock(s).forEach((p) => {
      list.push({
        id: `stock_${p.id}`,
        category: "inventory",
        title: p.name,
        description:
          p.stock === 0
            ? "Out of stock — restock immediately"
            : `Only ${p.stock} left in stock (alert at ${p.lowStockAt})`,
        date: new Date().toISOString(),
        tone: p.stock === 0 ? "danger" : "warning",
        href: "/products",
      });
    });
  }

  s.activities.slice(0, 8).forEach((a) => {
    list.push({
      id: `act_${a.id}`,
      category: "system",
      title: a.title,
      description: a.description,
      date: a.date,
      tone: "info",
    });
  });

  return list.sort((a, b) => +new Date(b.date) - +new Date(a.date));
}

/* ------------------------------------------------------------------ */
/* Revenue card metric                                                 */
/* ------------------------------------------------------------------ */

export type RevenueMetric = "today" | "weekly" | "monthly" | "yearly" | "total";

export const REVENUE_METRICS: Array<{ key: RevenueMetric; label: string; hint: string }> = [
  { key: "today", label: "Today's Revenue", hint: "Today's earnings" },
  { key: "weekly", label: "Weekly Revenue", hint: "This week's earnings" },
  { key: "monthly", label: "Monthly Revenue", hint: "This month's earnings" },
  { key: "yearly", label: "Yearly Revenue", hint: "This year's earnings" },
  { key: "total", label: "Total Revenue", hint: "Lifetime earnings" },
];

export function metricStart(metric: RevenueMetric): Date | undefined {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  switch (metric) {
    case "today":
      return d;
    case "weekly": {
      const day = (d.getDay() + 6) % 7; // Monday start
      d.setDate(d.getDate() - day);
      return d;
    }
    case "monthly":
      d.setDate(1);
      return d;
    case "yearly":
      d.setMonth(0, 1);
      return d;
    default:
      return undefined;
  }
}

export function revenueForMetric(s: GymState, metric: RevenueMetric) {
  return totalRevenue(s, metricStart(metric));
}

export const rangeToMetric = (r: Range): RevenueMetric =>
  r === "daily" ? "today" : r === "weekly" ? "weekly" : r === "monthly" ? "monthly" : "yearly";

export const metricMeta = (metric: RevenueMetric) =>
  REVENUE_METRICS.find((m) => m.key === metric) ?? REVENUE_METRICS[0];
