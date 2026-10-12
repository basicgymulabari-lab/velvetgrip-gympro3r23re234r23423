import type { GymState, Member, MemberStatus, Membership, Payment, Product, Sale } from "./types";
import {
  formatCompactDate,
  formatDayMonth,
  formatMonth,
  formatShortDate,
  parseCalendarDate,
} from "./calendar";
import { addMoney, multiplyMoney, subtractMoney, sumMoney } from "./money";

export const DAY = 24 * 60 * 60 * 1000;

export const money = (n: number, currency = "₹") =>
  `${currency}${Math.round(n).toLocaleString("en-IN")}`;

export const shortDate = formatShortDate;

/** Compact date: 03 Aug 26 */
export const compactDate = formatCompactDate;

export const dateTime = (d: string | Date) =>
  new Date(d).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** Whether a date falls from the start of the current local month through today. */
export function isInCurrentMonthToDate(value: string | Date, now = new Date()) {
  const date = parseCalendarDate(value);
  if (!Number.isFinite(date.getTime())) return false;

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return date >= monthStart && date <= now;
}

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

function calendarDayNumber(date: Date) {
  if (!Number.isFinite(date.getTime())) return Number.NaN;
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY;
}

export const daysUntil = (d: string | Date, now = new Date()) =>
  Math.round(calendarDayNumber(parseCalendarDate(d)) - calendarDayNumber(now));

/** Frozen terms preserve the remaining calendar days from the moment they were paused. */
export function membershipDaysLeft(membership: Pick<Membership, "endDate" | "frozen" | "frozenAt">) {
  if (membership.frozen && membership.frozenAt) {
    const frozenAt = parseCalendarDate(membership.frozenAt);
    const endDate = parseCalendarDate(membership.endDate);
    if (Number.isFinite(frozenAt.getTime()) && Number.isFinite(endDate.getTime())) {
      return Math.round(calendarDayNumber(endDate) - calendarDayNumber(frozenAt));
    }
  }
  return daysUntil(membership.endDate);
}

export const activeMembers = (s: GymState) => s.members.filter((m) => !m.deletedAt);
export const trashedMembers = (s: GymState) => s.members.filter((m) => m.deletedAt);
export const isWalkIn = (member: Member) => member.type === "walk_in";
export const gymMembers = (s: GymState) => activeMembers(s).filter((m) => !isWalkIn(m));

export const livePlans = (s: GymState) => s.plans.filter((p) => !p.deletedAt);
export const trashedPlans = (s: GymState) => s.plans.filter((p) => p.deletedAt);

type SelectorIndexes = {
  currentMembershipByMember: Map<string, Membership>;
  paymentsByMembership: Map<string, number>;
  paymentsBySale: Map<string, number>;
  membershipDueByMember: Map<string, number>;
  productDueByMember: Map<string, number>;
  membersById: Map<string, Member>;
  salesById: Map<string, Sale>;
};

// GymState is replaced rather than mutated by the store. Weakly caching its
// indexes keeps dashboard selectors linear for large rosters without retaining
// old workspaces or allowing one revision's values to leak into another.
const selectorIndexesByState = new WeakMap<GymState, SelectorIndexes>();

function addIndexedMoney(
  index: Map<string, number>,
  key: string | null | undefined,
  amount: number,
) {
  if (!key) return;
  index.set(key, addMoney(index.get(key) ?? 0, amount));
}

