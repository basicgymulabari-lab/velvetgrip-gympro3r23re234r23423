import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  ArrowLeft,
  Mail,
  Phone,
  MapPin,
  Cake,
  ShieldAlert,
  Plus,
  RefreshCw,
  Snowflake,
  Pencil,
  Wallet,
  Eye,
} from "lucide-react";
import { toast } from "sonner";
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import { AppShell } from "@/components/app/AppShell";
import { PageHeader, Panel, EmptyState } from "@/components/app/Panel";
import { StatusBadge } from "@/components/app/StatCard";
import { MemberFormDialog } from "@/components/app/MemberFormDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { InvoiceDialog, type InvoiceData } from "@/components/app/InvoiceDialog";
import {
  addMeasurement,
  addNote,
  addPayment,
  renewMembership,
  toggleFreeze,
  useGym,
} from "@/lib/gym/store";
import {
  currentMembership,
  dueFor,
  membershipHistory,
  money,
  paidFor,
  planOf,
  shortDate,
  statusOf,
} from "@/lib/gym/selectors";
import type { Membership, Payment } from "@/lib/gym/types";

export const Route = createFileRoute("/members/$memberId")({
  head: () => ({
    meta: [
      { title: "Member Profile — IRONVAULT Gym Management" },
      {
        name: "description",
        content:
          "Complete member profile with membership history, payments, body measurements and progress notes.",
      },
      { property: "og:title", content: "Member Profile — IRONVAULT Gym Management" },
      {
        property: "og:description",
        content: "Membership history, dues, measurements and trainer progress notes in one profile.",
      },
    ],
  }),
  component: () => (
    <AppShell>
      <MemberProfile />
    </AppShell>
  ),
});

