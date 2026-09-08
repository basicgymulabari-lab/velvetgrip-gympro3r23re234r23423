import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  BarChart3,
  CalendarClock,
  CheckCircle2,
  Columns3,
  Clock3,
  Flame,
  Gauge,
  GripVertical,
  LayoutList,
  Mail,
  MessageCircle,
  Pencil,
  Phone,
  Plus,
  Search,
  Sparkles,
  Target,
  Trash2,
  TrendingUp,
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
  Plan,
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

const STAGE_PROBABILITY: Record<InquiryStatus, number> = {
  new: 0.15,
  contacted: 0.3,
  trial: 0.65,
  follow_up: 0.5,
  converted: 1,
  lost: 0,
};

const PIPELINE_STAGES: InquiryStatus[] = [
  "new",
  "contacted",
  "trial",
  "follow_up",
  "converted",
  "lost",
];

const CRM_VIEW_STORAGE_KEY = "ironvault-inquiries-crm-view";

function planValue(inquiry: Inquiry, plans: Plan[]) {
  return plans.find((plan) => !plan.deletedAt && plan.name === inquiry.interest)?.price ?? 0;
}

function leadScore(inquiry: Inquiry, plans: Plan[]) {
  const priority = { hot: 34, warm: 22, cold: 10 }[inquiry.priority];
  const stage = { new: 10, contacted: 22, trial: 34, follow_up: 26, converted: 40, lost: 0 }[
    inquiry.status
  ];
  const follow = followUpState(inquiry);
  const urgency = follow === "overdue" ? 24 : follow === "today" ? 18 : follow === "upcoming" ? 8 : 0;
  const profile = (inquiry.email ? 5 : 0) + (planValue(inquiry, plans) > 0 ? 5 : 0);
  return Math.min(100, priority + stage + urgency + profile);
}

