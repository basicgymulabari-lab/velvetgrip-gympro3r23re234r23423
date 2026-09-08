import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
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
import {
  Crop,
  Eye,
  FileText,
  Lock,
  LockOpen,
  Paperclip,
  Pencil,
  Plus,
  Search,
  Trash2,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app/AppShell";
import { PageHeader, Panel, EmptyState } from "@/components/app/Panel";
import { TablePager } from "@/components/app/TablePager";
import { AppDatePicker } from "@/components/app/AppDatePicker";
import { formatDayMonth, localDateInput } from "@/lib/gym/calendar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { addExpense, trashExpense, updateExpense, useGym } from "@/lib/gym/store";
import {
  expenseByCategory,
  expenseSeries,
  expenseTotal,
  expensesInRange,
  liveExpenses,
  money,
  revenueInRange,
  shortDate,
  inWindow,
  type Range,
} from "@/lib/gym/selectors";
import type { Expense, ExpenseAttachment, ExpenseCategory, PaymentMethod } from "@/lib/gym/types";

export const Route = createFileRoute("/expenses")({
  head: () => ({
    meta: [
      { title: "Expenses & Finance — IRONVAULT Gym Management" },
      {
        name: "description",
        content:
          "Track gym expenses with attachments, category analytics and live net profit against collected revenue — fully offline.",
      },
      { property: "og:title", content: "Expenses & Finance — IRONVAULT Gym Management" },
      {
        property: "og:description",
        content: "Expense entry, receipts, category charts and net profit tracking.",
      },
    ],
  }),
  component: () => (
    <AppShell>
      <ExpensesPage />
    </AppShell>
  ),
});

const CATEGORIES: ExpenseCategory[] = [
  "Rent",
  "Salaries",
  "Utilities",
  "Equipment",
  "Maintenance",
  "Marketing",
  "Supplies",
  "Other",
];

const METHODS: PaymentMethod[] = ["cash", "upi", "card", "bank", "cheque", "other"];
const RANGES: Range[] = ["daily", "weekly", "monthly", "yearly"];
type ExpenseRange = Range | "custom";
const RANGE_LABEL: Record<Range, string> = {
  daily: "Today",
  weekly: "This week",
  monthly: "This month",
  yearly: "This year",
};

const CHART_COLORS = [
  "oklch(0.78 0.12 85)",
  "oklch(0.7 0.11 160)",
  "oklch(0.72 0.1 235)",
  "oklch(0.62 0.02 260)",
  "oklch(0.76 0.12 55)",
  "oklch(0.68 0.09 320)",
  "oklch(0.74 0.1 200)",
  "oklch(0.66 0.06 30)",
];

const PAGE_SIZE = 10;
const MAX_ATTACHMENT = 5 * 1024 * 1024;
const ALLOWED_TYPES = ["application/pdf", "image/jpeg", "image/jpg", "image/png"];

const daysAgoInput = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return localDateInput(date);
};

const dateWindow = (start: string, end: string) => ({
  start: new Date(`${start}T00:00:00`),
  end: new Date(`${end}T23:59:59.999`),
});

function customExpenseSeries(expenses: Expense[], start: string, end: string) {
  const window = dateWindow(start, end);
  if (window.end < window.start) return [];
  const day = 86_400_000;
  const spanDays = Math.floor((window.end.getTime() - window.start.getTime()) / day) + 1;
  const bucketDays = spanDays <= 45 ? 1 : spanDays <= 370 ? 7 : 30;
  const result: Array<{ label: string; total: number }> = [];
  for (let cursor = new Date(window.start); cursor <= window.end;) {
    const bucketStart = new Date(cursor);
    const bucketEnd = new Date(cursor);
    bucketEnd.setDate(bucketEnd.getDate() + bucketDays - 1);
    bucketEnd.setHours(23, 59, 59, 999);
    if (bucketEnd > window.end) bucketEnd.setTime(window.end.getTime());
    result.push({
      label:
        bucketDays === 1
          ? formatDayMonth(bucketStart)
          : `${formatDayMonth(bucketStart)}–${formatDayMonth(bucketEnd)}`,
      total: expenses
        .filter((expense) => inWindow(expense.date, { start: bucketStart, end: bucketEnd }))
        .reduce((sum, expense) => sum + expense.amount, 0),
    });
    cursor = new Date(bucketEnd);
    cursor.setMilliseconds(cursor.getMilliseconds() + 1);
  }
  return result;
}

