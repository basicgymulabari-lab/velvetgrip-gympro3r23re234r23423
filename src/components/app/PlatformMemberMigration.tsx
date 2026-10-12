import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Download,
  FileSpreadsheet,
  LoaderCircle,
  MoveRight,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
  UserPlus,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Panel, PageHeader } from "@/components/app/Panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { csvText } from "@/lib/gym/csv";
import { localDateInput } from "@/lib/gym/calendar";
import {
  FIELD_LABELS,
  destinationCapacityNotice,
  findPossibleDuplicates,
  migrationHistoryViewState,
  migrationRosterViewState,
  membersPendingTransferRetry,
  summarizeTransferSelection,
  transferResultNotice,
  mapMigrationRows,
  MIGRATION_FIELDS,
  normalizeAndValidateDraft,
  readMigrationFile,
  suggestedColumnMapping,
  type MigrationDraft,
  type MigrationField,
  type MigrationRow,
} from "@/lib/platform/member-migration";
import { supabase } from "@/integrations/supabase/client";
import { usePlatformLiveUpdates } from "@/components/app/platform-live-updates-context";

type GymOption = {
  gym_id: string;
  gym_name: string;
  owner_email: string;
  account_status: string;
  member_count: number;
  has_workspace: boolean;
  is_source: boolean;
};
type MemberLite = { id: string; name: string; email?: string; phone?: string; deletedAt?: string | null };
type RemoteMigrationMember = {
  member: MemberLite;
  possible_duplicate: boolean;
  current_membership: {
    id: string;
    plan_id: string;
    plan_name: string | null;
    start_date: string;
    end_date: string;
    frozen: boolean;
    active: boolean;
    price: number;
    membership_count?: number;
    active_membership_count?: number;
  } | null;
  total_count: number;
};
type PlanOption = { id: string; name: string; price: number; active: boolean; deleted: boolean };
type MigrationContext = {
  source: { gym_id: string; gym_name: string; member_count: number };
  destination: {
    gym_id: string;
    gym_name: string;
    member_count: number;
    has_pro?: boolean;
    remaining_free_slots?: number | null;
  };
  source_plans: PlanOption[];
  destination_plans: PlanOption[];
};
type MigrationHistory = {
  operation_id: string;
  operation_type: string;
  source_gym_name: string | null;
  destination_gym_name: string | null;
  admin_email: string;
  status: string;
  total_count: number;
  successful_count: number;
  skipped_count: number;
  failed_count: number;
  created_at: string;
  row_count: number;
};
type OperationItem = {
  row_number: number;
  source_member_id: string | null;
  destination_member_id: string | null;
  outcome: string;
  message: string;
};
type ImportOutcome = { row_number: number; outcome: "imported" | "skipped" | "failed"; message: string };

const PAGE_SIZE = 100;
const MAX_SELECTED_MEMBERS = 5000;
const today = () => localDateInput(new Date());
const date = (value: string) =>
  new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

function errorText(error: unknown) {
  const message = (error as { message?: string })?.message ?? "";
  if (message.includes("PLATFORM_ADMIN_REQUIRED")) return "This account is not authorized for the CEO migration center.";
  if (message.includes("DESIGNATED_SOURCE_REQUIRED")) return "Designate an active demo gym as the source before importing or transferring.";
  if (message.includes("INVALID_DESTINATION_GYM")) return "Choose an active destination gym with a workspace.";
  if (message.includes("ACTIVE_GYMS_REQUIRED")) return "The source and destination gyms must both be active.";
  if (message.includes("SUBSCRIPTION_REQUIRED_MEMBER_LIMIT")) return "The 10-member free limit blocked this batch, and the database rolled it back safely. Activate Pro for the destination, refresh data, then retry the selected members. Check Migration history for any earlier batches that completed.";
  if (message.includes("WORKSPACE_CONFLICT")) return "A gym workspace changed. Refresh data and try again.";
  if (message.includes("MIGRATION_OPERATION_MISMATCH")) return "This operation ID is already attached to a different migration. Start a new operation.";
  if (message.includes("GYM_NAME_CONFIRMATION_MISMATCH")) return "The gym name confirmation did not match.";
  if (message.includes("ACTIVE_SOURCE_GYM_REQUIRED")) return "Choose an active gym with a workspace as the migration source.";
  if (message.includes("DESTINATION_WORKSPACE_NOT_FOUND")) return "The destination gym does not have a workspace yet.";
  if (message.includes("MIGRATION_OPERATION_IN_PROGRESS")) return "Wait for the in-progress operation to finish before changing the source gym.";
  return "The request failed safely. No partially committed transfer was reported as successful. Check the connection and retry.";
}

