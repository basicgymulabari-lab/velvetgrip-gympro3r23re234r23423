import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import {
  BellRing,
  CalendarClock,
  CheckCheck,
  CircleDollarSign,
  Mail,
  MessageCircle,
  Smartphone,
  UserRoundSearch,
} from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app/AppShell";
import { PageHeader, Panel, EmptyState } from "@/components/app/Panel";
import { Button } from "@/components/ui/button";
import { markNotificationsRead, useGym } from "@/lib/gym/store";
import {
  activeMembers,
  buildNotifications,
  currentMembership,
  daysUntil,
  dueFor,
  money,
  relative,
} from "@/lib/gym/selectors";
import type { GymState } from "@/lib/gym/types";

type ReminderKind = "expiry" | "due" | "follow_up";

type Reminder = {
  id: string;
  kind: ReminderKind;
  name: string;
  phone: string;
  email?: string;
  detail: string;
  message: string;
};

const REMINDER_META = {
  expiry: { label: "Renewal", icon: CalendarClock, className: "text-warning bg-warning/10" },
  due: { label: "Payment due", icon: CircleDollarSign, className: "text-destructive bg-destructive/10" },
  follow_up: { label: "Inquiry", icon: UserRoundSearch, className: "text-info bg-info/10" },
} as const;

function buildReminderQueue(state: GymState): Reminder[] {
  const reminders: Reminder[] = [];

  activeMembers(state).forEach((member) => {
    const membership = currentMembership(state, member.id);
    if (membership && !membership.frozen) {
      const days = daysUntil(membership.endDate);
      if (days <= state.settings.expiryReminderDays && days >= -30) {
        const timing =
          days < 0
            ? `expired ${Math.abs(days)} day(s) ago`
            : days === 0
              ? "expires today"
              : days === 1
                ? "expires tomorrow"
                : `expires in ${days} days`;
        reminders.push({
          id: `reminder_expiry_${member.id}`,
          kind: "expiry",
          name: member.name,
          phone: member.phone,
          email: member.email || undefined,
          detail: `Membership ${timing}`,
          message: `Hi ${member.name}, this is a reminder from ${state.settings.gymName}. Your membership ${timing}. Please contact us to renew it.`,
        });
      }
    }

    const balance = dueFor(state, member.id);
    if (balance > 0) {
      reminders.push({
        id: `reminder_due_${member.id}`,
        kind: "due",
        name: member.name,
        phone: member.phone,
        email: member.email || undefined,
        detail: `${money(balance, state.settings.currency)} outstanding`,
        message: `Hi ${member.name}, this is a payment reminder from ${state.settings.gymName}. Your outstanding balance is ${money(balance, state.settings.currency)}. Please contact us if you have already paid.`,
      });
    }
  });

  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  (state.inquiries ?? [])
    .filter(
      (inquiry) =>
        inquiry.status !== "converted" &&
        inquiry.status !== "lost" &&
        inquiry.nextFollowUp &&
        new Date(inquiry.nextFollowUp).getTime() <= endOfToday.getTime(),
    )
    .forEach((inquiry) => {
      reminders.push({
        id: `reminder_inquiry_${inquiry.id}`,
        kind: "follow_up",
        name: inquiry.name,
        phone: inquiry.phone,
        email: inquiry.email,
        detail: `Follow up about ${inquiry.interest}`,
        message: `Hi ${inquiry.name}, this is ${state.settings.gymName}. We are following up about your interest in ${inquiry.interest}. Let us know how we can help.`,
      });
    });

  return reminders;
}

