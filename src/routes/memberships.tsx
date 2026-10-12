import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, Snowflake, Trash2, Pencil, Lock, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app/AppShell";
import { PageHeader, Panel, EmptyState } from "@/components/app/Panel";
import { StatusBadge } from "@/components/app/StatCard";
import { TablePager } from "@/components/app/TablePager";
import { RenewDialog } from "./members.$memberId";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { isPositiveMoneyAmount, isSafeMoneyAmount, isSafeMoneySum } from "@/lib/gym/money";
import { trashPlan, savePlan, toggleFreeze, useGym } from "@/lib/gym/store";
import {
  activeMembers,
  currentMembership,
  livePlans,
  membershipRoster,
  membershipDaysLeft,
  membershipHistory,
  money,
  planOf,
  shortDate,
} from "@/lib/gym/selectors";
import type { Plan } from "@/lib/gym/types";

export const Route = createFileRoute("/memberships")({
  head: () => ({
    meta: [
      { title: "Memberships — IRONVAULT Gym Management" },
      {
        name: "description",
        content:
          "Create membership plans, renew or freeze memberships, follow up on expiries and review renewal history.",
      },
      { property: "og:title", content: "Memberships — IRONVAULT Gym Management" },
      {
        property: "og:description",
        content: "Plans, renewals, freezes, expiry reminders and full membership history.",
      },
    ],
  }),
  component: () => (
    <AppShell>
      <MembershipsPage />
    </AppShell>
  ),
});

const MEMBERSHIP_PAGE_SIZE = 25;
const MEMBERSHIP_TABS = ["all", "expiring", "expired", "frozen", "unassigned"] as const;
type MembershipTab = (typeof MEMBERSHIP_TABS)[number];