function selectorIndexes(s: GymState): SelectorIndexes {
  const cached = selectorIndexesByState.get(s);
  if (cached) return cached;

  const currentMembershipByMember = new Map<string, Membership>();
  const latestMembershipEndByMember = new Map<string, number>();
  for (const membership of s.memberships) {
    const endTime = new Date(membership.endDate).getTime();
    const previousEnd = latestMembershipEndByMember.get(membership.memberId);
    if (previousEnd === undefined || endTime > previousEnd) {
      currentMembershipByMember.set(membership.memberId, membership);
      latestMembershipEndByMember.set(membership.memberId, endTime);
    }
  }

  const paymentsByMembership = new Map<string, number>();
  const paymentsBySale = new Map<string, number>();
  for (const payment of s.payments) {
    addIndexedMoney(paymentsByMembership, payment.membershipId, payment.amount);
    addIndexedMoney(paymentsBySale, payment.saleId, payment.amount);
  }

  const membershipDueByMember = new Map<string, number>();
  for (const membership of s.memberships) {
    const due = Math.max(
      0,
      subtractMoney(membershipPayable(membership), paymentsByMembership.get(membership.id) ?? 0),
    );
    addIndexedMoney(membershipDueByMember, membership.memberId, due);
  }

  const productDueByMember = new Map<string, number>();
  for (const sale of s.sales) {
    const paid = typeof sale.paid !== "number" ? sale.total : (paymentsBySale.get(sale.id) ?? 0);
    const due = Math.max(0, subtractMoney(sale.total, paid));
    addIndexedMoney(productDueByMember, sale.memberId, due);
  }

  const indexes: SelectorIndexes = {
    currentMembershipByMember,
    paymentsByMembership,
    paymentsBySale,
    membershipDueByMember,
    productDueByMember,
    membersById: new Map(s.members.map((member) => [member.id, member])),
    salesById: new Map(s.sales.map((sale) => [sale.id, sale])),
  };
  selectorIndexesByState.set(s, indexes);
  return indexes;
}

export function currentMembership(s: GymState, memberId: string): Membership | undefined {
  return selectorIndexes(s).currentMembershipByMember.get(memberId);
}

export function membershipHistory(s: GymState, memberId: string) {
  return s.memberships
    .filter((m) => m.memberId === memberId)
    .sort((a, b) => +new Date(b.startDate) - +new Date(a.startDate));
}

export function statusOf(s: GymState, memberId: string): MemberStatus {
  const ms = currentMembership(s, memberId);
  if (!ms) return "unassigned";
  if (ms.frozen) return "frozen";
  const left = daysUntil(ms.endDate);
  if (left < 0) return "expired";
  if (left <= s.settings.expiryReminderDays) return "expiring";
  return "active";
}

export type MembershipRosterEntry = {
  member: Member;
  ms: Membership | undefined;
  status: MemberStatus;
};

/**
 * Registered-member lifecycle rows shared by membership follow-up views.
 * Members without a current term are unassigned and remain visible for follow-up
 * rather than being counted as expired or silently dropped from the roster.
 */
export function membershipRoster(s: GymState): MembershipRosterEntry[] {
  return gymMembers(s)
    .map((member) => ({
      member,
      ms: currentMembership(s, member.id),
      status: statusOf(s, member.id),
    }))
    .sort((a, b) => {
      if (!a.ms) return b.ms ? 1 : a.member.name.localeCompare(b.member.name);
      if (!b.ms) return -1;
      return +parseCalendarDate(a.ms.endDate) - +parseCalendarDate(b.ms.endDate);
    });
}

export const isCurrentMemberStatus = (status: MemberStatus) =>
  status === "active" || status === "expiring";

export function paidFor(s: GymState, membershipId: string) {
  return selectorIndexes(s).paymentsByMembership.get(membershipId) ?? 0;
}

export function membershipPayable(membership: Membership) {
  return addMoney(subtractMoney(membership.price, membership.discount), membership.joiningFee ?? 0);
}

export function dueFor(s: GymState, memberId: string) {
  return selectorIndexes(s).membershipDueByMember.get(memberId) ?? 0;
}

export function productDueFor(s: GymState, memberId: string) {
  return selectorIndexes(s).productDueByMember.get(memberId) ?? 0;
}

export function outstandingFor(s: GymState, memberId: string) {
  return addMoney(dueFor(s, memberId), productDueFor(s, memberId));
}

export function totalDue(s: GymState) {
  return sumMoney(activeMembers(s), (member) => outstandingFor(s, member.id));
}

export function totalRevenue(s: GymState, from?: Date) {
  return sumMoney(
    s.payments.filter((p) => (from ? new Date(p.date) >= from : true)),
    (payment) => payment.amount,
  );
}