function sendReminder(reminder: Reminder, channel: "whatsapp" | "sms" | "email") {
  const digits = reminder.phone.replace(/\D/g, "");
  const body = encodeURIComponent(reminder.message);

  if (channel === "email") {
    if (!reminder.email) return;
    window.location.href = `mailto:${reminder.email}?subject=${encodeURIComponent("Reminder")}&body=${body}`;
  } else {
    const url =
      channel === "whatsapp"
        ? `https://wa.me/${digits}?text=${body}`
        : `sms:${reminder.phone}?body=${body}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  toast.success(`${channel === "whatsapp" ? "WhatsApp" : channel === "sms" ? "SMS" : "Email"} message prepared for ${reminder.name}`);
}

export const Route = createFileRoute("/notifications")({
  head: () => ({
    meta: [
      { title: "Notifications — IRONVAULT Gym Management" },
      {
        name: "description",
        content:
          "All gym alerts in one place: payments due, memberships expiring, member birthdays and low stock warnings.",
      },
      { property: "og:title", content: "Notifications — IRONVAULT Gym Management" },
      {
        property: "og:description",
        content: "Payment dues, expiry reminders, birthdays and stock alerts generated on-device.",
      },
    ],
  }),
  component: () => (
    <AppShell>
      <NotificationsPage />
    </AppShell>
  ),
});

function NotificationsPage() {
  const state = useGym();
  const items = useMemo(() => (state ? buildNotifications(state) : []), [state]);
  const reminders = useMemo(() => (state ? buildReminderQueue(state) : []), [state]);
  if (!state) return null;

  const read = new Set(state.readNotifications);
  const unread = items.filter((n) => !read.has(n.id));

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle={`${unread.length} unread of ${items.length} alerts`}
        actions={
          <Button
            variant="secondary"
            disabled={unread.length === 0}
            onClick={() => {
              markNotificationsRead(items.map((n) => n.id));
              toast.success("All notifications marked as read");
            }}
          >
            <CheckCheck className="mr-2 h-4 w-4" /> Mark all read
          </Button>
        }
      />

      <Panel
        title="Reminder Center"
        description="Prepared automatically from live memberships, balances and inquiry follow-ups"
        className="mb-6"
        actions={
          <span className="rounded-full border border-gold/30 bg-gold/10 px-3 py-1 text-xs font-medium text-gold">
            {reminders.length} ready
          </span>
        }
      >
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          {(["expiry", "due", "follow_up"] as const).map((kind) => {
            const meta = REMINDER_META[kind];
            const Icon = meta.icon;
            const count = reminders.filter((reminder) => reminder.kind === kind).length;
            return (
              <div key={kind} className="flex items-center gap-3 rounded-xl border border-border bg-secondary/30 p-3">
                <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${meta.className}`}>
                  <Icon className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-xs text-muted-foreground">{meta.label}</p>
                  <p className="font-display text-2xl text-gold">{count}</p>
                </div>
              </div>
            );
          })}
        </div>

        {reminders.length === 0 ? (
          <EmptyState title="No reminders are due" hint="The queue updates automatically as your records change." />
        ) : (
          <div className="max-h-[520px] space-y-2 overflow-y-auto pr-1">
            {reminders.map((reminder) => {
              const meta = REMINDER_META[reminder.kind];
              const Icon = meta.icon;
              return (
                <article
                  key={reminder.id}
                  className="grid gap-3 rounded-xl border border-border bg-secondary/20 p-3 transition-colors hover:border-gold/30 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-4"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${meta.className}`}>
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-semibold">{reminder.name}</p>
                        <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                          {meta.label}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">{reminder.detail}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 sm:flex">
                    <Button
                      variant="secondary"
                      size="sm"
                      className="text-xs"
                      disabled={!reminder.phone}
                      onClick={() => sendReminder(reminder, "whatsapp")}
                    >
                      <MessageCircle className="mr-1.5 h-3.5 w-3.5" /> WhatsApp
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="text-xs"
                      disabled={!reminder.phone}
                      onClick={() => sendReminder(reminder, "sms")}
                    >
                      <Smartphone className="mr-1.5 h-3.5 w-3.5" /> SMS
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="text-xs"
                      disabled={!reminder.email}
                      onClick={() => sendReminder(reminder, "email")}
                    >
                      <Mail className="mr-1.5 h-3.5 w-3.5" /> Email
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          Messages are prepared automatically. Sending opens WhatsApp, SMS or your email app for
          final confirmation. Fully unattended delivery requires a connected messaging provider.
        </p>
      </Panel>

      <Panel>
        {items.length === 0 ? (
          <EmptyState
            title="You're all caught up"
            hint="New alerts will show up here automatically."
          />
        ) : (
          <ul className="divide-y divide-border/60">
            {items.map((n) => {
              const isRead = read.has(n.id);
              const row = (
                <div className="flex items-start gap-4 py-4">
                  <span
                    className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl border ${
                      isRead
                        ? "border-border bg-secondary/40 text-muted-foreground"
                        : "border-gold/40 bg-gold/10 text-gold"
                    }`}
                  >
                    <BellRing className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p
                      className={`truncate text-sm ${isRead ? "text-muted-foreground" : "font-medium"}`}
                    >
                      {n.title}
                    </p>
                    <p className="text-xs text-muted-foreground">{n.description}</p>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">{relative(n.date)}</span>
                </div>
              );
              return (
                <li key={n.id}>
                  {n.href ? (
                    <Link
                      to={n.href}
                      search={n.search as never}
                      className="block rounded-lg px-2 transition-colors hover:bg-secondary/50"
                    >
                      {row}
                    </Link>
                  ) : (
                    row
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </>
  );
}
