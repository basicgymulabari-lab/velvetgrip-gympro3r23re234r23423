import { AccountSecurity } from "@/components/app/AccountSecurity";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  Database,
  Download,
  Upload,
  RotateCcw,
  Save,
  ShieldAlert,
  ShieldCheck,
  UserRoundCog,
  Copy,
  Check,
} from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app/AppShell";
import { PageHeader, Panel } from "@/components/app/Panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { REVENUE_METRICS, type RevenueMetric } from "@/lib/gym/selectors";
import type { CalendarSystem, PhoneCountry, ReceptionistPermissions } from "@/lib/gym/types";
import { PHONE_COUNTRIES } from "@/lib/gym/phone";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DEFAULT_RECEPTIONIST_PERMISSIONS,
  exportBackup,
  resetData,
  restoreBackup,
  saveReceptionistAccount,
  sha256,
  setupTemplateData,
  updateSettings,
  useGym,
} from "@/lib/gym/store";

const CURRENCY_BY_COUNTRY: Record<PhoneCountry, string> = {
  nepal: "रु",
  india: "₹",
  usa: "$",
};

const RECEPTIONIST_PERMISSION_OPTIONS: Array<{
  key: keyof ReceptionistPermissions;
  label: string;
}> = [
  { key: "dashboard", label: "Dashboard" },
  { key: "members", label: "Members" },
  { key: "memberships", label: "Memberships" },
  { key: "payments", label: "Payments" },
  { key: "products", label: "Products" },
  { key: "inquiries", label: "Inquiries" },
  { key: "notifications", label: "Notifications" },
  { key: "viewRevenue", label: "View revenue figures" },
];

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — IRONVAULT Gym Management" },
      {
        name: "description",
        content:
          "Configure gym details, invoice numbering, reminder rules and manage offline backup, restore and data reset.",
      },
      { property: "og:title", content: "Settings — IRONVAULT Gym Management" },
      {
        property: "og:description",
        content: "Gym profile, invoicing, alerts and local backup or restore of your data.",
      },
    ],
  }),
  component: () => (
    <AppShell>
      <SettingsPage />
    </AppShell>
  ),
});