function categoryTotals(expenses: Expense[]) {
  const totals = expenses.reduce<Record<string, number>>((all, expense) => {
    all[expense.category] = (all[expense.category] ?? 0) + expense.amount;
    return all;
  }, {});
  return Object.entries(totals)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
}

function ExpensesPage() {
  const state = useGym();
  const [range, setRange] = useState<ExpenseRange>("monthly");
  const [customStart, setCustomStart] = useState(daysAgoInput(29));
  const [customEnd, setCustomEnd] = useState(localDateInput(new Date()));
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [confirm, setConfirm] = useState<Expense | null>(null);
  const [preview, setPreview] = useState<Expense | null>(null);

  const scoped = useMemo(() => {
    if (!state) return [];
    if (range !== "custom") return expensesInRange(state, range);
    const window = dateWindow(customStart, customEnd);
    if (window.end < window.start) return [];
    return liveExpenses(state).filter((expense) => inWindow(expense.date, window));
  }, [state, range, customStart, customEnd]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return scoped;
    return scoped.filter((e) =>
      `${e.expenseNo} ${e.title} ${e.category} ${e.notes} ${e.method}`
        .toLowerCase()
        .includes(needle),
    );
  }, [scoped, q]);

  if (!state) return null;
  const cur = state.settings.currency;
  const customDateWindow = dateWindow(customStart, customEnd);
  const customValid = customDateWindow.start <= customDateWindow.end;
  const rangeLabel = range === "custom" ? "Custom range" : RANGE_LABEL[range];

  const revenue =
    range === "custom"
      ? state.payments
          .filter((payment) => customValid && inWindow(payment.date, customDateWindow))
          .reduce((sum, payment) => sum + payment.amount, 0)
      : revenueInRange(state, range);
  // Search only narrows the table; finance cards must continue to represent
  // the complete selected date range.
  const expenses = expenseTotal(scoped);
  const profit = revenue - expenses;
  const series =
    range === "custom"
      ? customExpenseSeries(scoped, customStart, customEnd)
      : expenseSeries(state, range);
  const byCategory = range === "custom" ? categoryTotals(scoped) : expenseByCategory(state, range);
  const paged = filtered
    .slice()
    .sort((a, b) => +new Date(b.date) - +new Date(a.date))
    .slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <>
      <PageHeader
        title="Expenses & Finance"
        subtitle="Every card, table and chart below follows the selected date filter"
        actions={
          <Button
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" /> Add Expense
          </Button>
        }
      />

      <div className="mb-6 flex flex-wrap gap-2">
        {RANGES.map((r) => (
          <button
            key={r}
            onClick={() => {
              setRange(r);
              setPage(1);
            }}
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
          onClick={() => {
            setRange("custom");
            setPage(1);
          }}
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

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Metric
          icon={Wallet}
          label={`Collected revenue · ${rangeLabel}`}
          value={money(revenue, cur)}
          hint="Membership payments + product sales"
          tone="success"
        />
        <Metric
          icon={TrendingDown}
          label={`Total expenses · ${rangeLabel}`}
          value={money(expenses, cur)}
          hint="Every expense entry in range"
          tone="warning"
        />
        <Metric
          icon={TrendingUp}
          label={`Net profit · ${rangeLabel}`}
          value={money(profit, cur)}
          hint="Revenue − Expenses"
          tone={profit >= 0 ? "gold" : "warning"}
        />
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Panel title={`Expenses — ${range}`}>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={series}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  dataKey="label"
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
                  width={56}
                />
                <Tooltip
                  cursor={{ fill: "rgba(212,175,55,0.08)" }}
                  contentStyle={{
                    background: "#111111",
                    border: "1px solid rgba(212,175,55,0.35)",
                    borderRadius: 12,
                    color: "#fff",
                  }}
                  formatter={(v: number) => money(v, cur)}
                />
                <Bar dataKey="total" fill="#D4AF37" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Category-wise distribution">
          {byCategory.length === 0 ? (
            <EmptyState title="No expenses in this range" hint="Add an expense to see the split." />
          ) : (
            <>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={byCategory}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={55}
                      outerRadius={92}
                      paddingAngle={5}
                      cornerRadius={6}
                    >
                      {byCategory.map((_, i) => (
                        <Cell
                          key={i}
                          fill={CHART_COLORS[i % CHART_COLORS.length]}
                          stroke="transparent"
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      content={({ active, payload }) =>
                        active && payload?.length ? (
                          <div className="rounded-xl border border-gold/60 bg-popover px-3.5 py-2.5 text-xs shadow-lg">
                            <p className="font-semibold text-gold">{payload[0].name}</p>
                            <p className="mt-0.5 font-medium text-gold/90">
                              {money(Number(payload[0].value), cur)}
                            </p>
                          </div>
                        ) : null
                      }
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <ul className="mt-4 space-y-2 text-sm">
                {byCategory.map((d, i) => (
                  <li key={d.name} className="flex items-center justify-between">
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
                      />
                      {d.name}
                    </span>
                    <span className="font-medium">{money(d.value, cur)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>
      </div>

      <Panel>
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search ID, title, category, notes or method"
            value={q}
            maxLength={60}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
        </div>

        <div className="mt-5 overflow-x-auto">
          {paged.length === 0 ? (
            <EmptyState
              title="No expenses found"
              hint="Adjust the filter or record a new expense."
            />
          ) : (
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="py-3">Expense ID</th>
                  <th className="py-3">Title</th>
                  <th className="py-3">Category</th>
                  <th className="py-3">Method</th>
                  <th className="py-3">Date</th>
                  <th className="py-3">Attachment</th>
                  <th className="py-3 text-right">Amount</th>
                  <th className="py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((e) => (
                  <tr key={e.id} className="border-b border-border/50 hover:bg-secondary/40">
                    <td className="py-3 font-medium text-gold">
                      <span className="inline-flex items-center gap-1.5">
                        {e.expenseNo}
                        {e.locked !== false ? (
                          <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-label="Locked" />
                        ) : (
                          <LockOpen className="h-3.5 w-3.5 text-warning" aria-label="Unlocked" />
                        )}
                      </span>
                    </td>
                    <td className="py-3">
                      <p className="font-medium">{e.title}</p>
                      {e.notes && <p className="text-xs text-muted-foreground">{e.notes}</p>}
                    </td>
                    <td className="py-3 text-muted-foreground">{e.category}</td>
                    <td className="py-3 capitalize text-muted-foreground">{e.method}</td>
                    <td className="py-3 text-muted-foreground">{shortDate(e.date)}</td>
                    <td className="py-3">
                      {e.attachment ? (
                        <button
                          onClick={() => setPreview(e)}
                          className="inline-flex items-center gap-1.5 text-xs font-medium text-gold hover:underline"
                        >
                          <Paperclip className="h-3.5 w-3.5" /> View Attachment
                        </button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="py-3 text-right font-medium">{money(e.amount, cur)}</td>
                    <td className="py-3">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label="Edit expense"
                          onClick={() => {
                            setEditing(e);
                            setFormOpen(true);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className={`h-8 w-8 ${
                            e.locked !== false
                              ? "cursor-not-allowed text-muted-foreground/40"
                              : "text-destructive hover:text-destructive"
                          }`}
                          aria-label={
                            e.locked !== false
                              ? "Expense locked. Edit and unlock before deleting"
                              : "Delete expense"
                          }
                          title={
                            e.locked !== false
                              ? "Locked — open Edit Expense and unlock it before deleting"
                              : "Move expense to Trash"
                          }
                          onClick={() => {
                            if (e.locked !== false) {
                              toast.info("This expense is locked. Open the pencil icon and unlock it first.");
                              return;
                            }
                            setConfirm(e);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <TablePager page={page} pageSize={PAGE_SIZE} total={filtered.length} onPage={setPage} />
      </Panel>

      <ExpenseFormDialog
        open={formOpen}
        expense={editing}
        onOpenChange={(v) => {
          setFormOpen(v);
          if (!v) setEditing(null);
        }}
      />

      <Dialog open={Boolean(confirm)} onOpenChange={(v) => !v && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display text-2xl tracking-wide">
              Move this expense to Trash?
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            <strong>{confirm?.title}</strong> will be moved to Trash and stays recoverable for 30
            days. It is never permanently deleted from here.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (confirm) {
                  if (trashExpense(confirm.id)) toast.success("Expense moved to Trash");
                  else toast.error("This expense is locked. Unlock it from Edit Expense first.");
                }
                setConfirm(null);
              }}
            >
              Move to Trash
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AttachmentPreview expense={preview} onClose={() => setPreview(null)} />
    </>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: typeof Wallet;
  label: string;
  value: string;
  hint: string;
  tone: "gold" | "success" | "warning";
}) {
  const map = {
    gold: "text-gold border-gold/35 bg-gold/10",
    success: "text-success border-success/35 bg-success/10",
    warning: "text-warning border-warning/35 bg-warning/10",
  };
  return (
    <div className="surface-panel flex items-center gap-4 rounded-2xl p-5">
      <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl border ${map[tone]}`}>
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
        <p className="truncate font-display text-2xl">{value}</p>
        <p className="truncate text-[11px] text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

function AttachmentPreview({ expense, onClose }: { expense: Expense | null; onClose: () => void }) {
  if (!expense?.attachment) return null;
  const att = expense.attachment;
  const isPdf = att.type === "application/pdf";
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl tracking-wide">
            {expense.title} — Attachment
          </DialogTitle>
        </DialogHeader>
        <div className="rounded-xl border border-border bg-card p-3">
          {isPdf ? (
            <iframe title={att.name} src={att.dataUrl} className="h-[70vh] w-full rounded-lg" />
          ) : (
            <img src={att.dataUrl} alt={att.name} className="mx-auto max-h-[70vh] rounded-lg" />
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted-foreground">
            {att.name} · {(att.size / 1024).toFixed(0)} KB
          </p>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function todayInput() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ExpenseFormDialog({
  open,
  expense,
  onOpenChange,
}: {
  open: boolean;
  expense: Expense | null;
  onOpenChange: (v: boolean) => void;
}) {
  const key = expense?.id ?? "new";
  const [title, setTitle] = useState(expense?.title ?? "");
  const [category, setCategory] = useState<ExpenseCategory>(expense?.category ?? "Rent");
  const [amount, setAmount] = useState(expense ? String(expense.amount) : "");
  const [date, setDate] = useState(expense ? expense.date.slice(0, 10) : todayInput());
  const [method, setMethod] = useState<PaymentMethod>(expense?.method ?? "cash");
  const [notes, setNotes] = useState(expense?.notes ?? "");
  const [locked, setLocked] = useState(expense ? expense.locked !== false : true);
  const [attachment, setAttachment] = useState<ExpenseAttachment | null>(
    expense?.attachment ?? null,
  );
  const [cropFile, setCropFile] = useState<{
    source: string;
    name: string;
    type: string;
  } | null>(null);
  const [loadedKey, setLoadedKey] = useState(key);
  const fileRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);

  if (loadedKey !== key) {
    setLoadedKey(key);
    setTitle(expense?.title ?? "");
    setCategory(expense?.category ?? "Rent");
    setAmount(expense ? String(expense.amount) : "");
    setDate(expense ? expense.date.slice(0, 10) : todayInput());
    setMethod(expense?.method ?? "cash");
    setNotes(expense?.notes ?? "");
    setLocked(expense ? expense.locked !== false : true);
    setAttachment(expense?.attachment ?? null);
  }

  const amountValue = Number(amount);
  const futureDate = date > todayInput();
  const errors = {
    title: title.trim().length === 0 ? "Expense title is required" : "",
    amount:
      !amount || Number.isNaN(amountValue) || amountValue <= 0
        ? "Amount must be greater than ₹0"
        : "",
    date: futureDate ? "Future dates are not allowed" : "",
  };
  const valid = !errors.title && !errors.amount && !errors.date;

  const pickFile = (file?: File | null) => {
    if (!file) return;
    if (!ALLOWED_TYPES.includes(file.type)) {
      toast.error("Only PDF, JPG and PNG files are allowed");
      return;
    }
    if (file.size > MAX_ATTACHMENT) {
      toast.error("Attachment must be 5 MB or smaller");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      if (file.type === "application/pdf") {
        setAttachment({ name: file.name, type: file.type, size: file.size, dataUrl });
      } else {
        setCropFile({ source: dataUrl, name: file.name, type: file.type });
      }
    };
    reader.readAsDataURL(file);
  };

  const submit = () => {
    if (submittingRef.current) return;
    if (!valid) {
      toast.error(errors.title || errors.amount || errors.date);
      return;
    }
    submittingRef.current = true;
    const payload = {
      title,
      category,
      amount: amountValue,
      date: new Date(`${date}T12:00:00`).toISOString(),
      method,
      notes,
      attachment,
      ...(expense ? { locked } : {}),
    };
    try {
      if (expense) {
        updateExpense(expense.id, payload);
        toast.success("Expense updated");
      } else {
        addExpense(payload);
        toast.success("Expense recorded");
      }
      onOpenChange(false);
    } finally {
      submittingRef.current = false;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl tracking-wide">
            {expense ? "Edit Expense" : "Add Expense"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div
            className={`flex items-center justify-between gap-4 rounded-xl border p-4 ${
              locked ? "border-border bg-secondary/30" : "border-warning/40 bg-warning/10"
            }`}
          >
            <div className="flex min-w-0 items-start gap-3">
              {locked ? (
                <Lock className="mt-0.5 h-5 w-5 shrink-0 text-gold" />
              ) : (
                <LockOpen className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
              )}
              <div>
                <p className="text-sm font-medium">
                  {expense ? (locked ? "Expense locked" : "Expense unlocked") : "Expense will be locked"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {expense
                    ? locked
                      ? "Deletion is blocked. Turn this off and save changes before moving the expense to Trash."
                      : "Deletion is enabled after you save these changes."
                    : "New expenses are automatically protected from deletion."}
                </p>
              </div>
            </div>
            {expense && (
              <Switch
                checked={locked}
                onCheckedChange={setLocked}
                aria-label={locked ? "Unlock expense" : "Lock expense"}
              />
            )}
          </div>

          <div className="space-y-2">
            <Label>Expense title</Label>
            <Input
              value={title}
              maxLength={80}
              placeholder="Electricity bill"
              onChange={(e) => setTitle(e.target.value)}
            />
            {errors.title && <p className="text-xs text-destructive">{errors.title}</p>}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Category</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as ExpenseCategory)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Payment method</Label>
              <Select value={method} onValueChange={(v) => setMethod(v as PaymentMethod)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {METHODS.map((m) => (
                    <SelectItem key={m} value={m} className="capitalize">
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Amount</Label>
              <Input
                type="number"
                min={1}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              {errors.amount && <p className="text-xs text-destructive">{errors.amount}</p>}
            </div>
            <div className="space-y-2">
              <Label>Date</Label>
              <AppDatePicker
                value={date}
                max={new Date()}
                onChange={setDate}
                placeholder="Select expense date"
              />
              {errors.date && <p className="text-xs text-destructive">{errors.date}</p>}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Notes</Label>
            <Input
              value={notes}
              maxLength={160}
              placeholder="Optional note"
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Attachment (PDF, JPG, PNG · max 5 MB)</Label>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,image/jpeg,image/png"
              className="hidden"
              onChange={(e) => {
                pickFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
                <Paperclip className="mr-1.5 h-3.5 w-3.5" /> Choose file
              </Button>
              {attachment && (
                <>
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <FileText className="h-3.5 w-3.5" /> {attachment.name}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setAttachment(null)}
                  >
                    Remove
                  </Button>
                </>
              )}
            </div>
            {attachment && (
              <div className="rounded-xl border border-border bg-card p-3">
                {attachment.type === "application/pdf" ? (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Eye className="h-3.5 w-3.5" /> PDF attached — preview available from the table
                  </p>
                ) : (
                  <img
                    src={attachment.dataUrl}
                    alt={attachment.name}
                    className="mx-auto max-h-40 rounded-lg"
                  />
                )}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={!valid} onClick={submit}>
              {expense ? "Save changes" : "Add expense"}
            </Button>
          </div>
        </div>

        <ExpenseImageCropDialog
          file={cropFile}
          onCancel={() => setCropFile(null)}
          onComplete={(cropped) => {
            setAttachment(cropped);
            setCropFile(null);
            toast.success("Image cropped and ready");
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

type CropRect = { x: number; y: number; width: number; height: number };
type CropHandle = "move" | "nw" | "ne" | "sw" | "se";

function ExpenseImageCropDialog({
  file,
  onCancel,
  onComplete,
}: {
  file: { source: string; name: string; type: string } | null;
  onCancel: () => void;
  onComplete: (attachment: ExpenseAttachment) => void;
}) {
  const [rect, setRect] = useState<CropRect>({ x: 5, y: 5, width: 90, height: 90 });
  const [saving, setSaving] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{
    handle: CropHandle;
    clientX: number;
    clientY: number;
    rect: CropRect;
  } | null>(null);
  useEffect(() => {
    setRect({ x: 5, y: 5, width: 90, height: 90 });
    setSaving(false);
    dragRef.current = null;
  }, [file?.source]);

  const startDrag = (event: React.PointerEvent, handle: CropHandle) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { handle, clientX: event.clientX, clientY: event.clientY, rect };
  };

  const drag = (event: React.PointerEvent) => {
    const active = dragRef.current;
    const image = imageRef.current;
    if (!active || !image) return;
    const bounds = image.getBoundingClientRect();
    const dx = ((event.clientX - active.clientX) / bounds.width) * 100;
    const dy = ((event.clientY - active.clientY) / bounds.height) * 100;
    const start = active.rect;
    const minimum = 8;
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

    if (active.handle === "move") {
      setRect({
        ...start,
        x: clamp(start.x + dx, 0, 100 - start.width),
        y: clamp(start.y + dy, 0, 100 - start.height),
      });
      return;
    }

    let left = start.x;
    let top = start.y;
    let right = start.x + start.width;
    let bottom = start.y + start.height;
    if (active.handle.includes("w")) left = clamp(start.x + dx, 0, right - minimum);
    if (active.handle.includes("e")) right = clamp(right + dx, left + minimum, 100);
    if (active.handle.includes("n")) top = clamp(start.y + dy, 0, bottom - minimum);
    if (active.handle.includes("s")) bottom = clamp(bottom + dy, top + minimum, 100);
    setRect({ x: left, y: top, width: right - left, height: bottom - top });
  };

  const saveCrop = () => {
    const image = imageRef.current;
    if (!file || !image) return;
    setSaving(true);
    const sourceX = Math.round((rect.x / 100) * image.naturalWidth);
    const sourceY = Math.round((rect.y / 100) * image.naturalHeight);
    const sourceWidth = Math.max(1, Math.round((rect.width / 100) * image.naturalWidth));
    const sourceHeight = Math.max(1, Math.round((rect.height / 100) * image.naturalHeight));
    const scale = Math.min(1, 1800 / Math.max(sourceWidth, sourceHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      setSaving(false);
      toast.error("Image could not be cropped. Please try again.");
      return;
    }
    context.drawImage(
      image,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    const outputType = file.type === "image/png" ? "image/png" : "image/jpeg";
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setSaving(false);
          toast.error("Image could not be cropped. Please try again.");
          return;
        }
        if (blob.size > MAX_ATTACHMENT) {
          setSaving(false);
          toast.error("Cropped image must be 5 MB or smaller");
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          setSaving(false);
          onComplete({
            name: file.name.replace(/(\.[^.]+)?$/, "-cropped$1"),
            type: outputType,
            size: blob.size,
            dataUrl: String(reader.result),
          });
        };
        reader.onerror = () => {
          setSaving(false);
          toast.error("Cropped image could not be saved");
        };
        reader.readAsDataURL(blob);
      },
      outputType,
      0.9,
    );
  };

  return (
    <Dialog open={Boolean(file)} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display text-2xl tracking-wide">
            <Crop className="h-5 w-5 text-gold" /> Crop attachment
          </DialogTitle>
        </DialogHeader>
        {file && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Drag inside the frame to move it. Drag any of the four corner points to resize it.
            </p>
            <div className="flex max-h-[56vh] justify-center overflow-auto rounded-2xl border border-border bg-black/70 p-3">
              <div className="relative inline-block touch-none select-none overflow-hidden">
                <img
                  ref={imageRef}
                  src={file.source}
                  alt="Attachment crop preview"
                  draggable={false}
                  className="block max-h-[50vh] max-w-full object-contain"
                />
                <div
                  className="absolute cursor-move touch-none border-2 border-gold shadow-[0_0_0_1px_rgba(255,255,255,0.65)]"
                  style={{
                    left: `${rect.x}%`,
                    top: `${rect.y}%`,
                    width: `${rect.width}%`,
                    height: `${rect.height}%`,
                    boxShadow:
                      "0 0 0 1px rgba(255,255,255,0.65), 0 0 0 9999px rgba(0,0,0,0.55)",
                  }}
                  onPointerDown={(event) => startDrag(event, "move")}
                  onPointerMove={drag}
                  onPointerUp={() => (dragRef.current = null)}
                  onPointerCancel={() => (dragRef.current = null)}
                >
                  {(["nw", "ne", "sw", "se"] as const).map((handle) => (
                    <span
                      key={handle}
                      role="slider"
                      aria-label={`${handle.toUpperCase()} crop corner`}
                      tabIndex={0}
                      className={`absolute h-5 w-5 rounded-full border-2 border-black bg-gold shadow-md ${
                        handle === "nw"
                          ? "-left-2.5 -top-2.5 cursor-nwse-resize"
                          : handle === "ne"
                            ? "-right-2.5 -top-2.5 cursor-nesw-resize"
                            : handle === "sw"
                              ? "-bottom-2.5 -left-2.5 cursor-nesw-resize"
                              : "-bottom-2.5 -right-2.5 cursor-nwse-resize"
                      }`}
                      onPointerDown={(event) => startDrag(event, handle)}
                      onPointerMove={drag}
                      onPointerUp={() => (dragRef.current = null)}
                      onPointerCancel={() => (dragRef.current = null)}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onCancel}>
                Cancel
              </Button>
              <Button type="button" disabled={saving} onClick={saveCrop}>
                <Crop className="mr-2 h-4 w-4" /> {saving ? "Cropping..." : "Use cropped image"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