function downloadTemplate() {
  const fields = MIGRATION_FIELDS;
  const rows = [fields.map((field) => FIELD_LABELS[field]), ["", "", "", "", "", "", "", ""]];
  const blob = new Blob([csvText(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "basic-gym-member-import-template.csv";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const emptyDraft = (): MigrationDraft => ({
  name: "", email: "", phone: "", gender: "male", dob: "", address: "", emergencyContact: "", joinDate: today(),
});

export function PlatformMemberMigration() {
  const { revision } = usePlatformLiveUpdates();
  const [gyms, setGyms] = useState<GymOption[]>([]);
  const [sourceChoice, setSourceChoice] = useState("");
  const [destinationId, setDestinationId] = useState("");
  const [context, setContext] = useState<MigrationContext | null>(null);
  const [members, setMembers] = useState<RemoteMigrationMember[]>([]);
  const [memberPage, setMemberPage] = useState(1);
  const [memberSearch, setMemberSearch] = useState("");
  const [memberCount, setMemberCount] = useState(0);
  const [membersLoading, setMembersLoading] = useState(true);
  const [memberLoadError, setMemberLoadError] = useState<string | null>(null);
  const [selectedMembers, setSelectedMembers] = useState<Set<string>>(new Set());
  const [selectedMemberDetails, setSelectedMemberDetails] = useState<Record<string, RemoteMigrationMember>>({});
  const [duplicateOverrides, setDuplicateOverrides] = useState<Set<string>>(new Set());
  const [movePayments, setMovePayments] = useState(true);
  const [history, setHistory] = useState<MigrationHistory[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyItems, setHistoryItems] = useState<OperationItem[]>([]);
  const [historyDetail, setHistoryDetail] = useState<MigrationHistory | null>(null);
  const [sourceConfirm, setSourceConfirm] = useState<GymOption | null>(null);
  const [sourceConfirmName, setSourceConfirmName] = useState("");
  const [transferConfirm, setTransferConfirm] = useState(false);
  const [transferConfirmName, setTransferConfirmName] = useState("");
  const [manual, setManual] = useState<MigrationDraft>(emptyDraft());
  const [queue, setQueue] = useState<MigrationRow[]>([]);
  const [editingRow, setEditingRow] = useState<MigrationRow | null>(null);
  const [editingDraft, setEditingDraft] = useState<MigrationDraft>(emptyDraft());
  const [fileHeaders, setFileHeaders] = useState<string[]>([]);
  const [fileRows, setFileRows] = useState<string[][]>([]);
  const [fileQueueStart, setFileQueueStart] = useState(1);
  const [columnMapping, setColumnMapping] = useState<Record<MigrationField, number | ""> | null>(null);
  const [manualErrors, setManualErrors] = useState<Partial<Record<MigrationField, string>>>({});
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const sourceContactsCache = useRef<{ gymId: string; contacts: MemberLite[] } | null>(null);
  const sourceContactsRequest = useRef<{ gymId: string; promise: Promise<MemberLite[]> } | null>(null);
  const memberRequestId = useRef(0);

  const sourceGym = useMemo(() => gyms.find((gym) => gym.is_source) ?? null, [gyms]);
  const destinations = useMemo(
    () => gyms.filter((gym) => gym.has_workspace && gym.account_status === "active" && gym.gym_id !== sourceGym?.gym_id),
    [gyms, sourceGym],
  );

  const loadGyms = useCallback(async () => {
    const { data, error } = await supabase.rpc("platform_list_member_migration_gyms");
    if (error) throw error;
    const result = (data ?? []) as GymOption[];
    setGyms(result);
    const designated = result.find((gym) => gym.is_source);
    if (designated) setSourceChoice(designated.gym_id);
    setDestinationId((current) =>
      result.some((gym) => gym.gym_id === current && gym.is_source === false && gym.account_status === "active")
        ? current
        : (result.find((gym) => gym.has_workspace && gym.account_status === "active" && gym.gym_id !== designated?.gym_id)?.gym_id ?? ""),
    );
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const { data, error } = await supabase.rpc("platform_list_member_migration_history", { p_page: 1, p_page_size: 25 });
      if (error) throw error;
      setHistory(data ?? []);
    } catch (error) {
      setHistoryError(errorText(error));
      throw error;
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const refreshBase = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([loadGyms(), loadHistory()]);
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setLoading(false);
    }
  }, [loadGyms, loadHistory]);

  useEffect(() => void refreshBase(), [refreshBase, revision]);

  const loadContext = useCallback(async () => {
    if (!sourceGym || !destinationId) {
      setContext(null);
      setMembers([]);
      setSelectedMembers(new Set());
      setSelectedMemberDetails({});
      return;
    }
    const { data, error } = await supabase.rpc("platform_get_member_migration_context", {
      p_source_gym_id: sourceGym.gym_id,
      p_destination_gym_id: destinationId,
    });
    if (error) throw error;
    const result = data as unknown as MigrationContext;
    setContext(result);
  }, [destinationId, sourceGym]);

  const loadMembers = useCallback(async () => {
    const requestId = ++memberRequestId.current;
    if (!sourceGym) {
      setMembers([]);
      setMemberCount(0);
      setMemberLoadError(null);
      setMembersLoading(false);
      return;
    }
    setMembersLoading(true);
    setMemberLoadError(null);
    try {
      const { data, error } = await supabase.rpc("platform_list_member_migration_members", {
        p_source_gym_id: sourceGym.gym_id,
        p_destination_gym_id: destinationId || null,
        p_search: memberSearch,
        p_page: memberPage,
        p_page_size: PAGE_SIZE,
      });
      if (error) throw error;
      if (requestId !== memberRequestId.current) return;
      const result = (data ?? []) as RemoteMigrationMember[];
      setMembers(result);
      setMemberCount(Number(result[0]?.total_count ?? 0));
    } catch (error) {
      if (requestId !== memberRequestId.current) return;
      setMemberLoadError(errorText(error));
      throw error;
    } finally {
      if (requestId === memberRequestId.current) setMembersLoading(false);
    }
  }, [destinationId, memberPage, memberSearch, sourceGym]);

  useEffect(() => {
    void loadContext().catch((error) => toast.error(errorText(error)));
    void loadMembers().catch((error) => toast.error(errorText(error)));
  }, [loadContext, loadMembers, revision]);

  const loadAllSourceContacts = useCallback(async (gymId: string) => {
    const cached = sourceContactsCache.current;
    if (cached?.gymId === gymId) return cached.contacts;
    const pending = sourceContactsRequest.current;
    if (pending?.gymId === gymId) return pending.promise;

    const request = (async () => {
      const contacts: MemberLite[] = [];
      let page = 1;
      let expected = 0;
      do {
        const { data, error } = await supabase.rpc("platform_list_member_migration_members", {
          p_source_gym_id: gymId, p_destination_gym_id: null, p_search: "", p_page: page, p_page_size: PAGE_SIZE,
        });
        if (error) throw error;
        const result = (data ?? []) as RemoteMigrationMember[];
        expected = Number(result[0]?.total_count ?? 0);
        if (result.length === 0 && contacts.length < expected) {
          throw new Error("The source roster changed while it was being loaded. Refresh data and try again.");
        }
        contacts.push(...result.map((row) => row.member));
        page += 1;
      } while (contacts.length < expected && page <= 1000);

      if (contacts.length < expected) {
        throw new Error("The source roster is too large for an in-browser duplicate preview. Server-side duplicate checks will still protect the import; please split the file and contact support for a large-source review.");
      }
      sourceContactsCache.current = { gymId, contacts };
      return contacts;
    })();
    sourceContactsRequest.current = { gymId, promise: request };
    try {
      return await request;
    } finally {
      if (sourceContactsRequest.current?.promise === request) sourceContactsRequest.current = null;
    }
  }, []);

  const queueFile = async (file: File) => {
    if (!sourceGym) return toast.error("Choose and designate the demo/source gym before preparing import rows.");
    setBusy(true);
    setProgress("Reading and validating the file…");
    try {
      const parsed = await readMigrationFile(file);
      const mapping = suggestedColumnMapping(parsed.headers);
      const existing = await loadAllSourceContacts(sourceGym.gym_id);
      const queued = queue.map((row) => ({ email: row.draft.email, phone: row.draft.phone }));
      const prepared = findPossibleDuplicates(mapMigrationRows(parsed.headers, parsed.rows, mapping), [...existing, ...queued]);
      setFileHeaders(parsed.headers);
      setFileRows(parsed.rows);
      setColumnMapping(mapping);
      const start = queue.reduce((max, row) => Math.max(max, row.rowNumber), 1) + 1;
      setFileQueueStart(start);
      setQueue((current) => [...current, ...prepared.map((row, index) => ({ ...row, rowNumber: start + index, origin: "file" as const }))]);
      toast.success(`${prepared.length.toLocaleString()} rows prepared. Review validation and possible duplicates before importing.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The file could not be read.");
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  const remapFile = (field: MigrationField, value: string) => {
    if (!columnMapping || !sourceGym) return;
    const updated = { ...columnMapping, [field]: value === "" ? "" : Number(value) };
    setColumnMapping(updated);
    void loadAllSourceContacts(sourceGym.gym_id).then((existing) => {
      const end = fileQueueStart + fileRows.length;
      const nonFileRows = queue.filter((row) => row.origin !== "file" || row.rowNumber < fileQueueStart || row.rowNumber >= end);
      const queued = nonFileRows.map((row) => ({ email: row.draft.email, phone: row.draft.phone }));
      const mapped = findPossibleDuplicates(mapMigrationRows(fileHeaders, fileRows, updated), [...existing, ...queued]);
      setQueue((current) => [...current.filter((row) => row.rowNumber < fileQueueStart || row.rowNumber >= end), ...mapped.map((row, index) => ({
        ...row,
        rowNumber: fileQueueStart + index,
        origin: "file" as const,
      }))]);
    }).catch((error) => toast.error(errorText(error)));
  };

  const addManual = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!sourceGym) return toast.error("Choose and designate the demo/source gym first.");
    const validated = normalizeAndValidateDraft(manual);
    setManualErrors(validated.errors);
    if (Object.keys(validated.errors).length) return toast.error("Review the highlighted member fields.");
    setBusy(true);
    try {
      const existing = await loadAllSourceContacts(sourceGym.gym_id);
      const queued = queue.map((entry) => ({ email: entry.draft.email, phone: entry.draft.phone }));
      const row = findPossibleDuplicates([{
        rowNumber: 1, draft: validated.draft, errors: {}, duplicate: false, allowDuplicate: false, origin: "manual",
      }], [...existing, ...queued])[0];
      setQueue((current) => [...current, { ...row, rowNumber: current.reduce((max, item) => Math.max(max, item.rowNumber), 0) + 1 }]);
      setManual(emptyDraft());
      setManualErrors({});
      toast.success(row.duplicate ? "Member added to review with a possible-duplicate warning." : "Member added to the import review queue.");
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const editQueueRow = (row: MigrationRow) => {
    if (row.serverOutcome === "unknown") {
      toast.warning("Check migration history before editing or retrying a row with an unknown server result.");
      return;
    }
    setEditingRow(row);
    setEditingDraft({ ...row.draft });
  };

  const saveEditedRow = async () => {
    if (!editingRow || !sourceGym) return;
    const validated = normalizeAndValidateDraft(editingDraft);
    setBusy(true);
    try {
      const existing = await loadAllSourceContacts(sourceGym.gym_id);
      const queued = queue.filter((row) => row.rowNumber !== editingRow.rowNumber).map((row) => ({ email: row.draft.email, phone: row.draft.phone }));
      const duplicateCheck = findPossibleDuplicates([{
        ...editingRow, draft: validated.draft, errors: validated.errors, duplicate: false,
        allowDuplicate: false, serverOutcome: undefined, serverMessage: undefined,
      }], [...existing, ...queued])[0];
      setQueue((current) => current.map((row) => row.rowNumber === editingRow.rowNumber ? duplicateCheck : row));
      setEditingRow(null);
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const importSelected = async () => {
    if (!sourceGym) return toast.error("Designate a demo/source gym before importing.");
    const ready = queue.filter((row) => Object.keys(row.errors).length === 0 && !row.serverOutcome && (!row.duplicate || row.allowDuplicate));
    if (ready.length === 0) return toast.error("No valid rows are ready. Fix errors or explicitly approve duplicate rows.");
    const operationId = crypto.randomUUID();
    setBusy(true);
    setProgress(`Importing 0 of ${ready.length.toLocaleString()}…`);
    try {
      let finalResult: Record<string, unknown> = {};
      for (let offset = 0; offset < ready.length; offset += PAGE_SIZE) {
        const batch = ready.slice(offset, offset + PAGE_SIZE);
      const { data, error } = await supabase.rpc("platform_import_migration_members", {
          p_operation_id: operationId,
          p_source_gym_id: sourceGym.gym_id,
          p_rows: batch.map((row) => ({
            rowNumber: row.rowNumber,
            allowDuplicate: row.allowDuplicate,
            member: row.draft,
          })),
          p_final: offset + PAGE_SIZE >= ready.length,
        });
        if (error) throw error;
        finalResult = data as unknown as Record<string, unknown>;
        setProgress(`Imported ${Math.min(offset + batch.length, ready.length).toLocaleString()} of ${ready.length.toLocaleString()}…`);
      }
      const outcomes = Array.isArray(finalResult.results) ? finalResult.results as ImportOutcome[] : [];
      const outcomeByRow = new Map(outcomes.map((outcome) => [outcome.row_number, outcome]));
      const submittedRows = new Set(ready.map((row) => row.rowNumber));
      const remainingQueue = queue.flatMap((row) => {
        if (!submittedRows.has(row.rowNumber)) return [row];
        const outcome = outcomeByRow.get(row.rowNumber);
        if (outcome?.outcome === "imported") return [];
        if (!outcome) return [{ ...row, serverOutcome: "unknown" as const, serverMessage: "The server did not return a row result. Check migration history before retrying." }];
        const duplicate = outcome.outcome === "skipped" && /duplicate/i.test(outcome.message);
        return [{
          ...row,
          duplicate: row.duplicate || duplicate,
          allowDuplicate: duplicate ? false : row.allowDuplicate,
          serverOutcome: outcome.outcome,
          serverMessage: outcome.message,
        }];
      });
      setQueue(remainingQueue);
      if (!remainingQueue.some((row) => row.origin === "file")) {
        setFileHeaders([]);
        setFileRows([]);
        setColumnMapping(null);
      }
      await Promise.all([loadHistory(), loadMembers(), loadGyms()]);
      const imported = Number(finalResult.imported ?? 0);
      const skipped = Number(finalResult.skipped ?? 0);
      const failed = Number(finalResult.failed ?? 0);
      const resultMessage = `Import recorded: ${imported} prepared, ${skipped} skipped, ${failed} failed. See migration history for row details.`;
      if (skipped || failed || finalResult.status !== "completed") toast.warning(resultMessage);
      else toast.success(resultMessage);
    } catch (error) {
      const { error: finalizeError } = await supabase.rpc("platform_finalize_member_migration", { p_operation_id: operationId });
      const { data: itemData, error: itemError } = await supabase.rpc("platform_list_member_migration_items", { p_operation_id: operationId });
      const submittedRows = new Set(ready.map((row) => row.rowNumber));
      if (!itemError) {
        const outcomes = (itemData ?? []) as ImportOutcome[];
        const outcomeByRow = new Map(outcomes.map((outcome) => [outcome.row_number, outcome]));
        setQueue((current) => current.flatMap((row) => {
          if (!submittedRows.has(row.rowNumber)) return [row];
          const outcome = outcomeByRow.get(row.rowNumber);
          if (outcome?.outcome === "imported") return [];
          if (!outcome) return [row];
          const duplicate = outcome.outcome === "skipped" && /duplicate/i.test(outcome.message);
          return [{
            ...row,
            duplicate: row.duplicate || duplicate,
            allowDuplicate: duplicate ? false : row.allowDuplicate,
            serverOutcome: outcome.outcome,
            serverMessage: outcome.message,
          }];
        }));
      } else if (!/MIGRATION_OPERATION_NOT_FOUND/.test(`${itemError.message} ${finalizeError?.message ?? ""}`)) {
        setQueue((current) => current.map((row) => submittedRows.has(row.rowNumber)
          ? { ...row, serverOutcome: "unknown", serverMessage: "The server result could not be checked. Open migration history before retrying or remove this row." }
          : row));
      }
      toast.error(errorText(error));
      await Promise.all([loadHistory(), loadMembers()]);
    } finally {
      // Imports may have committed even when a later batch or history refresh failed.
      // Force the next preview to reload contacts so duplicate hints cannot go stale.
      sourceContactsCache.current = null;
      setBusy(false);
      setProgress("");
    }
  };

  const toggleMember = (row: RemoteMigrationMember, checked: boolean) => {
    const id = row.member.id;
    if (checked && !selectedMembers.has(id) && selectedMembers.size >= MAX_SELECTED_MEMBERS) {
      toast.error(`Select no more than ${MAX_SELECTED_MEMBERS.toLocaleString()} members per transfer.`);
      return;
    }
    setSelectedMembers((current) => {
      const next = new Set(current);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
    setSelectedMemberDetails((current) => {
      const next = { ...current };
      if (checked) next[id] = row; else delete next[id];
      return next;
    });
  };

  const transferSummary = useMemo(
    () => summarizeTransferSelection(selectedMembers, selectedMemberDetails),
    [selectedMemberDetails, selectedMembers],
  );

  const runTransfer = async () => {
    if (!context || selectedMembers.size === 0) return;
    if (selectedMembers.size > MAX_SELECTED_MEMBERS) return toast.error(`Select no more than ${MAX_SELECTED_MEMBERS.toLocaleString()} members per transfer.`);
    const ids = Array.from(selectedMembers);
    const operationId = crypto.randomUUID();
    setBusy(true);
    setProgress(`Transferring 0 of ${ids.length.toLocaleString()}…`);
    try {
      let finalResult: Record<string, unknown> = {};
      for (let offset = 0; offset < ids.length; offset += PAGE_SIZE) {
        const batch = ids.slice(offset, offset + PAGE_SIZE);
        const { data, error } = await supabase.rpc("platform_transfer_members", {
          p_operation_id: operationId,
          p_source_gym_id: context.source.gym_id,
          p_destination_gym_id: context.destination.gym_id,
          p_member_ids: batch,
          p_row_offset: offset,
          p_all_member_ids: ids,
          p_plan_mapping: {},
          p_transfer_active_payments: movePayments,
          p_override_duplicates: Array.from(duplicateOverrides).filter((id) => selectedMembers.has(id)),
          p_final: offset + PAGE_SIZE >= ids.length,
        });
        if (error) throw error;
        finalResult = data as unknown as Record<string, unknown>;
        setProgress(`Transferred ${Math.min(offset + batch.length, ids.length).toLocaleString()} of ${ids.length.toLocaleString()}…`);
      }
      setTransferConfirm(false);
      setTransferConfirmName("");
      setSelectedMembers(new Set());
      setSelectedMemberDetails({});
      setDuplicateOverrides(new Set());
      await Promise.all([loadMembers(), loadContext(), loadHistory(), loadGyms()]);
      const { data: detailData, error: detailError } = await supabase.rpc("platform_list_member_migration_items", {
        p_operation_id: operationId,
      });
      const transferred = Number(finalResult.transferred ?? 0);
      const skipped = Number(finalResult.skipped ?? 0);
      const failed = Number(finalResult.failed ?? 0);
      const notice = transferResultNotice({
        transferred,
        skipped,
        failed,
        results: !detailError && Array.isArray(detailData)
          ? detailData as OperationItem[]
          : Array.isArray(finalResult.results) ? finalResult.results as OperationItem[] : [],
      });
      if (notice.tone === "warning" || finalResult.status !== "completed") toast.warning(notice.message);
      else toast.success(notice.message);
    } catch (error) {
      const { error: finalizeError } = await supabase.rpc("platform_finalize_member_migration", { p_operation_id: operationId });
      const { data: itemData, error: itemError } = await supabase.rpc("platform_list_member_migration_items", { p_operation_id: operationId });
      const outcomes = itemError ? [] : (itemData ?? []) as OperationItem[];
      const retryIds = membersPendingTransferRetry(ids, outcomes);
      const retrySet = new Set(retryIds);
      setSelectedMembers(retrySet);
      setSelectedMemberDetails((current) => Object.fromEntries(
        Object.entries(current).filter(([id]) => retrySet.has(id)),
      ));
      setDuplicateOverrides((current) => new Set(Array.from(current).filter((id) => retrySet.has(id))));
      const transferred = outcomes.filter((item) => item.outcome === "transferred").length;
      const resultNote = transferred > 0
        ? ` ${transferred} earlier batch member${transferred === 1 ? " was" : "s were"} confirmed transferred and removed from the retry selection; ${retryIds.length} remain selected.`
        : " The selection was kept so you can retry after resolving the issue. If the connection failed mid-transfer, check Migration history first.";
      const recoveryError = itemError && !/MIGRATION_OPERATION_NOT_FOUND/.test(`${itemError.message} ${finalizeError?.message ?? ""}`)
        ? " The server outcome could not be fully loaded; review Migration history before retrying."
        : "";
      toast.error(`${errorText(error)}${resultNote}${recoveryError}`);
      await Promise.allSettled([loadMembers(), loadHistory(), loadGyms(), loadContext()]);
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  const designateSource = async () => {
    if (!sourceConfirm) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc("platform_set_member_migration_source", {
        p_gym_id: sourceConfirm.gym_id,
        p_confirm_gym_name: sourceConfirmName,
      });
      if (error) throw error;
      setSourceConfirm(null);
      setSourceConfirmName("");
      sourceContactsCache.current = null;
      setDestinationId("");
      setContext(null);
      setQueue([]);
      setFileHeaders([]);
      setFileRows([]);
      setFileQueueStart(1);
      setColumnMapping(null);
      setManual(emptyDraft());
      setManualErrors({});
      setEditingRow(null);
      setSelectedMembers(new Set());
      setSelectedMemberDetails({});
      setDuplicateOverrides(new Set());
      setMovePayments(true);
      await Promise.all([loadGyms(), loadMembers(), loadHistory()]);
      toast.success(`${sourceConfirm.gym_name} is now the designated member-import source.`);
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const showHistoryItems = async (item: MigrationHistory) => {
    setHistoryDetail(item);
    setHistoryItems([]);
    const { data, error } = await supabase.rpc("platform_list_member_migration_items", { p_operation_id: item.operation_id });
    if (error) return toast.error(errorText(error));
    setHistoryItems((data ?? []) as OperationItem[]);
  };

  const validRows = queue.filter((row) => Object.keys(row.errors).length === 0);
  const importReadyCount = validRows.filter((row) => !row.duplicate || row.allowDuplicate).length;
  const incomingSelectedCount = Array.from(selectedMembers).filter((id) =>
    !selectedMemberDetails[id]?.possible_duplicate || duplicateOverrides.has(id),
  ).length;
  const remainingFreeSlots = context?.destination.remaining_free_slots;
  const destinationNotice = context?.destination
    ? destinationCapacityNotice(context.destination)
    : null;
  const historyViewState = migrationHistoryViewState({
    loading: historyLoading,
    error: Boolean(historyError),
    hasRows: history.length > 0,
  });
  const exceedsFreeCapacity = context?.destination.has_pro === false && remainingFreeSlots !== null &&
    remainingFreeSlots !== undefined && incomingSelectedCount > remainingFreeSlots;
  const totalPages = Math.max(1, Math.ceil(memberCount / PAGE_SIZE));
  const rosterViewState = migrationRosterViewState({
    loading: membersLoading,
    error: Boolean(memberLoadError),
    hasRows: members.length > 0,
  });
  const selectPage = (checked: boolean) => {
    const eligible = members.filter((row) => !row.possible_duplicate || duplicateOverrides.has(row.member.id));
    const ids = eligible.map((row) => row.member.id);
    const additional = ids.filter((id) => !selectedMembers.has(id)).length;
    if (checked && selectedMembers.size + additional > MAX_SELECTED_MEMBERS) {
      toast.error(`This selection would exceed the ${MAX_SELECTED_MEMBERS.toLocaleString()}-member transfer limit. Clear some selections first.`);
      return;
    }
    setSelectedMembers((current) => {
      const next = new Set(current);
      ids.forEach((id) => checked ? next.add(id) : next.delete(id));
      return next;
    });
    setSelectedMemberDetails((current) => {
      const next = { ...current };
      for (const row of eligible) {
        if (checked) next[row.member.id] = row;
        else delete next[row.member.id];
      }
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Member Migration Center"
        subtitle="Stage member records in the designated demo gym, review them, then transfer profiles and membership history into an active gym workspace."
        actions={<Button variant="secondary" onClick={() => void refreshBase()} disabled={busy || loading}>
          {loading ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />} Refresh
        </Button>}
      />

      <Alert className="border-gold/30 bg-gold/5">
        <ShieldCheck className="h-4 w-4 text-gold" />
        <AlertTitle>Protected, gym-scoped migration</AlertTitle>
        <AlertDescription>
          Transfers run through CEO-authorized database operations. Member profiles, the source plan catalog, and every membership term move together;
          matching plans are reused and missing plans are copied with their original settings. The source profile is kept in Trash for recovery.
          Membership payment records move when selected below; product sales, other gym-wide financial history, and private photos stay with the source.
        </AlertDescription>
      </Alert>

      <Panel title="Choose source and destination" description="Only one active gym can be designated as the import source. The database enforces this selection.">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="migration-source">Designated demo/source gym</Label>
            <select id="migration-source" value={sourceChoice} onChange={(event) => {
              const value = event.target.value;
              if (!value) { setSourceChoice(sourceGym?.gym_id ?? ""); return; }
              setSourceChoice(value);
              if (value !== sourceGym?.gym_id) {
                const selected = gyms.find((gym) => gym.gym_id === value);
                if (selected) { setSourceConfirmName(""); setSourceConfirm(selected); }
              }
            }} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">Select a gym</option>
              {gyms.filter((gym) => gym.has_workspace && gym.account_status === "active").map((gym) =>
                <option key={gym.gym_id} value={gym.gym_id}>{gym.gym_name}{gym.is_source ? " · designated source" : ""} — {gym.owner_email}</option>,
              )}
            </select>
            <p className="text-xs text-muted-foreground">The source gym is used for staging and as the source of member profiles, plans, and membership history. Product sales and unrelated records are not included. Its usual 10-member free limit still applies, so a larger staging roster requires Pro.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="migration-destination">Destination gym</Label>
            <select id="migration-destination" value={destinationId} onChange={(event) => {
              setDestinationId(event.target.value); setMemberPage(1); setSelectedMembers(new Set());
              setSelectedMemberDetails({}); setDuplicateOverrides(new Set());
            }} disabled={!sourceGym} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">Select an active gym</option>
              {destinations.map((gym) => <option key={gym.gym_id} value={gym.gym_id}>{gym.gym_name} — {gym.owner_email}</option>)}
            </select>
            <p className="text-xs text-muted-foreground">Pro belongs to the gym owner’s workspace and controls roster capacity. It does not upgrade a gym member or change their membership. Manage owner Pro separately under Subscriptions &amp; codes.</p>
            {destinationNotice && <p role="status" aria-live="polite" className={`text-xs ${destinationNotice.tone === "success" ? "text-success" : "text-warning"}`}>
              {destinationNotice.message}
            </p>}
          </div>
        </div>
        {sourceGym && <p className="mt-4 inline-flex items-center gap-2 rounded-full border border-success/30 bg-success/5 px-3 py-1.5 text-sm text-success">
          <Check className="h-4 w-4" /> Source: {sourceGym.gym_name} · {sourceGym.member_count.toLocaleString()} roster records
        </p>}
        {!sourceGym && <p className="mt-4 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-warning">
          Choose the intended demo gym above and confirm its exact name to designate it. No gym is assumed automatically.
        </p>}
      </Panel>

      {sourceGym && <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Import or enter members" description="CSV or .xlsx (first worksheet) · maximum 8 MB and 5,000 records per file · no optional field is required except those enforced by the existing member form.">
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={downloadTemplate}><Download className="mr-2 h-4 w-4" /> Download CSV template</Button>
            <label className="inline-flex h-10 cursor-pointer items-center rounded-md bg-secondary px-4 text-sm font-medium hover:bg-secondary/80">
              {busy ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
              Upload CSV / Excel (.xlsx)
              <input className="sr-only" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy}
                onChange={(event) => { const file = event.target.files?.[0]; if (file) void queueFile(file); event.currentTarget.value = ""; }} />
            </label>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Excel is parsed in a browser worker; file contents are sent only after you review and choose Import.</p>
          {fileHeaders.length > 0 && columnMapping && <div className="mt-4 rounded-lg border border-border p-3">
            <p className="mb-3 flex items-center gap-2 text-sm font-medium"><FileSpreadsheet className="h-4 w-4 text-gold" /> Column mapping</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {MIGRATION_FIELDS.map((field) => <Label key={field} className="grid gap-1 text-xs text-muted-foreground">
                {FIELD_LABELS[field]}{["name", "phone", "gender", "dob"].includes(field) ? " · required" : ""}
                <select value={columnMapping[field]} onChange={(event) => remapFile(field, event.target.value)} className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground">
                  <option value="">Not provided</option>
                  {fileHeaders.map((header, index) => <option key={`${index}-${header}`} value={index}>{header}</option>)}
                </select>
              </Label>)}
            </div>
          </div>}
          {progress && <p role="status" className="mt-3 text-sm text-muted-foreground">{progress}</p>}

          <form onSubmit={(event) => void addManual(event)} className="mt-5 space-y-3 border-t border-border pt-4">
            <p className="flex items-center gap-2 text-sm font-semibold"><UserPlus className="h-4 w-4 text-gold" /> Add a member manually to the review queue</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {MIGRATION_FIELDS.map((field) => <Label key={field} className="grid gap-1 text-xs text-muted-foreground">
                {FIELD_LABELS[field]}{["name", "phone", "gender", "dob"].includes(field) ? " · required" : ""}
                {field === "gender" ? <select aria-invalid={Boolean(manualErrors[field])} value={manual[field]} onChange={(event) => { setManual((state) => ({ ...state, gender: event.target.value })); setManualErrors((state) => ({ ...state, gender: undefined })); }} className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground">
                  <option value="male">Male</option><option value="female">Female</option><option value="other">Other</option>
                </select> : <Input value={manual[field]} onChange={(event) => { setManual((state) => ({ ...state, [field]: event.target.value })); setManualErrors((state) => ({ ...state, [field]: undefined })); }}
                  type={field === "dob" || field === "joinDate" ? "date" : field === "email" ? "email" : "text"}
                  max={field === "dob" || field === "joinDate" ? today() : undefined}
                  aria-invalid={Boolean(manualErrors[field])}
                  placeholder={field === "phone" || field === "emergencyContact" ? "10-digit local number" : undefined} />}
                {manualErrors[field] && <span role="alert" className="text-xs text-destructive">{manualErrors[field]}</span>}
              </Label>)}
            </div>
            <Button type="submit" variant="secondary" disabled={busy}><UserPlus className="mr-2 h-4 w-4" /> Add to review</Button>
          </form>
        </Panel>

        <Panel title="Review import queue" description={`${queue.length.toLocaleString()} queued · ${importReadyCount.toLocaleString()} ready · invalid rows are never silently imported`}>
          {queue.length === 0 ? <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">Upload a file or enter a member to see the review preview.</p> : <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">Possible duplicates use email or phone, never names alone. Review each warning before including it. Transfers are limited to {MAX_SELECTED_MEMBERS.toLocaleString()} members per operation.</p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => setQueue((rows) => rows.filter((row) => Object.keys(row.errors).length === 0))}>Remove invalid rows</Button>
                <Button size="sm" onClick={() => void importSelected()} disabled={busy || importReadyCount === 0}><Upload className="mr-2 h-4 w-4" /> Import {importReadyCount}</Button>
              </div>
            </div>
            <div className="max-h-[28rem] overflow-auto rounded-lg border border-border">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="sticky top-0 bg-card text-xs uppercase text-muted-foreground"><tr>
                  <th className="p-2">Row</th><th className="p-2">Member</th><th className="p-2">Phone / email</th><th className="p-2">Status</th><th className="p-2">Review</th>
                </tr></thead>
                <tbody>{queue.map((row) => {
                  const errors = Object.entries(row.errors).map(([field, message]) => `${FIELD_LABELS[field as MigrationField]}: ${message}`);
                  return <tr key={row.rowNumber} className="border-t border-border align-top">
                    <td className="p-2 text-muted-foreground">{row.rowNumber}</td>
                    <td className="p-2 font-medium">{row.draft.name || "—"}<div className="text-xs text-muted-foreground">{row.draft.gender} · {row.draft.dob || "No birth date"}</div></td>
                    <td className="p-2">{row.draft.phone || "—"}<div className="text-xs text-muted-foreground">{row.draft.email || "No email"}</div></td>
                    <td className="p-2">{errors.length ? <span className="text-destructive">{errors.join("; ")}</span> : row.serverOutcome ? <span className={row.serverOutcome === "failed" ? "text-destructive" : "text-warning"}>{row.serverOutcome === "unknown" ? "Outcome unknown" : `Server ${row.serverOutcome}`}: {row.serverMessage}</span> : row.duplicate ? <span className="text-warning">Possible duplicate{row.allowDuplicate ? " · approved" : " · skipped unless approved"}</span> : <span className="text-success">Ready</span>}</td>
                    <td className="p-2"><div className="flex gap-1">
                      <Button size="icon" variant="ghost" aria-label={`Edit row ${row.rowNumber}`} onClick={() => editQueueRow(row)}><Pencil className="h-4 w-4" /></Button>
                      {row.serverOutcome && row.serverOutcome !== "unknown" && <Button size="sm" variant="secondary" onClick={() => setQueue((rows) => rows.map((entry) => entry.rowNumber === row.rowNumber ? { ...entry, serverOutcome: undefined, serverMessage: undefined, allowDuplicate: false } : entry))}>Review & retry</Button>}
                      {row.duplicate && <Button size="sm" variant={row.allowDuplicate ? "default" : "secondary"} onClick={() => setQueue((rows) => rows.map((entry) => entry.rowNumber === row.rowNumber ? { ...entry, allowDuplicate: !entry.allowDuplicate } : entry))}>{row.allowDuplicate ? "Approved" : "Allow duplicate"}</Button>}
                      <Button size="icon" variant="ghost" aria-label={`Remove row ${row.rowNumber}`} onClick={() => setQueue((rows) => rows.filter((entry) => entry.rowNumber !== row.rowNumber))}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                    </div></td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
          </>}
        </Panel>
      </div>}

      {exceedsFreeCapacity && <Alert className="border-warning/40 bg-warning/5">
        <AlertTriangle className="h-4 w-4 text-warning" />
        <AlertTitle>Selected transfer exceeds the free-plan capacity</AlertTitle>
        <AlertDescription>
          {incomingSelectedCount} selected member{incomingSelectedCount === 1 ? "" : "s"} may be added, but only {remainingFreeSlots} free slot{remainingFreeSlots === 1 ? " is" : "s are"} left in this destination. Activate Pro in Subscriptions &amp; codes or reduce the selection before migrating. The database will reject an over-limit transfer atomically; it will not partially move this batch.
        </AlertDescription>
      </Alert>}

      {sourceGym && destinationId && context && <Panel title="Select and transfer members" description="The destination receives new member and membership IDs. Source membership records and payments are moved according to the payment option in the final confirmation; the source profile is retained in Trash.">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gold/25 bg-gold/5 p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
            <span>{context.source.gym_name}</span><MoveRight className="h-4 w-4 text-gold" /><span>{context.destination.gym_name}</span>
          </div>
          <div className="flex items-center gap-2">
            <Input className="w-64" placeholder="Search source members" value={memberSearch} onChange={(event) => { setMemberSearch(event.target.value); setMemberPage(1); }} />
            <Button variant="secondary" size="icon" onClick={() => void loadMembers().catch((error) => toast.error(errorText(error)))} disabled={busy || membersLoading} aria-label="Refresh source members"><RefreshCw className="h-4 w-4" /></Button>
          </div>
        </div>
        <Alert className="mb-4 border-success/30 bg-success/5">
          <ShieldCheck className="h-4 w-4 text-success" />
          <AlertTitle>Membership history transfers with the member</AlertTitle>
          <AlertDescription>
            {context.source_plans.length.toLocaleString()} source plan(s) will be matched or copied automatically. All selected members’ membership terms retain their dates, status, and price snapshots; no manual plan mapping is required.
          </AlertDescription>
        </Alert>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Users className="h-4 w-4" /> {membersLoading ? "Loading source members…" : `${memberCount.toLocaleString()} source members`} · {selectedMembers.size} selected</div>
              <div className="flex gap-2"><Button variant="secondary" size="sm" onClick={() => selectPage(true)} disabled={busy || membersLoading || members.length === 0}>Select eligible on page</Button><Button variant="ghost" size="sm" onClick={() => { setSelectedMembers(new Set()); setSelectedMemberDetails({}); setDuplicateOverrides(new Set()); }}>Clear selection</Button>
            <Button onClick={() => { setTransferConfirmName(""); setTransferConfirm(true); }} disabled={busy || membersLoading || selectedMembers.size === 0}>Review transfer</Button>
          </div>
        </div>
        {rosterViewState === "loading" ? <div role="status" className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground"><LoaderCircle className="h-4 w-4 animate-spin" /> Loading source members…</div>
          : rosterViewState === "error" ? <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-center text-sm text-muted-foreground">{memberLoadError} Use Refresh source members to try again.</p>
            : rosterViewState === "empty" ? <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No members match this search in the designated source gym.</p> : <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="bg-secondary/20 text-xs uppercase text-muted-foreground"><tr>
              <th className="p-3"><input aria-label="Select all eligible members on this page" type="checkbox" onChange={(event) => selectPage(event.target.checked)} /></th><th className="p-3">Member</th><th className="p-3">Phone / email</th><th className="p-3">Membership history</th><th className="p-3">Duplicate check</th>
            </tr></thead>
            <tbody>{members.map((row) => {
              const id = row.member.id;
              const canSelect = !row.possible_duplicate || duplicateOverrides.has(id);
              return <tr key={id} className="border-t border-border">
                <td className="p-3"><input aria-label={`Select ${row.member.name}`} type="checkbox" checked={selectedMembers.has(id)} disabled={!canSelect} onChange={(event) => toggleMember(row, event.target.checked)} /></td>
                <td className="p-3 font-medium">{row.member.name}</td>
                <td className="p-3">{row.member.phone || "—"}<div className="text-xs text-muted-foreground">{row.member.email || "No email"}</div></td>
                <td className="p-3">{row.current_membership ? <>
                  <span className={row.current_membership.active ? "text-success" : "text-muted-foreground"}>
                    {row.current_membership.membership_count ?? 1} term(s) · {row.current_membership.plan_name ?? "Plan"}
                  </span>
                  <div className="text-xs text-muted-foreground">Latest ends {row.current_membership.end_date.slice(0, 10)}{row.current_membership.frozen ? " · frozen" : ""}</div>
                </> : <span className="text-muted-foreground">No membership history</span>}</td>
                <td className="p-3">{row.possible_duplicate ? <div className="flex flex-wrap items-center gap-2 text-warning"><AlertTriangle className="h-4 w-4" /> Possible contact match
                    <Button size="sm" variant={duplicateOverrides.has(id) ? "default" : "secondary"} onClick={() => {
                      const approved = duplicateOverrides.has(id);
                      setDuplicateOverrides((current) => {
                        const next = new Set(current); if (approved) next.delete(id); else next.add(id); return next;
                      });
                      if (approved) {
                        setSelectedMembers((current) => { const next = new Set(current); next.delete(id); return next; });
                        setSelectedMemberDetails((current) => { const next = { ...current }; delete next[id]; return next; });
                      }
                  }}>{duplicateOverrides.has(id) ? "Approved" : "Allow"}</Button>
                </div> : <span className="text-success">No match found</span>}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>}
        <div className="mt-3 flex items-center justify-between">
          <Button variant="secondary" size="sm" disabled={memberPage <= 1} onClick={() => setMemberPage((page) => Math.max(1, page - 1))}>Previous</Button>
          <p className="text-xs text-muted-foreground">Page {memberPage} of {totalPages}</p>
          <Button variant="secondary" size="sm" disabled={memberPage >= totalPages} onClick={() => setMemberPage((page) => Math.min(totalPages, page + 1))}>Next</Button>
        </div>
      </Panel>}

      <Panel title="Migration history" description="Confirmed database results only. Details include per-row outcomes without storing the imported personal records in audit metadata.">
        {historyViewState === "loading" ? <p role="status" className="text-sm text-muted-foreground">Loading migration history…</p>
          : historyViewState === "error" ? <Alert variant="destructive"><AlertTitle>Migration history couldn’t be loaded</AlertTitle><AlertDescription>{historyError} Use Refresh data to try again.</AlertDescription></Alert>
          : historyViewState === "empty" ? <p className="text-sm text-muted-foreground">No imports or transfers have been recorded yet.</p> : <div className="overflow-x-auto">
          <table className="w-full min-w-[800px] text-left text-sm"><thead className="text-xs uppercase text-muted-foreground"><tr>
            <th className="py-2 pr-3">Operation</th><th className="py-2 pr-3">Source → destination</th><th className="py-2 pr-3">Administrator / time</th><th className="py-2 pr-3">Result</th><th className="py-2">Details</th>
          </tr></thead><tbody>{history.map((item) => <tr key={item.operation_id} className="border-t border-border">
            <td className="py-3 pr-3 capitalize">{item.operation_type}</td><td className="py-3 pr-3">{item.source_gym_name ?? "Removed gym"}{item.operation_type === "transfer" ? ` → ${item.destination_gym_name ?? "Removed gym"}` : " · staging"}</td>
            <td className="py-3 pr-3">{item.admin_email}<div className="text-xs text-muted-foreground">{date(item.created_at)}</div></td>
            <td className="py-3 pr-3"><span className={item.status === "completed" ? "text-success" : item.status === "failed" ? "text-destructive" : "text-warning"}>{item.status}</span><div className="text-xs text-muted-foreground">{item.successful_count} ok · {item.skipped_count} skipped · {item.failed_count} failed</div></td>
            <td className="py-3"><Button size="sm" variant="secondary" onClick={() => void showHistoryItems(item)}>View rows</Button></td>
          </tr>)}</tbody></table>
        </div>}
      </Panel>

      {progress && <div role="status" className="fixed bottom-4 right-4 z-40 rounded-lg border border-border bg-card px-4 py-3 text-sm shadow-xl">{progress}</div>}

      <AlertDialog open={Boolean(sourceConfirm)} onOpenChange={(open) => { if (!open) { setSourceConfirm(null); setSourceChoice(sourceGym?.gym_id ?? ""); } }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Designate migration source?</AlertDialogTitle><AlertDialogDescription>
            This makes <strong>{sourceConfirm?.gym_name}</strong> the single staging gym for CEO imports. The previous designation will be replaced. No member data changes in this step.
          </AlertDialogDescription></AlertDialogHeader>
          <Label className="grid gap-2">Type the gym name to confirm<Input value={sourceConfirmName} onChange={(event) => setSourceConfirmName(event.target.value)} /></Label>
          <AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel><AlertDialogAction disabled={busy || sourceConfirmName !== sourceConfirm?.gym_name} onClick={(event) => { event.preventDefault(); void designateSource(); }}>Designate source</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={transferConfirm} onOpenChange={(open) => { if (!open) setTransferConfirm(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Confirm member migration</AlertDialogTitle><AlertDialogDescription>
            Transfer {selectedMembers.size} selected member profile(s) from <strong>{context?.source.gym_name}</strong> to <strong>{context?.destination.gym_name}</strong>? The destination receives the full source plan catalog and every membership term with original dates, status, and price snapshots. The source profile remains in Trash for recovery. Product sales, unrelated financial history, and private photos remain at the source. This does not activate or extend the destination gym owner’s Pro subscription.
          </AlertDialogDescription></AlertDialogHeader>
          <div className="space-y-1 rounded-lg border border-border p-3 text-sm" aria-live="polite">
            <p><strong>{transferSummary.selectedCount.toLocaleString()}</strong> member profile(s) selected</p>
            <p>{transferSummary.membershipCount.toLocaleString()} membership term(s) across the selected profiles will transfer; {transferSummary.activeMembershipCount.toLocaleString()} currently active term(s) are included.</p>
            <p>{context?.source_plans.length.toLocaleString()} source plan(s) will be matched to an identical destination plan or copied automatically.</p>
            {transferSummary.profileOnlyCount > 0 && <p className="text-warning">
              {transferSummary.profileOnlyCount.toLocaleString()} profile(s) have no membership history; they will arrive without a membership. Gym-owner Pro does not grant an individual member a plan.
            </p>}
            {transferSummary.missingPreviewCount > 0 && <p role="alert" className="text-destructive">
              The preview is missing for {transferSummary.missingPreviewCount.toLocaleString()} selected profile(s). Cancel, refresh the roster, and select them again before transferring.
            </p>}
          </div>
          <Label className="grid gap-2">Type the destination gym name to confirm<Input value={transferConfirmName} onChange={(event) => setTransferConfirmName(event.target.value)} /></Label>
          {transferSummary.membershipCount > 0 && <div className="rounded-lg border border-border p-3 text-sm">
            <p className="font-medium">Membership payment records</p>
            <label className="mt-2 flex items-start gap-2"><input type="checkbox" checked={movePayments} onChange={(event) => setMovePayments(event.target.checked)} className="mt-1" /><span>Move all payment records linked to the transferred membership history, assigning new destination invoice numbers and retaining the original invoice number in each note. The original payment rows leave the source gym.</span></label>
            {!movePayments && <p className="mt-2 text-warning">The source keeps its original memberships and payment history. Membership terms are copied to the destination without payments, so their balances may show as due there.</p>}
          </div>}
          {duplicateOverrides.size > 0 && <p className="text-sm text-warning">You explicitly approved {duplicateOverrides.size} possible duplicate(s) for this operation.</p>}
          <AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel><AlertDialogAction disabled={busy || transferConfirmName !== context?.destination.gym_name || transferSummary.missingPreviewCount > 0} onClick={(event) => { event.preventDefault(); void runTransfer(); }}>
            {busy ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <ArrowRight className="mr-2 h-4 w-4" />} Confirm transfer
          </AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={Boolean(editingRow)} onOpenChange={(open) => { if (!open) setEditingRow(null); }}>
        <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
          <DialogHeader><DialogTitle>Edit import row {editingRow?.rowNumber}</DialogTitle><DialogDescription>Correct values before they are sent to the designated source gym.</DialogDescription></DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">{MIGRATION_FIELDS.map((field) => <Label key={field} className="grid gap-1 text-sm">
            {FIELD_LABELS[field]}
            {field === "gender" ? <select value={editingDraft[field]} onChange={(event) => setEditingDraft((state) => ({ ...state, gender: event.target.value }))} className="h-10 rounded-md border border-input bg-background px-3">
              <option value="male">Male</option><option value="female">Female</option><option value="other">Other</option>
            </select> : <Input value={editingDraft[field]} type={field === "dob" || field === "joinDate" ? "date" : field === "email" ? "email" : "text"}
              max={field === "dob" || field === "joinDate" ? today() : undefined}
              onChange={(event) => setEditingDraft((state) => ({ ...state, [field]: event.target.value }))} />}
          </Label>)}</div>
          <DialogFooter><Button variant="secondary" onClick={() => setEditingRow(null)}>Cancel</Button><Button onClick={() => void saveEditedRow()} disabled={busy}>Save row</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(historyDetail)} onOpenChange={(open) => { if (!open) setHistoryDetail(null); }}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader><DialogTitle>Operation results</DialogTitle><DialogDescription>{historyDetail?.operation_type} · {historyDetail?.successful_count} successful · {historyDetail?.skipped_count} skipped · {historyDetail?.failed_count} failed</DialogDescription></DialogHeader>
          {historyItems.length === 0 ? <p className="text-sm text-muted-foreground">No individual row outcomes are stored for this operation.</p> : <div className="space-y-2">
            {historyItems.map((item) => <div key={`${item.row_number}-${item.source_member_id}`} className="rounded-lg border border-border p-3 text-sm">
              <div className="flex items-center justify-between gap-2"><span>Row {item.row_number}{item.source_member_id ? ` · ${item.source_member_id.slice(0, 8)}` : ""}</span><span className="capitalize text-muted-foreground">{item.outcome}</span></div>
              <p className="mt-1 text-muted-foreground">{item.message}</p>
            </div>)}
          </div>}
          <DialogFooter><Button variant="secondary" onClick={() => setHistoryDetail(null)}>Close</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
