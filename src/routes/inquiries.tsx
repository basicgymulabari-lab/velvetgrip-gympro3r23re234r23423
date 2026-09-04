import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import {
  CalendarClock,
  Flame,
  Mail,
  MessageCircle,
  Pencil,
  Phone,
  Plus,
  Search,
  Target,
  Trash2,
  UsersRound,
} from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app/AppShell";
import { AppDatePicker } from "@/components/app/AppDatePicker";
import { EmptyState, PageHeader, Panel } from "@/components/app/Panel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { localDateInput } from "@/lib/gym/calendar";
import { dialCodeFor, localPhoneDigits, phoneInputValue } from "@/lib/gym/phone";
import { shortDate } from "@/lib/gym/selectors";
import { addInquiry, deleteInquiry, updateInquiry, useGym } from "@/lib/gym/store";
import type {
  Inquiry,
  InquiryPriority,
  InquirySource,
  InquiryStatus,
  PhoneCountry,
} from "@/lib/gym/types";

export const Route = createFileRoute("/inquiries")({
  head: () => ({
    meta: [
      { title: "Inquiries — IRONVAULT Gym Management" },
      {
        name: "description",
        content: "Track gym leads, follow-ups, membership interests and conversions locally.",
      },
    ],
  }),
  component: () => (
    <AppShell>
      <InquiriesPage />
    </AppShell>
  ),
});

const STATUS_OPTIONS: Array<{ value: InquiryStatus; label: string }> = [
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "trial", label: "Trial scheduled" },
  { value: "follow_up", label: "Follow-up" },
  { value: "converted", label: "Converted" },
  { value: "lost", label: "Lost" },
];

const SOURCE_OPTIONS: Array<{ value: InquirySource; label: string }> = [
  { value: "walk_in", label: "Walk-in" },
  { value: "referral", label: "Referral" },
  { value: "instagram", label: "Instagram" },
  { value: "facebook", label: "Facebook" },
  { value: "google", label: "Google" },
  { value: "phone", label: "Phone call" },
  { value: "website", label: "Website" },
  { value: "other", label: "Other" },
];

const PRIORITY_OPTIONS: Array<{ value: InquiryPriority; label: string }> = [
  { value: "hot", label: "Hot" },
  { value: "warm", label: "Warm" },
  { value: "cold", label: "Cold" },
];

const statusLabel = (status: InquiryStatus) =>
  STATUS_OPTIONS.find((option) => option.value === status)?.label ?? status;
const sourceLabel = (source: InquirySource) =>
  SOURCE_OPTIONS.find((option) => option.value === source)?.label ?? source;
const isOpenLead = (inquiry: Inquiry) => !["converted", "lost"].includes(inquiry.status);

function followUpState(inquiry: Inquiry) {
  if (!inquiry.nextFollowUp || !isOpenLead(inquiry)) return "none";
  const today = localDateInput(new Date());
  const date = inquiry.nextFollowUp.slice(0, 10);
  if (date < today) return "overdue";
  if (date === today) return "today";
  return "upcoming";
}