function MembershipsPage() {
  const state = useGym();
  const [activeTab, setActiveTab] = useState<MembershipTab>("all");
  const [page, setPage] = useState(1);
  const [planOpen, setPlanOpen] = useState(false);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [renewFor, setRenewFor] = useState<string | null>(null);
  const [trashPlanTarget, setTrashPlanTarget] = useState<Plan | null>(null);
  const [lockedPlan, setLockedPlan] = useState<Plan | null>(null);
  const [plansExpanded, setPlansExpanded] = useState(true);

  const rows = useMemo(() => {
    if (!state) return [];
    return membershipRoster(state);
  }, [state]);

  if (!state) return null;
  const cur = state.settings.currency;
  const expiring = rows.filter((r) => r.status === "expiring");
  const expired = rows.filter((r) => r.status === "expired" && r.ms);
  const frozen = rows.filter((r) => r.status === "frozen");
  const unassigned = rows.filter((r) => r.status === "unassigned");
  const allMemberships = rows.filter((r) => r.ms);

  return (
    <>
      <PageHeader
        title="Membership Management"
        subtitle="Plans, renewals, freezes and expiry follow-ups"
        actions={
          <Button
            onClick={() => {
              setEditing(null);
              setPlanOpen(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" /> Create Plan
          </Button>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {[
          ["Active plans", String(livePlans(state).filter((p) => p.active).length)],
          ["Expiring soon", String(expiring.length)],
          ["Expired", String(expired.length)],
          ["Frozen", String(frozen.length)],
          ["No plan", String(unassigned.length)],
        ].map(([label, value]) => (
          <div key={label} className="surface-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
            <p className="mt-1 font-display text-3xl text-gold">{value}</p>
          </div>
        ))}
      </div>

      <section className="surface-panel hairline-top relative mb-6 overflow-hidden rounded-2xl">
        <button
          type="button"
          aria-expanded={plansExpanded}
          aria-controls="membership-plans-content"
          className="flex w-full items-center justify-between gap-4 border-b border-border px-4 py-4 text-left transition-colors hover:bg-secondary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold sm:px-5"
          onClick={() => setPlansExpanded((expanded) => !expanded)}
        >
          <span className="font-display text-xl tracking-wide">Membership Plans</span>
          <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            {plansExpanded ? "Hide plans" : `Show ${livePlans(state).length} plans`}
            <ChevronDown
              className={`h-5 w-5 text-gold transition-transform duration-300 ease-out ${
                plansExpanded ? "rotate-180" : "rotate-0"
              }`}
            />
          </span>
        </button>
        <div
          id="membership-plans-content"
          className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${
            plansExpanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
          }`}
        >
          <div className="overflow-hidden">
            <div className="grid gap-4 p-4 sm:grid-cols-2 sm:p-5 xl:grid-cols-3">
              {livePlans(state).map((p) => (
                <div
                  key={p.id}
                  className="group relative rounded-2xl border border-border bg-secondary/30 p-5 transition-all hover:border-gold/40"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 truncate font-display text-xl tracking-wide">
                        {p.name}
                        {p.locked && <Lock className="h-3.5 w-3.5 shrink-0 text-gold" />}
                      </p>
                      <p className="text-xs text-muted-foreground">{p.durationDays} days</p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        aria-label="Edit plan"
                        onClick={() => {
                          setEditing(p);
                          setPlanOpen(true);
                        }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        aria-label="Delete plan"
                        onClick={() => (p.locked ? setLockedPlan(p) : setTrashPlanTarget(p))}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <p className="mt-3 font-display text-3xl text-gradient-gold">
                    {money(p.price, cur)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Default joining fee: {money(p.joiningFee ?? 1000, cur)}
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">{p.description}</p>
                  <p className="mt-3 text-xs text-muted-foreground">
                    {
                      activeMembers(state).filter(
                        (m) => currentMembership(state, m.id)?.planId === p.id,
                      ).length
                    }{" "}
                    members enrolled
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          const nextTab = value as MembershipTab;
          if (!MEMBERSHIP_TABS.includes(nextTab)) return;
          setActiveTab(nextTab);
          setPage(1);
        }}
      >
        <TabsList className="mb-4 flex-wrap">
          <TabsTrigger value="all">All memberships</TabsTrigger>
          <TabsTrigger value="expiring">Renewal reminders ({expiring.length})</TabsTrigger>
          <TabsTrigger value="expired">Expired ({expired.length})</TabsTrigger>
          <TabsTrigger value="frozen">Frozen ({frozen.length})</TabsTrigger>
          <TabsTrigger value="unassigned">No plan ({unassigned.length})</TabsTrigger>
        </TabsList>

        {(
          [
            ["all", allMemberships],
            ["expiring", expiring],
            ["expired", expired],
            ["frozen", frozen],
            ["unassigned", unassigned],
          ] as const
        ).map(([key, list]) => {
          const pageCount = Math.max(1, Math.ceil(list.length / MEMBERSHIP_PAGE_SIZE));
          const currentPage = key === activeTab ? Math.min(page, pageCount) : 1;
          const visibleRows = list.slice(
            (currentPage - 1) * MEMBERSHIP_PAGE_SIZE,
            currentPage * MEMBERSHIP_PAGE_SIZE,
          );

          return (
            <TabsContent key={key} value={key}>
              <Panel>
                {list.length === 0 ? (
                  <EmptyState
                    title="Nothing here"
                    hint={
                      key === "unassigned"
                        ? "These profiles have no membership term to freeze. Assign a plan only if they should begin or renew a membership."
                        : key === "expired"
                          ? "Only saved membership terms can expire or be frozen. Profiles without a membership term appear under No plan."
                        : "This list is currently empty."
                    }
                  />
                ) : (
                  <>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[820px] text-sm">
                        <thead>
                          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                            <th className="py-3">Member</th>
                            <th className="py-3">Plan</th>
                            <th className="py-3">Period</th>
                            <th className="py-3">Remaining</th>
                            <th className="py-3">Status</th>
                            <th className="py-3">Terms</th>
                            <th className="py-3 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleRows.map(({ member, ms, status }) => {
                            const left = ms ? membershipDaysLeft(ms) : null;
                            return (
                              <tr
                                key={member.id}
                                className="border-b border-border/50 hover:bg-secondary/40"
                              >
                                <td className="py-3">
                                  <Link
                                    to="/members/$memberId"
                                    params={{ memberId: member.id }}
                                    search={{ tab: undefined }}
                                    className="font-medium hover:text-gold"
                                  >
                                    {member.name}
                                  </Link>
                                  <p className="text-xs text-muted-foreground">{member.phone}</p>
                                </td>
                                <td className="py-3 text-muted-foreground">
                                  {ms ? (planOf(state, ms.planId)?.name ?? "Plan unavailable") : "No plan assigned"}
                                </td>
                                <td className="py-3 text-muted-foreground">
                                  {ms
                                    ? `${shortDate(ms.startDate)} → ${shortDate(ms.endDate)}`
                                    : "No membership term recorded"}
                                </td>
                                <td className="py-3">
                                  <span
                                    className={
                                      left !== null && left < 0
                                        ? "text-destructive"
                                        : left !== null && left <= 7
                                          ? "text-warning"
                                          : ""
                                    }
                                  >
                                    {left === null
                                      ? "—"
                                      : left < 0
                                        ? `${Math.abs(left)}d overdue${ms?.frozen ? " · paused" : ""}`
                                        : `${left}d ${ms?.frozen ? "paused" : "left"}`}
                                  </span>
                                </td>
                                <td className="py-3">
                                  <StatusBadge status={status} />
                                </td>
                                <td className="py-3 text-muted-foreground">
                                  {membershipHistory(state, member.id).length}
                                </td>
                                <td className="py-3">
                                  <div className="flex justify-end gap-1">
                                    {ms && (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 px-2 text-muted-foreground hover:text-foreground"
                                        aria-label={ms.frozen ? "Unfreeze membership" : "Freeze membership"}
                                        title={ms.frozen ? "Unfreeze membership" : "Freeze membership"}
                                        onClick={() => {
                                          if (toggleFreeze(ms.id))
                                            toast.success(
                                              ms.frozen
                                                ? "Membership unfrozen"
                                                : "Membership frozen",
                                            );
                                          else toast.error("Membership was not changed.");
                                        }}
                                      >
                                        <Snowflake className="mr-1.5 h-4 w-4" />
                                        {ms.frozen ? "Unfreeze" : "Freeze"}
                                      </Button>
                                    )}
                                    {!ms && (
                                      <span
                                        className="px-2 text-xs text-muted-foreground"
                                        title="A member without a membership term cannot be frozen. Assign a plan first."
                                      >
                                        No term to freeze
                                      </span>
                                    )}
                                    <Button
                                      size="sm"
                                      variant="secondary"
                                      onClick={() => setRenewFor(member.id)}
                                    >
                                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                                      {ms ? "Renew" : "Assign plan"}
                                    </Button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <TablePager
                      page={currentPage}
                      pageSize={MEMBERSHIP_PAGE_SIZE}
                      total={list.length}
                      onPage={setPage}
                    />
                  </>
                )}
              </Panel>
            </TabsContent>
          );
        })}
      </Tabs>

      {renewFor && (
        <RenewDialog open onOpenChange={(v) => !v && setRenewFor(null)} memberId={renewFor} />
      )}
      <PlanDialog open={planOpen} onOpenChange={setPlanOpen} plan={editing} />

      <Dialog open={!!trashPlanTarget} onOpenChange={(v) => !v && setTrashPlanTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display text-2xl tracking-wide">
              Move this membership plan to Trash?
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This membership plan will be moved to Trash. You can restore it within 30 days before
              it is permanently deleted.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setTrashPlanTarget(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  if (!trashPlan(trashPlanTarget!.id)) {
                    toast.error("Plan was not moved to Trash.");
                    return;
                  }
                  toast.success("Plan moved to Trash");
                  setTrashPlanTarget(null);
                }}
              >
                Move to Trash
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!lockedPlan} onOpenChange={(v) => !v && setLockedPlan(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display text-2xl tracking-wide">
              This membership plan is locked
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This membership plan is protected and cannot be deleted while it is locked. Please
              unlock the plan first if you want to move it to Trash.
            </p>
            <div className="flex justify-end">
              <Button onClick={() => setLockedPlan(null)}>OK</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PlanDialog({
  open,
  onOpenChange,
  plan,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  plan: Plan | null;
}) {
  const [form, setForm] = useState({
    name: "",
    price: "",
    joiningFee: "1000",
    durationDays: "",
    description: "",
    locked: false,
  });
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setForm({
        name: plan?.name ?? "",
        price: plan ? String(plan.price) : "",
        joiningFee: String(plan?.joiningFee ?? 1000),
        durationDays: plan ? String(plan.durationDays) : "",
        description: plan?.description ?? "",
        locked: plan?.locked ?? false,
      });
      setTouched(false);
    }
  }, [open, plan]);

  const price = Number(form.price);
  const joiningFee = Number(form.joiningFee);
  const durationDays = Number(form.durationDays);
  const invalid =
    form.name.trim().length < 2 ||
    form.name.trim().length > 60 ||
    !isPositiveMoneyAmount(price) ||
    !isSafeMoneyAmount(joiningFee) ||
    joiningFee < 0 ||
    !isSafeMoneySum(price, joiningFee) ||
    !Number.isSafeInteger(durationDays) ||
    durationDays <= 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display text-2xl tracking-wide">
            {plan ? "Edit Plan" : "Create Membership Plan"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Plan name</Label>
            <Input
              value={form.name}
              maxLength={60}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label>Price</Label>
              <Input
                type="number"
                min={0}
                value={form.price}
                onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Default joining fee</Label>
              <Input
                type="number"
                min={0}
                value={form.joiningFee}
                onChange={(e) => setForm((f) => ({ ...f, joiningFee: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Duration (days)</Label>
              <Input
                type="number"
                min={1}
                step={1}
                value={form.durationDays}
                onChange={(e) => setForm((f) => ({ ...f, durationDays: e.target.value }))}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea
              rows={3}
              maxLength={220}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>
          <div className="flex items-center justify-between rounded-xl border border-border bg-secondary/30 p-3">
            <div>
              <Label>Lock this membership plan</Label>
              <p className="text-xs text-muted-foreground">
                Locked plans cannot be moved to Trash.
              </p>
            </div>
            <Switch
              checked={form.locked}
              onCheckedChange={(v) => setForm((f) => ({ ...f, locked: v }))}
            />
          </div>
          {touched && invalid && (
            <p className="text-xs text-destructive">
              Provide a name, a representable payable amount, a non-negative joining fee and a whole-number duration of at least 1 day.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setTouched(true);
                if (invalid) return;
                const saved = savePlan({
                  id: plan?.id,
                  name: form.name.trim(),
                  price,
                  joiningFee,
                  durationDays,
                  description: form.description.trim(),
                  active: true,
                  locked: form.locked,
                  deletedAt: plan?.deletedAt ?? null,
                });
                if (!saved) return toast.error("The plan details are invalid and were not saved.");
                toast.success(plan ? "Plan updated" : "Plan created");
                onOpenChange(false);
              }}
            >
              {plan ? "Save plan" : "Create plan"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