export const liveProducts = (s: GymState) => s.products.filter((p) => !p.deletedAt);
export const trashedProducts = (s: GymState) => s.products.filter((p) => p.deletedAt);

export function lowStock(s: GymState): Product[] {
  return liveProducts(s).filter((p) => p.stock <= p.lowStockAt);
}

/** Amount collected against a product sale. Legacy sales were always fully paid. */
export function salePaid(s: GymState, sale: Sale) {
  if (typeof sale.paid !== "number") return sale.total;
  return selectorIndexes(s).paymentsBySale.get(sale.id) ?? 0;
}

export function saleDue(s: GymState, sale: Sale) {
  return Math.max(0, subtractMoney(sale.total, salePaid(s, sale)));
}

export const salesFor = (s: GymState, memberId: string) =>
  s.sales.filter((x) => x.memberId === memberId);

export const pendingSales = (s: GymState) => s.sales.filter((x) => saleDue(s, x) > 0);

export function profitOfSales(s: GymState, from?: Date) {
  return sumMoney(
    s.sales.filter((sale) => (from ? new Date(sale.date) >= from : true)),
    (sale) => subtractMoney(sale.total, multiplyMoney(sale.unitCost, sale.qty)),
  );
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
      mk(formatDayMonth(d), d, e);
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
      mk(formatMonth(d), d, e);
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
    const membership = sumMoney(
      s.payments.filter((p) => p.kind === "membership" && inRange(p.date)),
      (payment) => payment.amount,
    );
    const product = sumMoney(
      s.payments.filter((p) => p.kind === "product" && inRange(p.date)),
      (payment) => payment.amount,
    );
    const other = sumMoney(
      s.payments.filter((p) => p.kind === "other" && inRange(p.date)),
      (payment) => payment.amount,
    );
    return {
      label: b.label,
      membership,
      product,
      other,
      total: addMoney(addMoney(membership, product), other),
    };
  });
}

function planDistributionFor(s: GymState, activeOnly: boolean) {
  const memberCountsByPlan = new Map<string, number>();
  for (const member of gymMembers(s)) {
    if (activeOnly && !isCurrentMemberStatus(statusOf(s, member.id))) continue;
    const planId = currentMembership(s, member.id)?.planId;
    if (planId) memberCountsByPlan.set(planId, (memberCountsByPlan.get(planId) ?? 0) + 1);
  }

  return livePlans(s)
    .map((plan) => ({
      name: plan.name,
      value: memberCountsByPlan.get(plan.id) ?? 0,
    }))
    .filter((p) => p.value > 0);
}

/** Current roster distribution, including frozen and expired memberships. */
export function planDistribution(s: GymState) {
  return planDistributionFor(s, false);
}

