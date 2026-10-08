import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArchiveRestore,
  Building2,
  Database,
  Download,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader, Panel } from "@/components/app/Panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";

type GymRow = {
  gym_id: string;
  gym_name: string;
  owner_name: string;
  owner_email: string;
  account_status: string;
  created_at: string;
  last_activity_at: string;
  member_count: number;
  subscription_status: string;
  subscription_source: string | null;
  subscription_expires_at: string | null;
  days_remaining: number;
  total_count: number;
};

type Summary = Record<string, number | string>;
type Backup = {
  backup_id: string;
  gym_id: string;
  gym_name: string;
  backup_type: string;
  status: string;
  size_bytes: number;
  created_at: string;
  created_by_email: string;
};
type Audit = {
  id: number;
  admin_email: string;
  gym_id: string | null;
  gym_name: string | null;
  action: string;
  result: string;
  metadata: unknown;
  created_at: string;
  total_count: number;
};

type View = "overview" | "gyms" | "backups" | "audit";

const date = (value?: string | null) =>
  value
    ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(value),
      )
    : "—";

const prettyBytes = (value: number) =>
  value < 1024 * 1024
    ? `${(value / 1024).toFixed(1)} KB`
    : `${(value / (1024 * 1024)).toFixed(1)} MB`;

function metric(summary: Summary | null, name: string) {
  const value = summary?.[name];
  return typeof value === "number" ? value.toLocaleString("en-IN") : "—";
}