function InquiriesPage() {
  const state = useGym();
  const [filter, setFilter] = useState<InquiryStatus | "all" | "attention">("all");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Inquiry | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [removing, setRemoving] = useState<Inquiry | null>(null);

  const inquiries = useMemo(() => state?.inquiries ?? [], [state?.inquiries]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return inquiries
      .filter((inquiry) => {
        if (filter === "attention") return ["overdue", "today"].includes(followUpState(inquiry));
        return filter === "all" || inquiry.status === filter;
      })
      .filter(
        (inquiry) =>
          !needle ||
          `${inquiry.name} ${inquiry.phone} ${inquiry.email ?? ""} ${inquiry.interest} ${sourceLabel(inquiry.source)}`
            .toLowerCase()
            .includes(needle),
      )
      .sort((a, b) => {
        const attention = { overdue: 0, today: 1, upcoming: 2, none: 3 };
        const difference = attention[followUpState(a)] - attention[followUpState(b)];
        return difference || +new Date(b.updatedAt) - +new Date(a.updatedAt);
      });
  }, [filter, inquiries, query]);

  if (!state) return null;
  const open = inquiries.filter(isOpenLead);
  const attention = open.filter((inquiry) => ["overdue", "today"].includes(followUpState(inquiry)));
  const hot = open.filter((inquiry) => inquiry.priority === "hot");
  const converted = inquiries.filter((inquiry) => inquiry.status === "converted").length;
  const conversion = inquiries.length ? Math.round((converted / inquiries.length) * 100) : 0;

  return (
    <>
      <PageHeader
        title="Inquiries"
        subtitle="Turn gym enquiries into members with a clear, timely follow-up pipeline"
        actions={
          <Button
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" /> Add inquiry
          </Button>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <LeadMetric
          icon={UsersRound}
          label="Open leads"
          value={open.length}
          hint="Active pipeline"
        />
        <LeadMetric
          icon={CalendarClock}
          label="Needs attention"
          value={attention.length}
          hint="Due today or overdue"
          tone="warning"
        />
        <LeadMetric
          icon={Flame}
          label="Hot leads"
          value={hot.length}
          hint="Highest priority"
          tone="hot"
        />
        <LeadMetric
          icon={Target}
          label="Conversion rate"
          value={`${conversion}%`}
          hint={`${converted} converted`}
          tone="success"
        />
      </div>

      <Panel>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col justify-between gap-3 xl:flex-row xl:items-center">
            <div className="flex flex-wrap gap-2">
              {[
                { value: "all", label: "All" },
                {
                  value: "attention",
                  label: `Needs attention${attention.length ? ` · ${attention.length}` : ""}`,
                },
                ...STATUS_OPTIONS,
              ].map((option) => (
                <button
                  key={option.value}
                  onClick={() => setFilter(option.value as typeof filter)}
                  className={`rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors ${
                    filter === option.value
                      ? "border-gold/50 bg-gold/15 text-gold"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="relative w-full xl:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search leads, phone or interest"
                className="pl-9"
              />
            </div>
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              title="No inquiries found"
              hint={inquiries.length ? "Try another status or search." : "Add your first gym lead."}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1050px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                    <th className="px-3 py-3 font-medium">Lead</th>
                    <th className="px-3 py-3 font-medium">Contact</th>
                    <th className="px-3 py-3 font-medium">Interest</th>
                    <th className="px-3 py-3 font-medium">Source</th>
                    <th className="px-3 py-3 font-medium">Priority</th>
                    <th className="px-3 py-3 font-medium">Status</th>
                    <th className="px-3 py-3 font-medium">Next follow-up</th>
                    <th className="px-3 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((inquiry) => {
                    const followUp = followUpState(inquiry);
                    return (
                      <tr
                        key={inquiry.id}
                        className="border-b border-border/70 last:border-0 hover:bg-secondary/20"
                      >
                        <td className="px-3 py-4">
                          <div className="flex items-center gap-3">
                            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-gold/35 bg-gold/5 text-xs font-semibold text-gold">
                              {inquiry.name
                                .split(/\s+/)
                                .slice(0, 2)
                                .map((part) => part[0])
                                .join("")
                                .toUpperCase()}
                            </span>
                            <div>
                              <p className="font-medium">{inquiry.name}</p>
                              <p className="text-[11px] text-muted-foreground">
                                Added {shortDate(inquiry.createdAt)}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-4">
                          <a href={`tel:${inquiry.phone}`} className="block hover:text-gold">
                            {inquiry.phone}
                          </a>
                          {inquiry.email && (
                            <a
                              href={`mailto:${inquiry.email}`}
                              className="block max-w-44 truncate text-xs text-muted-foreground hover:text-gold"
                            >
                              {inquiry.email}
                            </a>
                          )}
                        </td>
                        <td className="px-3 py-4">{inquiry.interest}</td>
                        <td className="px-3 py-4 text-muted-foreground">
                          {sourceLabel(inquiry.source)}
                        </td>
                        <td className="px-3 py-4">
                          <PriorityBadge priority={inquiry.priority} />
                        </td>
                        <td className="px-3 py-4">
                          <Select
                            value={inquiry.status}
                            onValueChange={(value) => {
                              updateInquiry(inquiry.id, {
                                status: value as InquiryStatus,
                                nextFollowUp: ["converted", "lost"].includes(value)
                                  ? null
                                  : inquiry.nextFollowUp,
                              });
                              toast.success(
                                `Lead marked ${statusLabel(value as InquiryStatus).toLowerCase()}`,
                              );
                            }}
                          >
                            <SelectTrigger className="h-8 w-36">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {STATUS_OPTIONS.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="px-3 py-4">
                          {inquiry.nextFollowUp && isOpenLead(inquiry) ? (
                            <div>
                              <p
                                className={
                                  followUp === "overdue"
                                    ? "font-medium text-destructive"
                                    : followUp === "today"
                                      ? "font-medium text-gold"
                                      : ""
                                }
                              >
                                {shortDate(inquiry.nextFollowUp)}
                              </p>
                              <p
                                className={`text-[10px] uppercase tracking-wider ${followUp === "overdue" ? "text-destructive" : "text-muted-foreground"}`}
                              >
                                {followUp}
                              </p>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-4">
                          <div className="flex justify-end gap-1">
                            <Button asChild variant="ghost" size="icon" title="Call lead">
                              <a href={`tel:${inquiry.phone}`}>
                                <Phone className="h-4 w-4" />
                              </a>
                            </Button>
                            {inquiry.email && (
                              <Button asChild variant="ghost" size="icon" title="Email lead">
                                <a href={`mailto:${inquiry.email}`}>
                                  <Mail className="h-4 w-4" />
                                </a>
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Edit inquiry"
                              onClick={() => {
                                setEditing(inquiry);
                                setFormOpen(true);
                              }}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Delete inquiry"
                              className="text-muted-foreground hover:text-destructive"
                              onClick={() => setRemoving(inquiry)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Panel>

      <InquiryFormDialog
        key={editing?.id ?? (formOpen ? "new-open" : "new-closed")}
        open={formOpen}
        inquiry={editing}
        plans={state.plans
          .filter((plan) => plan.active && !plan.deletedAt)
          .map((plan) => plan.name)}
        country={state.settings.phoneCountry}
        onOpenChange={setFormOpen}
      />

      <Dialog open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display text-2xl tracking-wide">
              Delete inquiry?
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This permanently removes <strong className="text-foreground">{removing?.name}</strong>{" "}
            from the inquiry pipeline.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (removing) deleteInquiry(removing.id);
                setRemoving(null);
                toast.success("Inquiry deleted");
              }}
            >
              Delete inquiry
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function LeadMetric({
  icon: Icon,
  label,
  value,
  hint,
  tone = "gold",
}: {
  icon: typeof UsersRound;
  label: string;
  value: string | number;
  hint: string;
  tone?: "gold" | "warning" | "hot" | "success";
}) {
  const tones = {
    gold: "border-gold/35 bg-gold/10 text-gold",
    warning: "border-warning/35 bg-warning/10 text-warning",
    hot: "border-destructive/35 bg-destructive/10 text-destructive",
    success: "border-success/35 bg-success/10 text-success",
  };
  return (
    <div className="surface-panel flex items-center gap-4 rounded-2xl p-5">
      <span className={`grid h-11 w-11 place-items-center rounded-xl border ${tones[tone]}`}>
        <Icon className="h-5 w-5" />
      </span>
      <div>
        <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
        <p className="font-display text-2xl">{value}</p>
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

function PriorityBadge({ priority }: { priority: InquiryPriority }) {
  const classes = {
    hot: "border-destructive/40 bg-destructive/10 text-destructive",
    warm: "border-gold/40 bg-gold/10 text-gold",
    cold: "border-sky-400/30 bg-sky-400/10 text-sky-300",
  };
  return (
    <span
      className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider ${classes[priority]}`}
    >
      {priority}
    </span>
  );
}

function InquiryFormDialog({
  open,
  inquiry,
  plans,
  country,
  onOpenChange,
}: {
  open: boolean;
  inquiry: Inquiry | null;
  plans: string[];
  country?: PhoneCountry;
  onOpenChange: (open: boolean) => void;
}) {
  const key = inquiry?.id ?? "new";
  const [loadedKey, setLoadedKey] = useState(key);
  const [name, setName] = useState(inquiry?.name ?? "");
  const [phone, setPhone] = useState(inquiry?.phone ?? phoneInputValue("", country));
  const [email, setEmail] = useState(inquiry?.email ?? "");
  const [interest, setInterest] = useState(inquiry?.interest ?? plans[0] ?? "General fitness");
  const [source, setSource] = useState<InquirySource>(inquiry?.source ?? "walk_in");
  const [priority, setPriority] = useState<InquiryPriority>(inquiry?.priority ?? "warm");
  const [status, setStatus] = useState<InquiryStatus>(inquiry?.status ?? "new");
  const [followUp, setFollowUp] = useState(
    inquiry?.nextFollowUp?.slice(0, 10) ?? localDateInput(new Date()),
  );
  const [notes, setNotes] = useState(inquiry?.notes ?? "");
  const [attempted, setAttempted] = useState(false);
  const submittingRef = useRef(false);

  if (loadedKey !== key) {
    setLoadedKey(key);
    setName(inquiry?.name ?? "");
    setPhone(inquiry?.phone ?? phoneInputValue("", country));
    setEmail(inquiry?.email ?? "");
    setInterest(inquiry?.interest ?? plans[0] ?? "General fitness");
    setSource(inquiry?.source ?? "walk_in");
    setPriority(inquiry?.priority ?? "warm");
    setStatus(inquiry?.status ?? "new");
    setFollowUp(inquiry?.nextFollowUp?.slice(0, 10) ?? localDateInput(new Date()));
    setNotes(inquiry?.notes ?? "");
    setAttempted(false);
  }

  const errors = {
    name: name.trim().length < 2 ? "Enter at least 2 characters." : "",
    phone:
      localPhoneDigits(phone).length !== 10
        ? "Enter exactly 10 digits after the country code."
        : "",
    email: email && !/^\S+@\S+\.\S+$/.test(email) ? "Enter a valid email address." : "",
    interest: interest.trim() ? "" : "Select or enter an interest.",
  };
  const valid = !Object.values(errors).some(Boolean);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (submittingRef.current) return;
    setAttempted(true);
    if (!valid) return toast.error(Object.values(errors).find(Boolean));
    submittingRef.current = true;
    const closed = ["converted", "lost"].includes(status);
    const payload = {
      name,
      phone,
      email,
      interest,
      source,
      priority,
      status,
      nextFollowUp: closed || !followUp ? null : new Date(`${followUp}T09:00:00`).toISOString(),
      notes,
    };
    try {
      if (inquiry) {
        updateInquiry(inquiry.id, payload);
        toast.success("Inquiry updated");
      } else {
        addInquiry(payload);
        toast.success("Inquiry added");
      }
      onOpenChange(false);
    } finally {
      submittingRef.current = false;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl tracking-wide">
            {inquiry ? "Edit inquiry" : "Add new inquiry"}
          </DialogTitle>
        </DialogHeader>
        <form className="space-y-5" onSubmit={submit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Full name" error={attempted ? errors.name : ""}>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Prospect's name"
              />
            </Field>
            <Field label="Phone" error={attempted ? errors.phone : ""}>
              <CountryPhoneInput value={phone} country={country} onChange={setPhone} />
            </Field>
            <Field label="Email (optional)" error={attempted ? errors.email : ""}>
              <Input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@example.com"
              />
            </Field>
            <Field label="Membership interest" error={attempted ? errors.interest : ""}>
              <Select value={interest} onValueChange={setInterest}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {plans.map((plan) => (
                    <SelectItem key={plan} value={plan}>
                      {plan}
                    </SelectItem>
                  ))}
                  <SelectItem value="General fitness">General fitness</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Lead source">
              <Select value={source} onValueChange={(value) => setSource(value as InquirySource)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SOURCE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Priority">
              <Select
                value={priority}
                onValueChange={(value) => setPriority(value as InquiryPriority)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Status">
              <Select value={status} onValueChange={(value) => setStatus(value as InquiryStatus)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Next follow-up">
              <AppDatePicker
                value={followUp}
                onChange={setFollowUp}
                min={new Date()}
                placeholder="Choose follow-up date"
              />
            </Field>
          </div>
          <Field label="Notes">
            <Textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              maxLength={500}
              rows={3}
              placeholder="Goals, preferred schedule, questions or last conversation..."
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">
              <MessageCircle className="mr-2 h-4 w-4" />
              {inquiry ? "Save changes" : "Add inquiry"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CountryPhoneInput({
  value,
  country,
  onChange,
}: {
  value: string;
  country?: PhoneCountry;
  onChange: (value: string) => void;
}) {
  const dialCode = dialCodeFor(country);
  return (
    <div className="flex h-10 items-center rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring">
      <span className="select-none pl-3 text-sm">{dialCode}&nbsp;</span>
      <Input
        type="tel"
        inputMode="numeric"
        value={localPhoneDigits(value).slice(0, 10)}
        onChange={(event) => onChange(phoneInputValue(event.target.value, country))}
        maxLength={10}
        className="h-full border-0 bg-transparent px-0 pr-3 shadow-none focus-visible:ring-0"
      />
    </div>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