function activityAgeDays(inquiry: Inquiry) {
  return Math.max(0, Math.floor((Date.now() - new Date(inquiry.updatedAt).getTime()) / 86_400_000));
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function InquiriesPage() {
  const state = useGym();
  const [filter, setFilter] = useState<InquiryStatus | "all" | "attention">("all");
  const [query, setQuery] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<InquiryPriority | "all">("all");
  const [sort, setSort] = useState<"smart" | "recent" | "value">("smart");
  const [view, setView] = useState<"table" | "pipeline">("table");
  const [editing, setEditing] = useState<Inquiry | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [removing, setRemoving] = useState<Inquiry | null>(null);
  const [draggingLeadId, setDraggingLeadId] = useState<string | null>(null);
  const [dragOverStage, setDragOverStage] = useState<InquiryStatus | null>(null);

  useEffect(() => {
    const savedView = window.localStorage.getItem(CRM_VIEW_STORAGE_KEY);
    if (savedView === "table" || savedView === "pipeline") {
      setView(savedView);
    }
  }, []);

  const changeView = (nextView: "table" | "pipeline") => {
    setView(nextView);
    window.localStorage.setItem(CRM_VIEW_STORAGE_KEY, nextView);
  };

  const inquiries = useMemo(() => state?.inquiries ?? [], [state?.inquiries]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return inquiries
      .filter((inquiry) => {
        if (filter === "attention") return ["overdue", "today"].includes(followUpState(inquiry));
        return filter === "all" || inquiry.status === filter;
      })
      .filter((inquiry) => priorityFilter === "all" || inquiry.priority === priorityFilter)
      .filter(
        (inquiry) =>
          !needle ||
          `${inquiry.name} ${inquiry.phone} ${inquiry.email ?? ""} ${inquiry.interest} ${sourceLabel(inquiry.source)}`
            .toLowerCase()
            .includes(needle),
      )
      .sort((a, b) => {
        if (sort === "recent") return +new Date(b.updatedAt) - +new Date(a.updatedAt);
        if (sort === "value") return planValue(b, state?.plans ?? []) - planValue(a, state?.plans ?? []);
        const attention = { overdue: 0, today: 1, upcoming: 2, none: 3 };
        const difference = attention[followUpState(a)] - attention[followUpState(b)];
        return (
          difference ||
          leadScore(b, state?.plans ?? []) - leadScore(a, state?.plans ?? []) ||
          +new Date(b.updatedAt) - +new Date(a.updatedAt)
        );
      });
  }, [filter, inquiries, priorityFilter, query, sort, state?.plans]);

  if (!state) return null;
  const open = inquiries.filter(isOpenLead);
  const attention = open.filter((inquiry) => ["overdue", "today"].includes(followUpState(inquiry)));
  const hot = open.filter((inquiry) => inquiry.priority === "hot");
  const converted = inquiries.filter((inquiry) => inquiry.status === "converted").length;
  const conversion = inquiries.length ? Math.round((converted / inquiries.length) * 100) : 0;
  const overdue = open.filter((inquiry) => followUpState(inquiry) === "overdue");
  const today = open.filter((inquiry) => followUpState(inquiry) === "today");
  const pipelineValue = open.reduce((sum, inquiry) => sum + planValue(inquiry, state.plans), 0);
  const weightedForecast = open.reduce(
    (sum, inquiry) => sum + planValue(inquiry, state.plans) * STAGE_PROBABILITY[inquiry.status],
    0,
  );
  const followUpSla = open.length
    ? Math.max(0, Math.round(((open.length - overdue.length) / open.length) * 100))
    : 100;
  const averageScore = open.length
    ? Math.round(open.reduce((sum, inquiry) => sum + leadScore(inquiry, state.plans), 0) / open.length)
    : 0;
  const sourceStats = SOURCE_OPTIONS.map((source) => {
    const list = inquiries.filter((inquiry) => inquiry.source === source.value);
    const wins = list.filter((inquiry) => inquiry.status === "converted").length;
    return {
      ...source,
      count: list.length,
      wins,
      rate: list.length ? Math.round((wins / list.length) * 100) : 0,
      pipelineValue: list
        .filter(isOpenLead)
        .reduce((sum, inquiry) => sum + planValue(inquiry, state.plans), 0),
    };
  })
    .filter((source) => source.count > 0)
    .sort((a, b) => b.count - a.count || b.rate - a.rate)
    .slice(0, 4);
  const hotWithoutFollowUp = hot.filter((inquiry) => !inquiry.nextFollowUp).length;

  const money = (value: number) =>
    `${state.settings.currency}${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(value)}`;

  const scheduleTomorrow = (inquiry: Inquiry) => {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    date.setHours(9, 0, 0, 0);
    updateInquiry(inquiry.id, { nextFollowUp: date.toISOString(), status: inquiry.status === "new" ? "contacted" : inquiry.status });
    toast.success(`Follow-up scheduled tomorrow for ${inquiry.name}`);
  };

  const moveLeadToStage = (leadId: string, stage: InquiryStatus) => {
    const inquiry = inquiries.find((item) => item.id === leadId);
    if (!inquiry || inquiry.status === stage) return;
    updateInquiry(inquiry.id, {
      status: stage,
      nextFollowUp: ["converted", "lost"].includes(stage) ? null : inquiry.nextFollowUp,
    });
    toast.success(`${inquiry.name} moved to ${statusLabel(stage)}`);
  };

  return (
    <>
      <PageHeader
        title="Inquiries CRM"
        subtitle="Revenue-focused lead command center with pipeline intelligence, follow-up discipline and conversion forecasting"
        actions={
          <div className="flex items-center gap-2">
            <div className="hidden rounded-lg border border-border bg-secondary/40 p-1 sm:flex">
              <button
                type="button"
                onClick={() => changeView("table")}
                className={`rounded-md px-2.5 py-1.5 text-xs transition-colors ${
                  view === "table" ? "bg-background text-gold shadow-sm" : "text-muted-foreground"
                }`}
              >
                <LayoutList className="mr-1.5 inline h-3.5 w-3.5" /> List
              </button>
              <button
                type="button"
                onClick={() => changeView("pipeline")}
                className={`rounded-md px-2.5 py-1.5 text-xs transition-colors ${
                  view === "pipeline" ? "bg-background text-gold shadow-sm" : "text-muted-foreground"
                }`}
              >
                <Columns3 className="mr-1.5 inline h-3.5 w-3.5" /> Pipeline
              </button>
            </div>
            <Button
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              <Plus className="mr-2 h-4 w-4" /> Add inquiry
            </Button>
          </div>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <LeadMetric
          icon={BarChart3}
          label="Open pipeline"
          value={money(pipelineValue)}
          hint={`${open.length} active opportunities`}
        />
        <LeadMetric
          icon={TrendingUp}
          label="Weighted forecast"
          value={money(Math.round(weightedForecast))}
          hint="Stage-probability forecast"
          tone="success"
        />
        <LeadMetric
          icon={Gauge}
          label="Follow-up SLA"
          value={`${followUpSla}%`}
          hint={`${overdue.length} overdue · ${today.length} due today`}
          tone={overdue.length ? "warning" : "success"}
        />
        <LeadMetric
          icon={Target}
          label="Conversion rate"
          value={`${conversion}%`}
          hint={`${converted} wins from ${inquiries.length} leads`}
          tone="success"
        />
      </div>

      <div className="mb-6 grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
        <Panel title="CRM Intelligence" description="Live signals that tell you where revenue is at risk">
          <div className="grid gap-3 sm:grid-cols-3">
            <button
              type="button"
              onClick={() => setFilter("attention")}
              className="rounded-xl border border-destructive/25 bg-destructive/5 p-4 text-left transition-colors hover:bg-destructive/10"
            >
              <div className="flex items-center justify-between">
                <span className="grid h-9 w-9 place-items-center rounded-lg border border-destructive/30 bg-destructive/10 text-destructive">
                  <Clock3 className="h-4 w-4" />
                </span>
                <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
              </div>
              <p className="mt-3 font-display text-2xl text-destructive">{overdue.length}</p>
              <p className="text-xs font-medium">Overdue follow-ups</p>
              <p className="mt-1 text-[11px] text-muted-foreground">Revenue at immediate risk</p>
            </button>
            <button
              type="button"
              onClick={() => {
                setPriorityFilter("hot");
                setFilter("all");
              }}
              className="rounded-xl border border-gold/25 bg-gold/5 p-4 text-left transition-colors hover:bg-gold/10"
            >
              <div className="flex items-center justify-between">
                <span className="grid h-9 w-9 place-items-center rounded-lg border border-gold/30 bg-gold/10 text-gold">
                  <Flame className="h-4 w-4" />
                </span>
                <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
              </div>
              <p className="mt-3 font-display text-2xl text-gold">{hot.length}</p>
              <p className="text-xs font-medium">Hot opportunities</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {hotWithoutFollowUp} without a scheduled follow-up
              </p>
            </button>
            <div className="rounded-xl border border-success/25 bg-success/5 p-4">
              <div className="flex items-center justify-between">
                <span className="grid h-9 w-9 place-items-center rounded-lg border border-success/30 bg-success/10 text-success">
                  <Sparkles className="h-4 w-4" />
                </span>
                <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">AI-style score</span>
              </div>
              <p className="mt-3 font-display text-2xl text-success">{averageScore}/100</p>
              <p className="text-xs font-medium">Average lead quality</p>
              <p className="mt-1 text-[11px] text-muted-foreground">Priority + stage + urgency + profile completeness</p>
            </div>
          </div>
        </Panel>

        <Panel title="Source Performance" description="Where your strongest opportunities originate">
          {sourceStats.length ? (
            <div className="space-y-3">
              {sourceStats.map((source) => (
                <div key={source.value} className="rounded-xl border border-border bg-secondary/20 px-3.5 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{source.label}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {source.count} leads · {source.wins} converted
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold text-gold">{source.rate}%</p>
                      <p className="text-[10px] text-muted-foreground">{money(source.pipelineValue)}</p>
                    </div>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full bg-gold transition-[width]"
                      style={{ width: `${Math.max(source.count ? 8 : 0, source.rate)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No source data yet" hint="Lead sources will rank here as inquiries are added." />
          )}
        </Panel>
      </div>

      <Panel title="Pipeline Velocity" description="Opportunity volume, stage probability and open value by CRM stage" className="mb-6">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          {PIPELINE_STAGES.map((stage) => {
            const stageLeads = inquiries.filter((inquiry) => inquiry.status === stage);
            const stageValue = stageLeads
              .filter(isOpenLead)
              .reduce((sum, inquiry) => sum + planValue(inquiry, state.plans), 0);
            const active = filter === stage;
            return (
              <button
                key={stage}
                type="button"
                onClick={() => {
                  setFilter(stage);
                  changeView("table");
                }}
                className={`rounded-xl border p-3 text-left transition-all hover:-translate-y-0.5 ${
                  active ? "border-gold/60 bg-gold/10" : "border-border bg-secondary/20 hover:border-gold/30"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium">{statusLabel(stage)}</p>
                  <span className="rounded-full bg-background px-2 py-0.5 text-[10px] text-muted-foreground">
                    {Math.round(STAGE_PROBABILITY[stage] * 100)}%
                  </span>
                </div>
                <p className="mt-2 font-display text-2xl">{stageLeads.length}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {stage === "converted" || stage === "lost" ? "Closed stage" : `${money(stageValue)} open value`}
                </p>
              </button>
            );
          })}
        </div>
      </Panel>

      <Panel>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 border-b border-border pb-4">
            <div className="flex flex-col justify-between gap-3 xl:flex-row xl:items-center">
              <div className="flex flex-wrap gap-2">
                {[
                  { value: "all", label: `All · ${inquiries.length}` },
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
              <div className="flex gap-2">
                <div className="flex rounded-lg border border-border bg-secondary/40 p-1 sm:hidden">
                  <button
                    type="button"
                    onClick={() => changeView("table")}
                    className={`rounded-md p-1.5 ${view === "table" ? "bg-background text-gold" : "text-muted-foreground"}`}
                    title="List view"
                  >
                    <LayoutList className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => changeView("pipeline")}
                    className={`rounded-md p-1.5 ${view === "pipeline" ? "bg-background text-gold" : "text-muted-foreground"}`}
                    title="Pipeline view"
                  >
                    <Columns3 className="h-4 w-4" />
                  </button>
                </div>
                <div className="relative min-w-0 flex-1 xl:w-80">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search leads, phone, source or interest"
                    className="pl-9"
                  />
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Priority</span>
                {(["all", "hot", "warm", "cold"] as const).map((priority) => (
                  <button
                    key={priority}
                    type="button"
                    onClick={() => setPriorityFilter(priority)}
                    className={`rounded-md px-2.5 py-1 text-xs capitalize ${
                      priorityFilter === priority
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {priority}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Sort</span>
                <Select value={sort} onValueChange={(value) => setSort(value as typeof sort)}>
                  <SelectTrigger className="h-8 w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="smart">Smart priority</SelectItem>
                    <SelectItem value="recent">Recent activity</SelectItem>
                    <SelectItem value="value">Opportunity value</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              title="No inquiries found"
              hint={inquiries.length ? "Try another status, priority or search." : "Add your first gym lead."}
            />
          ) : view === "pipeline" ? (
            <div className="overflow-x-auto pb-2">
              <div className="mb-3 flex items-center gap-2 text-[11px] text-muted-foreground">
                <GripVertical className="h-3.5 w-3.5 text-gold" />
                Drag a lead card and drop it into another stage to update the pipeline.
              </div>
              <div className="flex min-w-max gap-4">
                {PIPELINE_STAGES.map((stage) => {
                  const stageLeads = filtered.filter((inquiry) => inquiry.status === stage);
                  return (
                    <section
                      key={stage}
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                        setDragOverStage(stage);
                      }}
                      onDragEnter={(event) => {
                        event.preventDefault();
                        setDragOverStage(stage);
                      }}
                      onDragLeave={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                          setDragOverStage((current) => (current === stage ? null : current));
                        }
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const leadId = draggingLeadId ?? event.dataTransfer.getData("text/plain");
                        if (leadId) moveLeadToStage(leadId, stage);
                        setDraggingLeadId(null);
                        setDragOverStage(null);
                      }}
                      className={`w-[300px] rounded-2xl border p-3 transition-all duration-150 ${
                        dragOverStage === stage && draggingLeadId
                          ? "border-gold/70 bg-gold/5 shadow-[0_0_0_1px_rgba(212,175,55,0.15)]"
                          : "border-border bg-secondary/10"
                      }`}
                    >
                      <div className="mb-3 flex items-center justify-between gap-2 px-1">
                        <div>
                          <p className="text-sm font-semibold">{statusLabel(stage)}</p>
                          <p className="text-[10px] text-muted-foreground">
                            {stageLeads.length} {stageLeads.length === 1 ? "lead" : "leads"}
                          </p>
                        </div>
                        <span className="rounded-full border border-border bg-background px-2 py-1 text-[10px] text-muted-foreground">
                          {Math.round(STAGE_PROBABILITY[stage] * 100)}%
                        </span>
                      </div>
                      <div className="space-y-2.5">
                        {stageLeads.length ? (
                          stageLeads.map((inquiry) => {
                            const score = leadScore(inquiry, state.plans);
                            const followUp = followUpState(inquiry);
                            const value = planValue(inquiry, state.plans);
                            return (
                              <article
                                key={inquiry.id}
                                draggable
                                onDragStart={(event) => {
                                  setDraggingLeadId(inquiry.id);
                                  event.dataTransfer.effectAllowed = "move";
                                  event.dataTransfer.setData("text/plain", inquiry.id);
                                }}
                                onDragEnd={() => {
                                  setDraggingLeadId(null);
                                  setDragOverStage(null);
                                }}
                                className={`group cursor-grab rounded-xl border border-border bg-card p-3 shadow-sm transition-all active:cursor-grabbing ${
                                  draggingLeadId === inquiry.id ? "scale-[0.98] opacity-45" : "hover:border-gold/35"
                                }`}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <p className="flex items-center gap-1.5 truncate text-sm font-semibold">
                                      <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-70 transition group-hover:text-gold" />
                                      <span className="truncate">{inquiry.name}</span>
                                    </p>
                                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{inquiry.interest}</p>
                                  </div>
                                  <LeadScore score={score} />
                                </div>
                                <div className="mt-3 flex items-center justify-between gap-2">
                                  <PriorityBadge priority={inquiry.priority} />
                                  <span className="text-xs font-medium text-gold">{value ? money(value) : "—"}</span>
                                </div>
                                <div className="mt-3 rounded-lg bg-secondary/40 px-2.5 py-2">
                                  <div className="flex items-center justify-between gap-2 text-[11px]">
                                    <span className="text-muted-foreground">Next action</span>
                                    <span
                                      className={
                                        followUp === "overdue"
                                          ? "font-medium text-destructive"
                                          : followUp === "today"
                                            ? "font-medium text-gold"
                                            : "text-muted-foreground"
                                      }
                                    >
                                      {inquiry.nextFollowUp && isOpenLead(inquiry)
                                        ? shortDate(inquiry.nextFollowUp)
                                        : "Not scheduled"}
                                    </span>
                                  </div>
                                </div>
                                {inquiry.notes && (
                                  <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                                    {inquiry.notes}
                                  </p>
                                )}
                                <div className="mt-3 flex items-center gap-1 border-t border-border pt-2.5">
                                  <Button asChild variant="ghost" size="icon" className="h-8 w-8" title="Call lead">
                                    <a href={`tel:${inquiry.phone}`}>
                                      <Phone className="h-3.5 w-3.5" />
                                    </a>
                                  </Button>
                                  {isOpenLead(inquiry) && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-8 px-2 text-[11px]"
                                      onClick={() => scheduleTomorrow(inquiry)}
                                    >
                                      <CalendarClock className="mr-1 h-3.5 w-3.5" /> Tomorrow
                                    </Button>
                                  )}
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="ml-auto h-8 w-8"
                                    title="Open lead"
                                    onClick={() => {
                                      setEditing(inquiry);
                                      setFormOpen(true);
                                    }}
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              </article>
                            );
                          })
                        ) : (
                          <div className="rounded-xl border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">
                            No leads in this stage
                          </div>
                        )}
                      </div>
                    </section>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1180px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                    <th className="px-3 py-3 font-medium">Lead</th>
                    <th className="px-3 py-3 font-medium">CRM score</th>
                    <th className="px-3 py-3 font-medium">Opportunity</th>
                    <th className="px-3 py-3 font-medium">Source</th>
                    <th className="px-3 py-3 font-medium">Stage</th>
                    <th className="px-3 py-3 font-medium">Next action</th>
                    <th className="px-3 py-3 font-medium">Activity</th>
                    <th className="px-3 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((inquiry) => {
                    const followUp = followUpState(inquiry);
                    const score = leadScore(inquiry, state.plans);
                    const value = planValue(inquiry, state.plans);
                    const age = activityAgeDays(inquiry);
                    return (
                      <tr
                        key={inquiry.id}
                        className="border-b border-border/70 last:border-0 transition-colors hover:bg-secondary/20"
                      >
                        <td className="px-3 py-4">
                          <div className="flex items-center gap-3">
                            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-gold/35 bg-gold/5 text-xs font-semibold text-gold">
                              {initials(inquiry.name)}
                            </span>
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <p className="truncate font-medium">{inquiry.name}</p>
                                <PriorityBadge priority={inquiry.priority} compact />
                              </div>
                              <a href={`tel:${inquiry.phone}`} className="block text-xs text-muted-foreground hover:text-gold">
                                {inquiry.phone}
                              </a>
                              {inquiry.email && (
                                <a
                                  href={`mailto:${inquiry.email}`}
                                  className="block max-w-52 truncate text-[11px] text-muted-foreground hover:text-gold"
                                >
                                  {inquiry.email}
                                </a>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-4">
                          <LeadScore score={score} showLabel />
                        </td>
                        <td className="px-3 py-4">
                          <p className="font-medium">{inquiry.interest}</p>
                          <p className="text-xs text-gold">{value ? money(value) : "Unpriced interest"}</p>
                        </td>
                        <td className="px-3 py-4 text-muted-foreground">{sourceLabel(inquiry.source)}</td>
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
                              toast.success(`Lead moved to ${statusLabel(value as InquiryStatus)}`);
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
                                      : "font-medium"
                                }
                              >
                                {shortDate(inquiry.nextFollowUp)}
                              </p>
                              <p
                                className={`text-[10px] uppercase tracking-wider ${
                                  followUp === "overdue" ? "text-destructive" : "text-muted-foreground"
                                }`}
                              >
                                {followUp}
                              </p>
                            </div>
                          ) : isOpenLead(inquiry) ? (
                            <button
                              type="button"
                              onClick={() => scheduleTomorrow(inquiry)}
                              className="text-xs font-medium text-gold hover:underline"
                            >
                              + Schedule follow-up
                            </button>
                          ) : (
                            <span className="text-xs text-muted-foreground">Closed</span>
                          )}
                        </td>
                        <td className="px-3 py-4">
                          <div className="flex items-center gap-2">
                            {age === 0 ? (
                              <CheckCircle2 className="h-4 w-4 text-success" />
                            ) : (
                              <Clock3 className={`h-4 w-4 ${age >= 7 ? "text-warning" : "text-muted-foreground"}`} />
                            )}
                            <div>
                              <p className="text-xs">{age === 0 ? "Updated today" : `${age}d since update`}</p>
                              <p className="text-[10px] text-muted-foreground">Added {shortDate(inquiry.createdAt)}</p>
                            </div>
                          </div>
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

function LeadScore({ score, showLabel = false }: { score: number; showLabel?: boolean }) {
  const tone = score >= 75 ? "text-success border-success/35 bg-success/10" : score >= 50 ? "text-gold border-gold/35 bg-gold/10" : "text-muted-foreground border-border bg-secondary/40";
  return (
    <div className="inline-flex items-center gap-2">
      <span className={`grid h-8 min-w-8 place-items-center rounded-full border px-1 text-[11px] font-bold ${tone}`}>
        {score}
      </span>
      {showLabel && (
        <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          {score >= 75 ? "High intent" : score >= 50 ? "Qualified" : "Nurture"}
        </span>
      )}
    </div>
  );
}

function PriorityBadge({ priority, compact = false }: { priority: InquiryPriority; compact?: boolean }) {
  const classes = {
    hot: "border-destructive/40 bg-destructive/10 text-destructive",
    warm: "border-gold/40 bg-gold/10 text-gold",
    cold: "border-sky-400/30 bg-sky-400/10 text-sky-300",
  };
  return (
    <span
      className={`inline-flex rounded-full border font-semibold uppercase tracking-wider ${
        compact ? "px-1.5 py-0.5 text-[8px]" : "px-2.5 py-1 text-[10px]"
      } ${classes[priority]}`}
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