export function CeoControlCenter() {
  const [view, setView] = useState<View>("overview");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [gyms, setGyms] = useState<GymRow[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [totalGyms, setTotalGyms] = useState(0);
  const [selectedGym, setSelectedGym] = useState("");
  const [backups, setBackups] = useState<Backup[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const pageSize = 25;

  const loadSummary = useCallback(async () => {
    const { data, error } = await supabase.rpc("platform_dashboard_summary");
    if (error) throw error;
    setSummary((data ?? null) as Summary | null);
  }, []);

  const loadGyms = useCallback(async () => {
    const { data, error } = await supabase.rpc("platform_list_gyms", {
      p_search: search.trim(),
      p_status: status,
      p_page: page,
      p_page_size: pageSize,
    });
    if (error) throw error;
    const result = (data ?? []) as GymRow[];
    setGyms(result);
    setTotalGyms(Number(result[0]?.total_count ?? 0));
    setSelectedGym((current) =>
      result.some((gym) => gym.gym_id === current) ? current : (result[0]?.gym_id ?? ""),
    );
  }, [page, pageSize, search, status]);

  const loadBackups = useCallback(async (gymId: string) => {
    if (!gymId) {
      setBackups([]);
      return;
    }
    const { data, error } = await supabase.rpc("platform_list_gym_backups", { p_gym_id: gymId });
    if (error) throw error;
    setBackups((data ?? []) as Backup[]);
  }, []);

  const loadAudit = useCallback(async () => {
    const { data, error } = await supabase.rpc("platform_list_audit_logs", {
      p_page: 1,
      p_page_size: 50,
    });
    if (error) throw error;
    setAudit((data ?? []) as Audit[]);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([loadSummary(), loadGyms(), loadAudit()]);
    } catch {
      toast.error(
        "CEO data could not be loaded. Check that the latest Supabase migrations are applied.",
      );
    } finally {
      setLoading(false);
    }
  }, [loadAudit, loadGyms, loadSummary]);

  useEffect(() => {
    const timer = window.setTimeout(
      () => void loadGyms().catch(() => toast.error("Gym list could not be loaded.")),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [loadGyms]);

  useEffect(() => {
    void loadSummary().catch(() => undefined);
  }, [loadSummary]);

  useEffect(() => {
    if (view === "backups")
      void loadBackups(selectedGym).catch(() => toast.error("Backup history could not be loaded."));
  }, [loadBackups, selectedGym, view]);

  const selectedGymName = useMemo(
    () => gyms.find((gym) => gym.gym_id === selectedGym)?.gym_name ?? "",
    [gyms, selectedGym],
  );

  const setGymStatus = async (gym: GymRow) => {
    const next =
      gym.account_status === "suspended" || gym.account_status === "pending"
        ? "active"
        : "suspended";
    const note =
      next === "suspended"
        ? window.prompt(`Optional reason for suspending ${gym.gym_name}:`, "")
        : "";
    if (note === null) return;
    if (
      next === "active" &&
      !window.confirm(
        `${gym.account_status === "pending" ? "Approve" : "Reactivate"} ${gym.gym_name}?`,
      )
    )
      return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc("platform_set_gym_status", {
        p_gym_id: gym.gym_id,
        p_status: next,
        p_note: note,
      });
      if (error) throw error;
      toast.success(
        next === "active"
          ? gym.account_status === "pending"
            ? "Gym approved."
            : "Gym reactivated."
          : "Gym suspended. Its existing data remains readable.",
      );
      await Promise.all([loadGyms(), loadSummary(), loadAudit()]);
    } catch {
      toast.error("The account status could not be changed.");
    } finally {
      setBusy(false);
    }
  };

  const createBackup = async () => {
    if (!selectedGym) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc("platform_create_gym_backup", { p_gym_id: selectedGym });
      if (error) throw error;
      toast.success("A secure workspace snapshot was saved to backup history.");
      await Promise.all([loadBackups(selectedGym), loadAudit()]);
    } catch {
      toast.error("Backup failed. No production data was modified.");
    } finally {
      setBusy(false);
    }
  };

  const downloadStoredBackup = async (backup: Backup) => {
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("platform_download_gym_backup", {
        p_backup_id: backup.backup_id,
      });
      if (error) throw error;
      const file = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(file);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `gym-backup-${backup.gym_id}-${new Date(backup.created_at).toISOString().slice(0, 10)}.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success("Backup downloaded. Store this customer data securely.");
      await loadAudit();
    } catch {
      toast.error("Backup download failed.");
    } finally {
      setBusy(false);
    }
  };

  const restore = async (backup: Backup) => {
    if (!selectedGym) return;
    const confirmation = window.prompt(
      `This replaces the current workspace with backup from ${date(backup.created_at)}. A pre-restore snapshot will be created first. Type the gym name exactly to continue:`,
    );
    if (confirmation !== selectedGymName) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc("platform_restore_gym_backup", {
        p_backup_id: backup.backup_id,
        p_confirm_gym_name: confirmation,
      });
      if (error) throw error;
      toast.success("Restore completed. A pre-restore snapshot is available in history.");
      await Promise.all([loadBackups(selectedGym), loadGyms(), loadAudit()]);
    } catch {
      toast.error("Restore failed. The database transaction was rolled back.");
    } finally {
      setBusy(false);
    }
  };

  const nav: { id: View; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "gyms", label: "Gyms" },
    { id: "backups", label: "Backups" },
    { id: "audit", label: "Audit log" },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Platform control center"
        subtitle="A separate, server-authorized view of gym accounts. Customer business records are never editable here."
        actions={
          <Button variant="secondary" onClick={() => void refresh()} disabled={loading || busy}>
            {loading ? (
              <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Refresh data
          </Button>
        }
      />
      <nav aria-label="CEO sections" className="flex flex-wrap gap-2 border-b border-border pb-3">
        {nav.map((item) => (
          <Button
            key={item.id}
            variant={view === item.id ? "default" : "secondary"}
            size="sm"
            onClick={() => setView(item.id)}
          >
            {item.label}
          </Button>
        ))}
      </nav>

      {view === "overview" && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ["Total gyms", "total_gyms", Building2],
              ["Active gyms", "active_gyms", ShieldCheck],
              ["Gym members", "total_members", Users],
              ["Expiring in 7 days", "expiring_soon", ArchiveRestore],
            ].map(([label, key, Icon]) => (
              <div key={String(key)} className="surface-panel rounded-xl border border-border p-4">
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>{String(label)}</span>
                  <Icon className="h-4 w-4 text-gold" />
                </div>
                <p className="mt-3 font-display text-3xl">{metric(summary, String(key))}</p>
              </div>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ["Pending", "pending_gyms"],
              ["Suspended", "suspended_gyms"],
              ["Active Pro", "active_pro"],
              ["Workspace data", "workspace_bytes"],
            ].map(([label, key]) => (
              <div key={key} className="rounded-xl border border-border bg-secondary/10 p-4">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
                <p className="mt-2 text-xl font-semibold">
                  {key === "workspace_bytes"
                    ? prettyBytes(Number(summary?.[key] ?? 0))
                    : metric(summary, key)}
                </p>
              </div>
            ))}
          </div>
          <Panel
            title="Operational notes"
            description="Metrics are calculated in Supabase and only a page of gym rows is sent to this browser."
          >
            <p className="text-sm leading-6 text-muted-foreground">
              Subscription income is intentionally not estimated from gym payment records. Provider
              billing transactions and manual/recharge grants are separate, so a revenue total is
              shown only when a verified SaaS billing ledger exists. Member counts reflect roster
              records in each gym workspace.
            </p>
          </Panel>
        </>
      )}

      {view === "gyms" && (
        <Panel
          title="Gym directory"
          description={`${totalGyms.toLocaleString("en-IN")} matching accounts · server-filtered and paginated`}
        >
          <div className="mb-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                value={search}
                onChange={(event) => {
                  setPage(1);
                  setSearch(event.target.value);
                }}
                placeholder="Search gym, owner, email or ID"
              />
            </div>
            <select
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              value={status}
              onChange={(event) => {
                setPage(1);
                setStatus(event.target.value);
              }}
            >
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="pending">Pending</option>
              <option value="suspended">Suspended</option>
              <option value="archived">Archived</option>
              <option value="expiring">Expiring within 30 days</option>
              <option value="expired">Expired Pro</option>
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[850px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="py-3 pr-3">Gym / owner</th>
                  <th className="py-3 pr-3">Members</th>
                  <th className="py-3 pr-3">Account</th>
                  <th className="py-3 pr-3">Subscription</th>
                  <th className="py-3 pr-3">Last activity</th>
                  <th className="py-3">Action</th>
                </tr>
              </thead>
              <tbody>
                {gyms.map((gym) => (
                  <tr key={gym.gym_id} className="border-t border-border">
                    <td className="py-3 pr-3">
                      <p className="font-medium">{gym.gym_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {gym.owner_name} · {gym.owner_email}
                      </p>
                    </td>
                    <td className="py-3 pr-3">{gym.member_count.toLocaleString("en-IN")}</td>
                    <td className="py-3 pr-3 capitalize">{gym.account_status}</td>
                    <td className="py-3 pr-3">
                      {gym.days_remaining
                        ? `Pro · ${gym.days_remaining}d`
                        : gym.subscription_status === "active"
                          ? "Expired"
                          : "Free"}
                      <p className="text-xs text-muted-foreground">
                        {date(gym.subscription_expires_at)}
                      </p>
                    </td>
                    <td className="py-3 pr-3">{date(gym.last_activity_at)}</td>
                    <td className="py-3">
                      <Button
                        size="sm"
                        variant={
                          gym.account_status === "suspended" || gym.account_status === "pending"
                            ? "secondary"
                            : "destructive"
                        }
                        disabled={busy || gym.account_status === "archived"}
                        onClick={() => void setGymStatus(gym)}
                      >
                        {gym.account_status === "pending"
                          ? "Approve"
                          : gym.account_status === "suspended"
                            ? "Reactivate"
                            : "Suspend"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!gyms.length && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No gyms match those filters.
            </p>
          )}
          <div className="mt-4 flex items-center justify-between border-t border-border pt-3 text-sm">
            <span className="text-muted-foreground">
              Page {page} of {Math.max(1, Math.ceil(totalGyms / pageSize))}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={page <= 1}
                onClick={() => setPage((value) => value - 1)}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={page >= Math.ceil(totalGyms / pageSize)}
                onClick={() => setPage((value) => value + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </Panel>
      )}

      {view === "backups" && (
        <Panel
          title="Backup and restore center"
          description="Snapshots are private database records; restores are transactional and first take a pre-restore snapshot."
        >
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <label className="space-y-2 text-sm font-medium">
              Gym
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3"
                value={selectedGym}
                onChange={(event) => setSelectedGym(event.target.value)}
              >
                {gyms.map((gym) => (
                  <option key={gym.gym_id} value={gym.gym_id}>
                    {gym.gym_name} — {gym.owner_email}
                  </option>
                ))}
              </select>
            </label>
            <Button onClick={() => void createBackup()} disabled={!selectedGym || busy}>
              <Database className="mr-2 h-4 w-4" />
              Create snapshot
            </Button>
          </div>
          <div className="mt-5 space-y-2">
            {backups.map((backup) => (
              <div
                key={backup.backup_id}
                className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-medium">
                    {backup.gym_name} ·{" "}
                    {backup.backup_type === "pre_restore"
                      ? "Pre-restore snapshot"
                      : "Manual snapshot"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {date(backup.created_at)} · {prettyBytes(Number(backup.size_bytes))} ·{" "}
                    {backup.created_by_email}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => void downloadStoredBackup(backup)}
                  >
                    <Download className="mr-1 h-3.5 w-3.5" />
                    Download
                  </Button>
                  {backup.backup_type !== "pre_restore" && (
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      onClick={() => void restore(backup)}
                    >
                      Restore…
                    </Button>
                  )}
                </div>
              </div>
            ))}
            {selectedGym && backups.length === 0 && (
              <p className="rounded-lg bg-secondary/15 p-4 text-sm text-muted-foreground">
                No saved snapshots for this gym yet.
              </p>
            )}
          </div>
          <p className="mt-4 text-xs leading-5 text-muted-foreground">
            Snapshots contain gym workspace JSON and are not returned in list queries. Downloaded
            exports are customer-sensitive files; store them in an encrypted, access-controlled
            location. Uploaded private media is not included.
          </p>
        </Panel>
      )}

      {view === "audit" && (
        <Panel
          title="Platform audit log"
          description="Recent sensitive CEO and subscription/key events. Latest 50 entries."
        >
          <div className="space-y-2">
            {audit.map((event) => (
              <article
                key={event.id}
                className="grid gap-1 rounded-lg border border-border p-3 sm:grid-cols-[1fr_auto] sm:items-center"
              >
                <div>
                  <p className="font-medium">{event.action.replaceAll("_", " ")}</p>
                  <p className="text-xs text-muted-foreground">
                    {event.admin_email} · {event.gym_name ?? "Platform"} · {event.result}
                  </p>
                </div>
                <time className="text-xs text-muted-foreground">{date(event.created_at)}</time>
              </article>
            ))}
            {audit.length === 0 && (
              <p className="p-4 text-sm text-muted-foreground">
                No audit events have been recorded.
              </p>
            )}
          </div>
        </Panel>
      )}
    </div>
  );
}