/** Dashboard distribution matching the active/expiring member KPI. */
export function activePlanDistribution(s: GymState) {
  return planDistributionFor(s, true);
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
    entry.revenue = addMoney(entry.revenue, sale.total);
    entry.profit = addMoney(
      entry.profit,
      subtractMoney(sale.total, multiplyMoney(sale.unitCost, sale.qty)),
    );
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
  const { membersById, salesById } = selectorIndexes(s);
  return s.payments
    .slice()
    .sort((a, b) => +new Date(b.date) - +new Date(a.date))
    .map((p) => ({
      ...p,
      who:
        p.payerName?.trim() ||
        (membersById.get(p.memberId ?? "")?.name ??
          salesById.get(p.saleId ?? "")?.buyer ??
          "Walk-in customer"),
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
  /** Optional search params applied when the notification is clicked. */
  search?: Record<string, string>;
};

export function birthdayOffset(dob: string, now = new Date()) {
  // DOB is a calendar date, not a time-zone-dependent instant. Taking its
  // YYYY-MM-DD part also preserves older records saved at midnight UTC.
  const dateOnly = /^(\d{4}-\d{2}-\d{2})/.exec(dob)?.[1] ?? dob;
  const d = parseCalendarDate(dateOnly);
  if (!Number.isFinite(d.getTime())) return -1;
  const todayNumber = calendarDayNumber(now);
  let next = new Date(now.getFullYear(), d.getMonth(), d.getDate());
  if (calendarDayNumber(next) < todayNumber) {
    next = new Date(now.getFullYear() + 1, d.getMonth(), d.getDate());
  }
  return Math.round(calendarDayNumber(next) - todayNumber);
}

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
        href: `/members/${m.id}`,
        search: { tab: "payments" },
      });
    }

    const saleDues = salesFor(s, m.id).filter((x) => saleDue(s, x) > 0);
    if (saleDues.length > 0) {
      const amount = saleDues.reduce((sum, x) => sum + saleDue(s, x), 0);
      list.push({
        id: `sdue_${m.id}`,
        category: "due",
        title: m.name,
        description: `Pending product payment — ${money(amount, s.settings.currency)}`,
        date: saleDues[0]!.date,
        tone: "warning",
        href: `/members/${m.id}`,
        search: { tab: "purchases" },
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
          href: `/members/${m.id}`,
          search: { tab: "history" },
        });
      }
    }

    const bday = m.dob ? birthdayOffset(m.dob) : -1;
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

  // Walk-in customers have no profile — link straight to the sale invoice.
  pendingSales(s)
    .filter((x) => !x.memberId)
    .forEach((x) => {
      list.push({
        id: `sdue_${x.id}`,
        category: "due",
        title: x.buyer,
        description: `Pending product payment — ${money(saleDue(s, x), s.settings.currency)} · ${x.invoiceNo}`,
        date: x.date,
        tone: "warning",
        href: "/products",
        search: { sale: x.id },
      });
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

  const isTodayBirthday = (n: Notification) =>
    n.category === "birthday" && n.description === "Birthday today";

  return list.sort((a, b) => {
    const pa = isTodayBirthday(a) ? 1 : 0;
    const pb = isTodayBirthday(b) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return +new Date(b.date) - +new Date(a.date);
  });
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

/* ---------------- Expenses & finance ---------------- */

export const liveExpenses = (s: GymState) => (s.expenses ?? []).filter((e) => !e.deletedAt);
export const trashedExpenses = (s: GymState) => (s.expenses ?? []).filter((e) => e.deletedAt);

export function rangeWindow(range: Range): { start: Date; end: Date } {
  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (range === "weekly") {
    const daysSinceMonday = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - daysSinceMonday);
  }
  if (range === "monthly") start.setDate(1);
  if (range === "yearly") start.setMonth(0, 1);
  return { start, end };
}

export const inWindow = (date: string, w: { start: Date; end: Date }) => {
  const t = new Date(date).getTime();
  return t >= w.start.getTime() && t <= w.end.getTime();
};

export function expensesInRange(s: GymState, range: Range) {
  const w = rangeWindow(range);
  return liveExpenses(s).filter((e) => inWindow(e.date, w));
}

export function revenueInRange(s: GymState, range: Range) {
  const w = rangeWindow(range);
  return sumMoney(
    s.payments.filter((p) => inWindow(p.date, w)),
    (payment) => payment.amount,
  );
}

export function expenseTotal(list: Array<{ amount: number }>) {
  return sumMoney(list, (expense) => expense.amount);
}

export function expenseSeries(s: GymState, range: Range) {
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
      mk(formatDayMonth(d), d, e);
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
      mk(formatMonth(d), d, e);
    }
  } else {
    for (let i = 4; i >= 0; i--) {
      const y = now.getFullYear() - i;
      mk(String(y), new Date(y, 0, 1), new Date(y, 11, 31, 23, 59, 59));
    }
  }

  const list = liveExpenses(s);
  return buckets.map((b) => ({
    label: b.label,
    total: sumMoney(
      list.filter((e) => inWindow(e.date, b)),
      (expense) => expense.amount,
    ),
  }));
}

export function expenseByCategory(s: GymState, range: Range) {
  const map = new Map<string, number>();
  expensesInRange(s, range).forEach((e) => {
    map.set(e.category, addMoney(map.get(e.category) ?? 0, e.amount));
  });
  return Array.from(map.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
}