function MemberProfile() {
  const state = useGym();
  const { memberId } = Route.useParams();
  const navigate = useNavigate();
  const [editOpen, setEditOpen] = useState(false);
  const [renewOpen, setRenewOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [msrOpen, setMsrOpen] = useState(false);
  const [collectFor, setCollectFor] = useState<Membership | null>(null);
  const [invoice, setInvoice] = useState<InvoiceData | null>(null);

  const member = state?.members.find((m) => m.id === memberId);

  const chart = useMemo(
    () =>
      (member?.measurements ?? [])
        .slice()
        .sort((a, b) => +new Date(a.date) - +new Date(b.date))
        .map((m) => ({
          label: shortDate(m.date),
          weight: Math.round(m.weightKg * 10) / 10,
          bodyFat: Math.round(m.bodyFat * 10) / 10,
        })),
    [member],
  );

  if (!state) return null;
  if (!member) {
    return (
      <EmptyState title="Member not found" hint="This record may have been permanently deleted." />
    );
  }

  const cur = state.settings.currency;
  const status = statusOf(state, member.id);
  const ms = currentMembership(state, member.id);
  const due = dueFor(state, member.id);
  const payments = state.payments.filter((p) => p.memberId === member.id);

  return (
    <>
      <Button variant="ghost" size="sm" className="mb-3 -ml-2 text-muted-foreground" asChild>
        <Link to="/members" search={{ filter: "all", q: "", page: 1, new: false }}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back to members
        </Link>
      </Button>

      <PageHeader
        title={member.name}
        subtitle={`Member since ${shortDate(member.joinDate)}`}
        actions={
          <>
            <Button variant="secondary" onClick={() => setEditOpen(true)}>
              <Pencil className="mr-2 h-4 w-4" /> Edit
            </Button>
            {ms && (
              <Button
                variant="secondary"
                onClick={() => {
                  toggleFreeze(ms.id);
                  toast.success(ms.frozen ? "Membership unfrozen" : "Membership frozen");
                }}
              >
                <Snowflake className="mr-2 h-4 w-4" /> {ms.frozen ? "Unfreeze" : "Freeze"}
              </Button>
            )}
            <Button onClick={() => setRenewOpen(true)}>
              <RefreshCw className="mr-2 h-4 w-4" /> Renew
            </Button>
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-6">
          <Panel>
            <div className="flex flex-col items-center text-center">
              <div className="grid h-24 w-24 place-items-center overflow-hidden rounded-3xl border border-gold/35 bg-secondary font-display text-3xl text-gold">
                {member.photo ? (
                  <img src={member.photo} alt={member.name} className="h-full w-full object-cover" />
                ) : (
                  member.name.slice(0, 2).toUpperCase()
                )}
              </div>
              <p className="mt-3 font-display text-2xl tracking-wide">{member.name}</p>
              <div className="mt-2">
                <StatusBadge status={status} />
              </div>
            </div>

            <dl className="mt-6 space-y-3 text-sm">
              <Info icon={Phone} value={member.phone} />
              <Info icon={Mail} value={member.email} />
              <Info icon={Cake} value={shortDate(member.dob)} />
              <Info icon={MapPin} value={member.address || "—"} />
              <Info icon={ShieldAlert} value={`Emergency: ${member.emergencyContact || "—"}`} />
            </dl>
          </Panel>

          <Panel title="Membership Status">
            {ms ? (
              <div className="space-y-3 text-sm">
                <Row label="Plan" value={planOf(state, ms.planId)?.name ?? "—"} />
                <Row label="Start" value={shortDate(ms.startDate)} />
                <Row label="Expiry" value={shortDate(ms.endDate)} />
                <Row label="Plan price" value={money(ms.price - ms.discount, cur)} />
                <Row label="Paid" value={money(paidFor(state, ms.id), cur)} />
                <div className="flex items-center justify-between border-t border-border pt-3">
                  <span className="text-muted-foreground">Total due</span>
                  <span className={`font-display text-xl ${due > 0 ? "text-warning" : "text-success"}`}>
                    {money(due, cur)}
                  </span>
                </div>
              </div>
            ) : (
              <EmptyState title="No active membership" hint="Renew to start a new term." />
            )}
          </Panel>
        </div>

        <Tabs defaultValue="history">
          <TabsList className="mb-4 flex-wrap">
            <TabsTrigger value="history">Membership History</TabsTrigger>
            <TabsTrigger value="payments">Payments</TabsTrigger>
            <TabsTrigger value="measurements">Body Measurements</TabsTrigger>
            <TabsTrigger value="notes">Progress Notes</TabsTrigger>
          </TabsList>

          <TabsContent value="history">
            <Panel title="Membership History">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                      <th className="py-3">Plan</th>
                      <th className="py-3">Period</th>
                      <th className="py-3 text-right">Price</th>
                      <th className="py-3 text-right">Paid</th>
                      <th className="py-3 text-right">Balance</th>
                      <th className="py-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {membershipHistory(state, member.id).map((h) => {
                      const paid = paidFor(state, h.id);
                      const bal = Math.max(0, h.price - h.discount - paid);
                      return (
                        <tr key={h.id} className="border-b border-border/50">
                          <td className="py-3">{planOf(state, h.planId)?.name ?? "—"}</td>
                          <td className="py-3 text-muted-foreground">
                            {shortDate(h.startDate)} → {shortDate(h.endDate)}
                          </td>
                          <td className="py-3 text-right">{money(h.price - h.discount, cur)}</td>
                          <td className="py-3 text-right text-success">{money(paid, cur)}</td>
                          <td className={`py-3 text-right ${bal > 0 ? "text-warning" : "text-success"}`}>
                            {money(bal, cur)}
                          </td>
                          <td className="py-3 text-right">
                            {bal > 0 ? (
                              <Button size="sm" variant="secondary" onClick={() => setCollectFor(h)}>
                                <Wallet className="mr-1.5 h-3.5 w-3.5" /> Collect balance
                              </Button>
                            ) : (
                              <span className="text-xs text-success">Fully paid</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>
          </TabsContent>

          <TabsContent value="payments">
            <Panel title="Payment History">
              {payments.length === 0 ? (
                <EmptyState title="No payments recorded yet" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                        <th className="py-3">Invoice</th>
                        <th className="py-3">Date</th>
                        <th className="py-3">Note</th>
                        <th className="py-3 text-right">Amount</th>
                        <th className="py-3 text-right">Invoice</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payments.map((p) => (
                        <tr key={p.id} className="border-b border-border/50">
                          <td className="py-3 font-medium text-gold">{p.invoiceNo}</td>
                          <td className="py-3 text-muted-foreground">{shortDate(p.date)}</td>
                          <td className="py-3 text-muted-foreground">{p.note}</td>
                          <td className="py-3 text-right">{money(p.amount, cur)}</td>
                          <td className="py-3 text-right">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              aria-label="View invoice"
                              onClick={() => setInvoice(invoiceOf(p, member.name, member.phone))}
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </TabsContent>

          <TabsContent value="measurements">
            <Panel
              title="Body Measurements"
              actions={
                <Button size="sm" variant="secondary" onClick={() => setMsrOpen(true)}>
                  <Plus className="mr-1.5 h-3.5 w-3.5" /> Add
                </Button>
              }
            >
              {chart.length > 0 && (
                <div className="mb-5 h-[220px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chart} margin={{ left: -20, right: 8, top: 8 }}>
                      <CartesianGrid strokeDasharray="3 6" stroke="var(--color-border)" vertical={false} />
                      <XAxis dataKey="label" fontSize={11} tickLine={false} axisLine={false} stroke="var(--color-muted-foreground)" />
                      <YAxis fontSize={11} tickLine={false} axisLine={false} stroke="var(--color-muted-foreground)" />
                      <RTooltip
                        contentStyle={{
                          background: "var(--color-popover)",
                          border: "1px solid var(--color-border)",
                          borderRadius: 12,
                          fontSize: 12,
                        }}
                      />
                      <Line type="monotone" dataKey="weight" stroke="var(--color-gold)" strokeWidth={2} dot={{ r: 3 }} />
                      <Line type="monotone" dataKey="bodyFat" stroke="var(--color-chart-4)" strokeWidth={2} dot={{ r: 3 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                      <th className="py-3">Date</th>
                      <th className="py-3">Weight</th>
                      <th className="py-3">Chest</th>
                      <th className="py-3">Waist</th>
                      <th className="py-3">Arms</th>
                      <th className="py-3">Body fat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {member.measurements.map((m) => (
                      <tr key={m.id} className="border-b border-border/50">
                        <td className="py-3 text-muted-foreground">{shortDate(m.date)}</td>
                        <td className="py-3">{m.weightKg.toFixed(1)} kg</td>
                        <td className="py-3">{m.chestCm} cm</td>
                        <td className="py-3">{m.waistCm} cm</td>
                        <td className="py-3">{m.armsCm} cm</td>
                        <td className="py-3">{m.bodyFat.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </TabsContent>

          <TabsContent value="notes">
            <Panel
              title="Progress Notes"
              actions={
                <Button size="sm" variant="secondary" onClick={() => setNoteOpen(true)}>
                  <Plus className="mr-1.5 h-3.5 w-3.5" /> Add note
                </Button>
              }
            >
              {member.notes.length === 0 ? (
                <EmptyState title="No progress notes yet" />
              ) : (
                <ul className="space-y-3">
                  {member.notes.map((n) => (
                    <li key={n.id} className="rounded-xl border border-border bg-secondary/30 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <p className="truncate font-medium">{n.title}</p>
                        <span className="shrink-0 text-xs text-muted-foreground">{shortDate(n.date)}</span>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">{n.note}</p>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </TabsContent>
        </Tabs>
      </div>

      <MemberFormDialog open={editOpen} onOpenChange={setEditOpen} member={member} />
      <RenewDialog
        open={renewOpen}
        onOpenChange={setRenewOpen}
        memberId={member.id}
        onDone={() => navigate({ to: "/members/$memberId", params: { memberId: member.id } })}
      />
      <NoteDialog open={noteOpen} onOpenChange={setNoteOpen} memberId={member.id} />
      <MeasurementDialog open={msrOpen} onOpenChange={setMsrOpen} memberId={member.id} />
      <CollectBalanceDialog
        membership={collectFor}
        onClose={() => setCollectFor(null)}
        memberName={member.name}
      />
      <InvoiceDialog invoice={invoice} settings={state.settings} onOpenChange={() => setInvoice(null)} />
    </>
  );
}

function invoiceOf(p: Payment, name: string, phone?: string): InvoiceData {
  return {
    invoiceNo: p.invoiceNo,
    date: p.date,
    billedTo: name,
    contact: phone,
    lines: [{ description: p.note || "Payment", qty: 1, rate: p.amount }],
    paid: p.amount,
    method: p.method,
  };
}

function CollectBalanceDialog({
  membership,
  memberName,
  onClose,
}: {
  membership: Membership | null;
  memberName: string;
  onClose: () => void;
}) {
  const state = useGym();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<Payment["method"]>("cash");
  const [note, setNote] = useState("");
  const [seeded, setSeeded] = useState<string | null>(null);

  if (!state || !membership) return null;
  const cur = state.settings.currency;
  const total = membership.price - membership.discount;
  const paid = paidFor(state, membership.id);
  const balance = Math.max(0, total - paid);
  const plan = planOf(state, membership.planId);

  if (seeded !== membership.id) {
    setSeeded(membership.id);
    setAmount(String(balance));
    setMethod("cash");
    setNote("");
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display text-2xl tracking-wide">Collect Balance</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-3 rounded-xl border border-border bg-secondary/30 p-4 text-sm">
            <Row label="Member" value={memberName} />
            <Row label="Plan" value={plan?.name ?? "—"} />
            <Row label="Total price" value={money(total, cur)} />
            <Row label="Already paid" value={money(paid, cur)} />
            <div className="flex items-center justify-between border-t border-border pt-3">
              <span className="text-muted-foreground">Remaining balance</span>
              <span className="font-display text-xl text-warning">{money(balance, cur)}</span>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Payment amount</Label>
            <Input
              type="number"
              min={1}
              max={balance}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Payment method</Label>
            <Select value={method} onValueChange={(v) => setMethod(v as Payment["method"])}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="card">Card</SelectItem>
                <SelectItem value="bank">Bank transfer</SelectItem>
                <SelectItem value="cheque">Cheque</SelectItem>
                <SelectItem value="other">Other / UPI</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Note (optional)</Label>
            <Input
              value={note}
              maxLength={120}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Balance payment"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                const n = Number(amount);
                if (Number.isNaN(n) || n <= 0) return toast.error("Enter an amount greater than zero");
                if (n > balance) return toast.error("Payment cannot exceed the remaining balance");
                addPayment({
                  memberId: membership.memberId,
                  membershipId: membership.id,
                  amount: n,
                  method,
                  note: note.trim() || `${plan?.name ?? "Membership"} — balance payment`,
                });
                toast.success(
                  n === balance ? "Payment complete — membership fully paid" : "Payment recorded",
                );
                setSeeded(null);
                onClose();
              }}
            >
              Complete payment
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Info({ icon: Icon, value }: { icon: typeof Mail; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
      <span className="min-w-0 break-words text-muted-foreground">{value}</span>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate font-medium">{value}</span>
    </div>
  );
}

export function RenewDialog({
  open,
  onOpenChange,
  memberId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  memberId: string;
  onDone?: () => void;
}) {
  const state = useGym();
  const [planId, setPlanId] = useState("");
  const [paid, setPaid] = useState("");
  if (!state) return null;
  const plan = state.plans.find((p) => p.id === planId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display text-2xl tracking-wide">Renew Membership</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Plan</Label>
            <Select value={planId} onValueChange={setPlanId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a plan" />
              </SelectTrigger>
              <SelectContent>
                {state.plans.filter((p) => !p.deletedAt).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} — {money(p.price, state.settings.currency)} / {p.durationDays} days
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Amount collected now</Label>
            <Input
              type="number"
              min={0}
              value={paid}
              onChange={(e) => setPaid(e.target.value)}
              placeholder={plan ? String(plan.price) : "0"}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              disabled={!planId}
              onClick={() => {
                const amount = Number(paid || 0);
                if (amount < 0 || Number.isNaN(amount)) {
                  toast.error("Enter a valid amount");
                  return;
                }
                renewMembership(memberId, planId, amount);
                toast.success("Membership renewed");
                onOpenChange(false);
                setPlanId("");
                setPaid("");
                onDone?.();
              }}
            >
              Confirm renewal
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function NoteDialog({
  open,
  onOpenChange,
  memberId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  memberId: string;
}) {
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display text-2xl tracking-wide">Add Progress Note</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Title</Label>
            <Input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Note</Label>
            <Textarea rows={4} value={note} maxLength={600} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (title.trim().length < 2 || note.trim().length < 2) {
                  toast.error("Add a title and note");
                  return;
                }
                addNote(memberId, title.trim(), note.trim());
                toast.success("Progress note saved");
                setTitle("");
                setNote("");
                onOpenChange(false);
              }}
            >
              Save note
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MeasurementDialog({
  open,
  onOpenChange,
  memberId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  memberId: string;
}) {
  const [form, setForm] = useState({
    weightKg: "",
    heightCm: "",
    chestCm: "",
    waistCm: "",
    armsCm: "",
    bodyFat: "",
  });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display text-2xl tracking-wide">Add Measurement</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4">
          {(
            [
              ["weightKg", "Weight (kg)"],
              ["heightCm", "Height (cm)"],
              ["chestCm", "Chest (cm)"],
              ["waistCm", "Waist (cm)"],
              ["armsCm", "Arms (cm)"],
              ["bodyFat", "Body fat (%)"],
            ] as const
          ).map(([k, label]) => (
            <div key={k} className="space-y-2">
              <Label>{label}</Label>
              <Input type="number" value={form[k]} onChange={(e) => set(k, e.target.value)} />
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              const values = Object.values(form).map(Number);
              if (values.some((v) => Number.isNaN(v) || v < 0) || !form.weightKg) {
                toast.error("Enter valid positive numbers");
                return;
              }
              addMeasurement(memberId, {
                weightKg: Number(form.weightKg),
                heightCm: Number(form.heightCm || 0),
                chestCm: Number(form.chestCm || 0),
                waistCm: Number(form.waistCm || 0),
                armsCm: Number(form.armsCm || 0),
                bodyFat: Number(form.bodyFat || 0),
              });
              toast.success("Measurement recorded");
              onOpenChange(false);
            }}
          >
            Save measurement
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