function SettingsPage() {
  const state = useGym();
  const fileRef = useRef<HTMLInputElement>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [form, setForm] = useState<Record<string, string> | null>(null);
  const [receptionistDraft, setReceptionistDraft] = useState<{
    enabled: boolean;
    name: string;
    email: string;
    password: string;
    confirmPassword: string;
    permissions: ReceptionistPermissions;
  } | null>(null);
  const [savingReceptionist, setSavingReceptionist] = useState(false);
  const [receptionistSavedOpen, setReceptionistSavedOpen] = useState(false);
  const [receptionistError, setReceptionistError] = useState("");

  useEffect(() => {
    if (!state) return;
    const phoneCountry = state.settings.phoneCountry ?? "india";
    const currency = CURRENCY_BY_COUNTRY[phoneCountry];
    if (state.settings.currency !== currency) updateSettings({ currency });
  }, [state?.settings.currency, state?.settings.phoneCountry]);

  if (!state) return null;
  const s = state.settings;
  const receptionist = state.staff?.receptionist;
  const receptionistForm = receptionistDraft ?? {
    enabled: receptionist?.enabled ?? false,
    name: receptionist?.name ?? "",
    email: receptionist?.email ?? "",
    password: "",
    confirmPassword: "",
    permissions: {
      ...DEFAULT_RECEPTIONIST_PERMISSIONS,
      ...receptionist?.permissions,
    },
  };

  const copyReceptionistLoginLink = async () => {
    const loginUrl = `${window.location.origin}/login`;
    try {
      await navigator.clipboard.writeText(loginUrl);
      toast.success("Receptionist login link copied");
    } catch {
      toast.error(`Copy this login link: ${loginUrl}`);
    }
  };
  const value = (key: keyof typeof s) => form?.[key] ?? String(s[key]);
  const set = (key: string, v: string) => setForm((f) => ({ ...(f ?? {}), [key]: v }));

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Accounts and business data are stored securely on this device — no cloud required"
      />

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="Gym Profile" collapsible>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Gym name" value={value("gymName")} onChange={(v) => set("gymName", v)} />
            <Field label="Tagline" value={value("tagline")} onChange={(v) => set("tagline", v)} />
            <Field label="Phone" value={value("phone")} onChange={(v) => set("phone", v)} />
            <Field label="Email" value={value("email")} onChange={(v) => set("email", v)} />
            <Field
              label="Admin name"
              value={value("adminName")}
              onChange={(v) => set("adminName", v)}
            />
            <div className="space-y-2 sm:col-span-2">
              <Label>Address</Label>
              <Textarea
                rows={2}
                maxLength={180}
                value={value("address")}
                onChange={(e) => set("address", e.target.value)}
              />
            </div>
          </div>
          <div className="mt-5 flex justify-end">
            <Button
              onClick={() => {
                if (!form) return toast.info("No changes to save");
                if ((form.gymName ?? s.gymName).trim().length < 2)
                  return toast.error("Gym name is too short");
                updateSettings({
                  gymName: (form.gymName ?? s.gymName).trim(),
                  tagline: (form.tagline ?? s.tagline).trim(),
                  phone: (form.phone ?? s.phone).trim(),
                  email: (form.email ?? s.email).trim(),
                  adminName: (form.adminName ?? s.adminName).trim(),
                  address: (form.address ?? s.address).trim(),
                });
                setForm(null);
                toast.success("Settings saved");
              }}
            >
              <Save className="mr-2 h-4 w-4" /> Save changes
            </Button>
          </div>
        </Panel>

        <Panel title="Invoicing & Alerts" collapsible>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Invoice prefix</Label>
              <Input
                value={s.invoicePrefix}
                maxLength={8}
                onChange={(e) => updateSettings({ invoicePrefix: e.target.value.toUpperCase() })}
              />
            </div>
            <div className="space-y-2">
              <Label>Expiry reminder (days before)</Label>
              <Input
                type="number"
                min={1}
                max={60}
                value={s.expiryReminderDays}
                onChange={(e) =>
                  updateSettings({
                    expiryReminderDays: Math.min(60, Math.max(1, Number(e.target.value) || 7)),
                  })
                }
              />
            </div>
          </div>
          <div className="mt-4 space-y-2">
            <Label>Dashboard revenue card</Label>
            <Select
              value={s.revenueCardMetric ?? "today"}
              onValueChange={(v) => updateSettings({ revenueCardMetric: v as RevenueMetric })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REVENUE_METRICS.map((m) => (
                  <SelectItem key={m.key} value={m.key}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Chooses which figure the revenue card on the dashboard shows.
            </p>
          </div>
          <div className="mt-4 flex items-center justify-between rounded-xl border border-border bg-secondary/30 p-4">
            <div className="min-w-0 pr-4">
              <p className="text-sm font-medium">Low stock alerts</p>
              <p className="text-xs text-muted-foreground">
                Warn on the dashboard when a product falls below its threshold.
              </p>
            </div>
            <Switch
              checked={s.lowStockAlerts}
              onCheckedChange={(v) => updateSettings({ lowStockAlerts: v })}
            />
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Next invoice number:{" "}
            <span className="text-gold">
              {s.invoicePrefix}-{String(state.invoiceSeq + 1).padStart(6, "0")}
            </span>
          </p>
        </Panel>

        <Panel title="Calendar & Region" collapsible>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Calendar system</Label>
              <Select
                value={s.calendarSystem ?? "gregorian"}
                onValueChange={(selected) =>
                  updateSettings({ calendarSystem: selected as CalendarSystem })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gregorian">Global — Gregorian calendar</SelectItem>
                  <SelectItem value="bikram_sambat">Nepal — Bikram Sambat calendar</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Phone country</Label>
              <Select
                value={s.phoneCountry ?? "india"}
                onValueChange={(selected) => {
                  const phoneCountry = selected as PhoneCountry;
                  updateSettings({
                    phoneCountry,
                    currency: CURRENCY_BY_COUNTRY[phoneCountry],
                  });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PHONE_COUNTRIES.map((country) => (
                    <SelectItem key={country.value} value={country.value}>
                      {country.label} — {country.dialCode}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Currency symbol</Label>
              <Input
                value={CURRENCY_BY_COUNTRY[s.phoneCountry ?? "india"]}
                readOnly
                aria-readonly="true"
                className="cursor-default select-none bg-muted/40 text-muted-foreground"
              />
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Calendar selection controls displayed dates. Phone country applies its dialing code to
            gym, member, emergency-contact and walk-in customer numbers. It also selects that
            country&apos;s currency symbol automatically. The currency symbol cannot be edited
            separately.
          </p>
        </Panel>

        <Panel title="Backup & Restore" collapsible>
          <p className="text-sm text-muted-foreground">
            Export a complete JSON snapshot of your gym data and keep it somewhere safe. Restoring
            replaces everything currently on this device.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                const url = URL.createObjectURL(
                  new Blob([exportBackup()], { type: "application/json" }),
                );
                const a = document.createElement("a");
                a.href = url;
                a.download = `ironvault-backup-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                URL.revokeObjectURL(url);
                toast.success("Backup downloaded");
              }}
            >
              <Download className="mr-2 h-4 w-4" /> Export backup
            </Button>
            <Button variant="secondary" onClick={() => fileRef.current?.click()}>
              <Upload className="mr-2 h-4 w-4" /> Restore backup
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  restoreBackup(await file.text());
                  toast.success("Backup restored");
                } catch {
                  toast.error("Could not read that file");
                }
                e.target.value = "";
              }}
            />
          </div>
        </Panel>

        <Panel
          title="Staff Access"
          description="A separate, restricted account for your receptionist"
          collapsible
        >
          <div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-secondary/30 p-4">
            <div className="flex min-w-0 gap-3">
              <UserRoundCog className="mt-0.5 h-5 w-5 shrink-0 text-gold" />
              <div>
                <p className="text-sm font-medium">Receptionist account</p>
                <p className="text-xs text-muted-foreground">
                  Allow front-desk access using separate login credentials.
                </p>
              </div>
            </div>
            <Switch
              checked={receptionistForm.enabled}
              onCheckedChange={(enabled) => setReceptionistDraft({ ...receptionistForm, enabled })}
              aria-label="Enable receptionist account"
            />
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="receptionist-name">Receptionist name</Label>
              <Input
                id="receptionist-name"
                value={receptionistForm.name}
                placeholder="Front Desk"
                onChange={(event) => (
                  setReceptionistError(""),
                  setReceptionistDraft({ ...receptionistForm, name: event.target.value })
                )}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="receptionist-email">Login email</Label>
              <Input
                id="receptionist-email"
                type="email"
                value={receptionistForm.email}
                placeholder="reception@yourgym.com"
                onChange={(event) => (
                  setReceptionistError(""),
                  setReceptionistDraft({ ...receptionistForm, email: event.target.value })
                )}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="receptionist-password">Receptionist password</Label>
              <Input
                id="receptionist-password"
                type="password"
                minLength={8}
                autoComplete="new-password"
                value={receptionistForm.password}
                placeholder="At least 8 characters"
                onChange={(event) => (
                  setReceptionistError(""),
                  setReceptionistDraft({ ...receptionistForm, password: event.target.value })
                )}
              />
              <p className="text-xs text-muted-foreground">
                Required every time you save. It must differ from the administrator password.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="receptionist-confirm-password">Confirm password</Label>
              <Input
                id="receptionist-confirm-password"
                type="password"
                minLength={8}
                autoComplete="new-password"
                value={receptionistForm.confirmPassword}
                placeholder="Type the same password again"
                onChange={(event) => (
                  setReceptionistError(""),
                  setReceptionistDraft({
                    ...receptionistForm,
                    confirmPassword: event.target.value,
                  })
                )}
              />
            </div>
          </div>

          {receptionistError && (
            <p className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {receptionistError}
            </p>
          )}

          {receptionist && !receptionistError && (
            <p className="mt-4 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
              Receptionist password is securely saved. Password fields are intentionally cleared
              after saving and the password cannot be displayed.
            </p>
          )}

          <div className="mt-4 rounded-xl border border-success/25 bg-success/5 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-success">
              <ShieldCheck className="h-4 w-4" /> Receptionist permissions
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {RECEPTIONIST_PERMISSION_OPTIONS.map(({ key, label }) => {
                const allowed = receptionistForm.permissions[key];
                return (
                  <button
                    key={key}
                    type="button"
                    role="switch"
                    aria-checked={allowed}
                    className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-xs transition-all ${
                      allowed
                        ? "border-success/40 bg-success/10 text-foreground"
                        : "border-border bg-background/40 text-muted-foreground"
                    }`}
                    onClick={() =>
                      setReceptionistDraft({
                        ...receptionistForm,
                        permissions: {
                          ...receptionistForm.permissions,
                          [key]: !allowed,
                        },
                      })
                    }
                  >
                    <span>{label}</span>
                    <span
                      className={`grid h-5 w-5 place-items-center rounded-full border ${
                        allowed
                          ? "border-success bg-success text-primary-foreground"
                          : "border-border"
                      }`}
                    >
                      {allowed && <Check className="h-3 w-3" />}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Expenses, Reports, Trash and Settings remain owner-only and are hidden from this role.
            </p>
          </div>

          <div className="mt-4 flex flex-wrap justify-end gap-2">
            {receptionist && (
              <Button variant="secondary" onClick={copyReceptionistLoginLink}>
                <Copy className="mr-2 h-4 w-4" /> Copy login link
              </Button>
            )}
            <Button
              disabled={savingReceptionist}
              onClick={async () => {
                setReceptionistError("");
                const name = receptionistForm.name.trim();
                const email = receptionistForm.email.trim();
                if (name.length < 2) return setReceptionistError("Enter the receptionist's name.");
                if (!/^\S+@\S+\.\S+$/.test(email))
                  return setReceptionistError("Enter a valid login email.");
                const normalizedPassword = receptionistForm.password.trim();
                const confirmedPassword = receptionistForm.confirmPassword.trim();
                if (normalizedPassword.length < 8)
                  return setReceptionistError(
                    "Receptionist password must be at least 8 characters.",
                  );
                if (normalizedPassword !== confirmedPassword)
                  return setReceptionistError("Receptionist passwords do not match.");
                if (email.toLowerCase() === state.auth.email.toLowerCase())
                  return setReceptionistError(
                    "Use an email different from the administrator account.",
                  );
                if ((await sha256(normalizedPassword)) === state.auth.passwordHash)
                  return setReceptionistError(
                    "Receptionist password must be different from the administrator password.",
                  );

                setSavingReceptionist(true);
                const saved = await saveReceptionistAccount({
                  enabled: receptionistForm.enabled,
                  name,
                  email,
                  password: normalizedPassword,
                  permissions: receptionistForm.permissions,
                });
                setSavingReceptionist(false);
                if (!saved)
                  return setReceptionistError(
                    "Could not save the receptionist account to browser storage. Free some browser storage and try again.",
                  );
                setReceptionistDraft(null);
                setReceptionistSavedOpen(true);
              }}
            >
              <Save className="mr-2 h-4 w-4" />
              {savingReceptionist ? "Saving..." : "Save receptionist"}
            </Button>
          </div>
        </Panel>

        <Panel title="Admin Security" collapsible>
          <AccountSecurity />
        </Panel>

        <Panel title="Danger Zone" collapsible>
          <div className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-4">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <p className="text-sm text-muted-foreground">
              Resetting permanently wipes every member, customer, plan, payment, product, sale,
              expense and activity record. Your app and gym settings remain unchanged.
            </p>
          </div>
          <div className="mt-4 flex flex-col items-end gap-2">
            <Button variant="secondary" onClick={() => setTemplateOpen(true)}>
              <Database className="mr-2 h-4 w-4" /> Set Up Template Data
            </Button>
            <Button variant="destructive" onClick={() => setResetOpen(true)}>
              <RotateCcw className="mr-2 h-4 w-4" /> Reset all data
            </Button>
          </div>
        </Panel>
      </div>

      <Dialog open={receptionistSavedOpen} onOpenChange={setReceptionistSavedOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display text-2xl tracking-wide">
              Receptionist saved successfully
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex gap-3 rounded-xl border border-success/30 bg-success/10 p-4">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-success" />
              <div>
                <p className="text-sm font-medium">The receptionist account is ready</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  They can sign in with their email and password from the regular staff login page.
                  Only the permissions you selected will be available.
                </p>
              </div>
            </div>
            <div className="rounded-xl border border-border bg-secondary/30 p-3">
              <p className="text-xs text-muted-foreground">Login email</p>
              <p className="mt-1 break-all text-sm font-medium">
                {state.staff?.receptionist?.email}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              For security, the password is never placed in the copied link. Share it separately.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" onClick={() => setReceptionistSavedOpen(false)}>
                Done
              </Button>
              <Button onClick={copyReceptionistLoginLink}>
                <Copy className="mr-2 h-4 w-4" /> Copy login link
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display text-2xl tracking-wide text-destructive">
              Reset all data?
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Export a backup first if you might need this data again.
            </p>
            <div className="space-y-2">
              <Label>
                Type <span className="font-mono text-destructive">RESET</span> to confirm
              </Label>
              <Input
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="RESET"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setResetOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={confirm !== "RESET"}
                onClick={() => {
                  resetData();
                  setConfirm("");
                  setResetOpen(false);
                  toast.success("All data reset");
                }}
              >
                Reset everything
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={templateOpen} onOpenChange={setTemplateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display text-2xl tracking-wide">
              Set up template data?
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This replaces all current business records with the default starter data, including
              members, plans, payments, products, sales and expenses. Your settings remain
              unchanged.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setTemplateOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  setupTemplateData();
                  setTemplateOpen(false);
                  toast.success("Template data set up successfully");
                }}
              >
                Set Up Template Data
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Field({
  label,
  value,
  onChange,
  max = 80,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  max?: number;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input value={value} maxLength={max} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
