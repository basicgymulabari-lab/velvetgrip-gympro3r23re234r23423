import { useSyncExternalStore } from "react";
import { buildSeed, uid, iso } from "./seed";
import { configureCalendarSystem } from "./calendar";
import { phoneForCountry } from "./phone";
import { membershipEndDate } from "./membership";
import { addMoney, multiplyMoney, normalizeMoney, subtractMoney, sumMoney } from "./money";
import type {
  Activity,
  ActivityType,
  GymState,
  Member,
  Membership,
  Payment,
  PaymentMethod,
  Plan,
  Product,
  Sale,
  Expense,
  Inquiry,
  InquiryPriority,
  InquirySource,
  InquiryStatus,
  ReceptionistAccount,
  ReceptionistPermissions,
  Settings,
} from "./types";
import {
  ensureOwnerGym,
  getCloudGymContext,
  getCloudIdentity,
  loadCloudWorkspace,
  recordCloudAuditEvent,
  saveCloudWorkspace,
  signOutFromCloud,
} from "./cloud";
import { isSupabaseConfigured } from "../../integrations/supabase/client";
import { invokeEdgeFunction } from "../../integrations/supabase/functions";
import { newWorkspace } from "./new-workspace";
import { dataUrlToBlob, deletePrivateAsset, uploadPrivateAsset } from "./storage";
import {
  canAddRegularMember,
  FREE_MEMBER_LIMIT,
  getSubscriptionSnapshot,
  regularMemberCount,
} from "../billing/client";

let state: GymState | null = null;
const listeners = new Set<() => void>();
let cloudOwnerId: string | null = null;
let cloudGymId: string | null = null;
let cloudRevision: number | null = null;
let cloudSaveTimer: ReturnType<typeof setTimeout> | null = null;
let cloudSaveQueue: Promise<void> = Promise.resolve();
let cloudSyncPending = false;
let onlineSyncInstalled = false;
let currentSession: CurrentSession | null = null;
const LOCAL_DEMO_SESSION_KEY = "ironvault.local-demo-session";
const LOCAL_DEMO_STATE_KEY = "ironvault.local-demo-state";
const localDemoEnabled = () =>
  import.meta.env.DEV && import.meta.env.VITE_LOCAL_DEMO_MODE === "true";

const isBrowser = () => typeof window !== "undefined";
const normalizedPhone = (value: string) => {
  const digits = value.replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
};

function sanitizedReceptionistAccount(value: unknown): ReceptionistAccount | null {
  if (!value || typeof value !== "object") return null;
  const rest = value as ReceptionistAccount;
  if (
    typeof rest.email !== "string" ||
    typeof rest.passwordHash !== "string" ||
    typeof rest.name !== "string"
  )
    return null;
  return rest;
}

function sanitizedStaff(staff: GymState["staff"] | undefined): GymState["staff"] {
  const receptionist = sanitizedReceptionistAccount(staff?.receptionist);
  return receptionist ? { ...staff, receptionist } : {};
}

function flushCloudSave(nextState: GymState, notifyOnError = true): Promise<boolean> {
  if (!cloudOwnerId || cloudRevision === null) return Promise.resolve(true);
  const ownerId = cloudOwnerId;
  cloudSyncPending = true;
  let saved = false;
  const queuedSave = cloudSaveQueue.then(async () => {
    if (cloudOwnerId !== ownerId || cloudRevision === null) return;
    try {
      cloudRevision = await saveCloudWorkspace(nextState, cloudRevision);
      saved = true;
      if (state === nextState) cloudSyncPending = false;
    } catch (error) {
      // Never silently overwrite a newer server revision. The pending marker
      // remains set and the UI receives a safe sync-error event so the user can
      // retry/reload instead of losing concurrent edits.
      console.error("Unable to sync the gym workspace to Supabase", error);
      if (notifyOnError) {
        window.dispatchEvent(
          new CustomEvent("ironvault:cloud-sync-error", {
            detail: { message: "Your latest change could not be saved. Check your connection and retry." },
          }),
        );
      }
    }
  });
  cloudSaveQueue = queuedSave;
  return queuedSave.then(() => saved);
}

function scheduleCloudSave(nextState: GymState) {
  if (!cloudOwnerId || cloudRevision === null) return;
  const ownerId = cloudOwnerId;
  if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(() => {
    if (cloudOwnerId !== ownerId) return;
    void flushCloudSave(nextState);
  }, 500);
}

function installOnlineSync() {
  if (onlineSyncInstalled || !isBrowser() || typeof window.addEventListener !== "function") return;
  onlineSyncInstalled = true;
  window.addEventListener("online", () => {
    if (cloudOwnerId && state && cloudSyncPending) {
      scheduleCloudSave(state);
    }
  });
}

function emit() {
  listeners.forEach((l) => l());
}

function replaceState(nextState: GymState, syncCloud = true) {
  state = nextState;
  configureCalendarSystem(state.settings.calendarSystem);
  if (localDemoEnabled() && currentSession?.email === "demo@ironvault.local") {
    try {
      window.localStorage.setItem(LOCAL_DEMO_STATE_KEY, JSON.stringify(state));
    } catch (error) {
      console.warn("Could not save local demo workspace", error);
    }
  }
  if (syncCloud) scheduleCloudSave(state);
  emit();
}

function setState(updater: (s: GymState) => GymState) {
  if (!state) throw new Error("Gym workspace is not loaded.");
  replaceState(updater(state));
}

function subscribe(listener: () => void) {
  if (isBrowser()) installOnlineSync();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useGym(): GymState | null {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => null,
  );
}

export function getState(): GymState {
  if (!state) throw new Error("Gym workspace is not loaded.");
  return state;
}

/** Test-only state injection. Never call this from application code. */
export function __setStateForLogicTests(next: GymState) {
  if (typeof process === "undefined" || process.env.IRONVAULT_LOGIC_TESTS !== "1") {
    throw new Error("Test state injection is disabled.");
  }
  state = structuredClone(next);
  configureCalendarSystem(state.settings.calendarSystem);
  currentSession = null;
  cloudOwnerId = null;
  cloudGymId = null;
  cloudRevision = null;
  cloudSaveQueue = Promise.resolve();
  cloudSyncPending = false;
  emit();
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

export function logout() {
  void logoutSecurely().catch((error) => console.error("Could not complete sign out", error));
}

// Wait for pending changes and revoke the cloud session before returning to login.
export async function logoutSecurely() {
  if (cloudSaveTimer) {
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer = null;
  }
  if (cloudOwnerId && state && cloudRevision !== null) {
    await flushCloudSave(state);
    await cloudSaveQueue;
  }
  if (cloudOwnerId) {
    await recordCloudAuditEvent("logout").catch(() => undefined);
  }
  await signOutFromCloud();
  if (localDemoEnabled()) window.sessionStorage.removeItem(LOCAL_DEMO_SESSION_KEY);
  state = null;
  currentSession = null;
  cloudOwnerId = null;
  cloudGymId = null;
  cloudRevision = null;
  cloudSyncPending = false;
  cloudSaveQueue = Promise.resolve();
  emit();
}

export async function completeCloudLogin() {
  if (!isBrowser() || !isSupabaseConfigured()) return false;
  const identity = await getCloudIdentity();
  if (!identity) return false;
  if (cloudSaveTimer) {
    clearTimeout(cloudSaveTimer);
    // Navigating between pages must not discard a pending edit before reloading.
    if (cloudOwnerId === identity.id && state && cloudRevision !== null) {
      await flushCloudSave(state);
      await cloudSaveQueue;
    }
  }
  cloudSaveTimer = null;
  cloudOwnerId = identity.id;

  let context = await getCloudGymContext();
  if (!context) {
    // A confirmed user without a membership is a newly registered gym owner.
    // Tenant id is generated server-side; the browser never supplies it.
    const fresh = newWorkspace(identity.email, identity.name, identity.gymName);
    context = await ensureOwnerGym(identity.gymName, fresh);
  }
  if (!context.enabled) throw new Error("This staff account has been disabled by the gym owner.");

  const workspace = await loadCloudWorkspace();
  if (workspace?.state?.version === 1) {
    const cloudState = workspace.state;
    state = {
      ...cloudState,
      expenses: (cloudState.expenses ?? []).map((expense) => ({
        ...expense,
        locked: expense.locked !== false,
      })),
      inquiries: cloudState.inquiries ?? [],
      staff: sanitizedStaff(cloudState.staff),
    };
    cloudRevision = workspace.revision;
    cloudGymId = workspace.gymId;
    configureCalendarSystem(state.settings.calendarSystem);

    // One-time migration for legacy inline photos/receipts. Persisted cloud
    // workspaces must reference private Storage objects instead of embedding
    // member PII/documents as base64 JSON.
    if (context.role === "owner") {
      const uploadedPaths: string[] = [];
      let migrated = false;
      let saveAttempted = false;
      try {
        const members: Member[] = [];
        for (const member of state.members) {
          if (member.photo?.startsWith("data:")) {
            const path = await uploadPrivateAsset(
              "members",
              await dataUrlToBlob(member.photo),
              `${member.name}-photo`,
            );
            uploadedPaths.push(path);
            members.push({ ...member, photo: path });
            migrated = true;
          } else {
            members.push(member);
          }
        }

        const expenses: Expense[] = [];
        for (const expense of state.expenses ?? []) {
          const attachment = expense.attachment;
          if (attachment?.path && attachment.dataUrl) {
            const { dataUrl: _legacyDataUrl, ...persistedAttachment } = attachment;
            expenses.push({ ...expense, attachment: persistedAttachment });
            migrated = true;
          } else if (attachment?.dataUrl?.startsWith("data:")) {
            const path = await uploadPrivateAsset(
              "expenses",
              await dataUrlToBlob(attachment.dataUrl),
              attachment.name,
            );
            uploadedPaths.push(path);
            expenses.push({
              ...expense,
              attachment: {
                name: attachment.name,
                type: attachment.type,
                size: attachment.size,
                path,
              },
            });
            migrated = true;
          } else {
            expenses.push(expense);
          }
        }

        if (migrated) {
          const migratedState = { ...state, members, expenses };
          saveAttempted = true;
          const nextRevision = await saveCloudWorkspace(migratedState, cloudRevision);
          state = migratedState;
          cloudRevision = nextRevision;
        }
      } catch (error) {
        if (saveAttempted) {
          // A failed response can follow a successful server write. Refresh the
          // revision before allowing subsequent edits, and keep uploaded files.
          const latest = await loadCloudWorkspace().catch(() => null);
          if (latest?.state?.version === 1) {
            state = {
              ...latest.state,
              expenses: (latest.state.expenses ?? []).map((expense) => ({
                ...expense,
                locked: expense.locked !== false,
              })),
              inquiries: latest.state.inquiries ?? [],
              staff: sanitizedStaff(latest.state.staff),
            };
            cloudRevision = latest.revision;
            cloudGymId = latest.gymId;
            configureCalendarSystem(state.settings.calendarSystem);
          }
        } else {
          await Promise.all(uploadedPaths.map((path) => deletePrivateAsset(path).catch(() => undefined)));
        }
        // Legacy files remain available in the loaded workspace and migration
        // can be retried at the next sign-in. It must not prevent gym access.
        console.warn("Could not migrate legacy private files during sign-in", error);
      }
    }
  } else {
    throw new Error("Your gym workspace could not be loaded.");
  }

  cloudSyncPending = false;
  const role = context.role === "owner" ? "admin" : "receptionist";
  const permissions =
    role === "receptionist"
      ? { ...DEFAULT_RECEPTIONIST_PERMISSIONS, ...context.permissions }
      : undefined;
  currentSession = {
    email: identity.email.toLowerCase(),
    role,
    cloudUserId: identity.id,
    gymId: context.gymId,
    name: context.displayName || (role === "admin" ? identity.name : "Receptionist"),
    permissions,
  };
  await recordCloudAuditEvent("login").catch(() => undefined);
  emit();
  return true;
}

/** Start the isolated, seeded local demo account. It is available only in explicitly enabled dev mode. */
export function startLocalDemoSession() {
  if (!localDemoEnabled()) throw new Error("Local demo sign-in is disabled.");
  let demoState: GymState | null = null;
  try {
    const saved = window.localStorage.getItem(LOCAL_DEMO_STATE_KEY);
    if (saved) {
      const parsed: unknown = JSON.parse(saved);
      if (parsed && typeof parsed === "object" && (parsed as GymState).version === 1) {
        demoState = parsed as GymState;
      }
    }
  } catch {
    demoState = null;
  }
  state = demoState ?? buildSeed();
  state = {
    ...state,
    settings: { ...state.settings, gymName: "IronVault Demo Gym", adminName: "Demo Owner", email: "demo@ironvault.local" },
  };
  window.localStorage.setItem(LOCAL_DEMO_STATE_KEY, JSON.stringify(state));
  window.sessionStorage.setItem(LOCAL_DEMO_SESSION_KEY, "true");
  currentSession = { email: "demo@ironvault.local", role: "admin", name: "Demo Owner" };
  cloudOwnerId = null;
  cloudGymId = null;
  cloudRevision = null;
  configureCalendarSystem(state.settings.calendarSystem);
  emit();
}

export function isLoggedIn() {
  return currentSession !== null;
}

export async function validateCurrentSession() {
  if (!isBrowser()) return false;
  if (localDemoEnabled()) {
    if (window.sessionStorage.getItem(LOCAL_DEMO_SESSION_KEY) !== "true") return false;
    if (currentSession?.email === "demo@ironvault.local" && state) return true;
    startLocalDemoSession();
    return true;
  }
  if (!isSupabaseConfigured()) return false;
  if (!window.navigator.onLine && currentSession) {
    return Boolean(
      state &&
        cloudRevision !== null &&
        cloudOwnerId === currentSession.cloudUserId &&
        cloudGymId === currentSession.gymId,
    );
  }
  return completeCloudLogin();
}

export type CurrentSession = {
  email: string;
  role: "admin" | "receptionist";
  name: string;
  cloudUserId?: string;
  gymId?: string;
  permissions?: ReceptionistPermissions;
};

export const DEFAULT_RECEPTIONIST_PERMISSIONS: ReceptionistPermissions = {
  dashboard: true,
  members: true,
  memberships: true,
  payments: true,
  products: true,
  viewProductCost: false,
  expenses: false,
  reports: false,
  inquiries: true,
  notifications: true,
  trash: false,
  viewRevenue: false,
};

export function getCurrentSession(): CurrentSession | null {
  return currentSession;
}

export async function saveReceptionistAccount(input: {
  enabled: boolean;
  name: string;
  email: string;
  /** Omit to keep an already-saved receptionist password unchanged. */
  password?: string;
  permissions: ReceptionistPermissions;
}) {
  const currentSession = getCurrentSession();
  if (!isSupabaseConfigured() || currentSession?.role !== "admin" || !currentSession.cloudUserId)
    return false;
  const body = await invokeEdgeFunction<{
    account?: {
      enabled?: boolean;
      name?: string;
      email?: string;
      permissions?: ReceptionistPermissions;
    };
  }>("staff-receptionist", { body: input as unknown as Record<string, unknown> });
  if (!body.account?.email || !body.account.name) return false;
  const account: ReceptionistAccount = {
    enabled: body.account.enabled !== false,
    name: body.account.name,
    email: body.account.email,
    passwordHash: "cloud-managed",
    permissions: body.account.permissions ?? input.permissions,
  };
  state = { ...getState(), staff: { receptionist: account } };
  emit();
  return true;
}

/* ------------------------------------------------------------------ */
/* Activity log                                                        */
/* ------------------------------------------------------------------ */

function log(st: GymState, type: ActivityType, title: string, description: string): GymState {
  const activity: Activity = {
    id: uid("act"),
    type,
    title,
    description,
    date: iso(new Date()),
  };
  return { ...st, activities: [activity, ...st.activities].slice(0, 300) };
}

function auditCloud(
  action: string,
  entityType?: string,
  entityId?: string,
  metadata: Record<string, string | number | boolean | null> = {},
) {
  if (!cloudOwnerId) return;
  void recordCloudAuditEvent(action, entityType, entityId, metadata).catch((error) => {
    console.error("Could not record audit event", error);
  });
}

function nextInvoice(st: GymState): [GymState, string] {
  const seq = st.invoiceSeq + 1;
  const used = new Set([
    ...st.payments.map((payment) => payment.invoiceNo),
    ...st.sales.map((sale) => sale.invoiceNo),
  ]);
  let n = seq;
  let no = `${st.settings.invoicePrefix}-${String(n).padStart(6, "0")}`;
  while (used.has(no)) {
    n += 1;
    no = `${st.settings.invoicePrefix}-${String(n).padStart(6, "0")}`;
  }
  return [{ ...st, invoiceSeq: n }, no];
}

/* ------------------------------------------------------------------ */
/* Members                                                             */
/* ------------------------------------------------------------------ */

export type NewMemberInput = Omit<
  Member,
  "id" | "notes" | "measurements" | "deletedAt" | "deletedBy" | "joinDate"
> & {
  joinDate?: string;
  planId?: string;
  startDate?: string;
  paidNow?: number;
  discount?: number;
  joiningFee?: number;
  paymentMethod?: PaymentMethod;
};

export function addMember(input: NewMemberInput) {
  if (!canAddRegularMember(getState())) return false;
  let created = false;
  let createdId = "";
  setState((st) => {
    const id = uid("mem");
    createdId = id;
    const member: Member = {
      id,
      type: "member",
      name: input.name,
      email: input.email,
      phone: phoneForCountry(input.phone, st.settings.phoneCountry),
      gender: input.gender,
      dob: input.dob,
      address: input.address,
      photo: input.photo ?? null,
      emergencyContact: phoneForCountry(input.emergencyContact, st.settings.phoneCountry),
      joinDate: input.joinDate ?? iso(new Date()),
      notes: [],
      measurements: [],
      deletedAt: null,
      deletedBy: null,
    };
    let next: GymState = { ...st, members: [member, ...st.members] };
    created = true;
    next = log(next, "member_added", "New member registered", `${member.name} joined the gym`);

    if (input.planId) {
      const plan = next.plans.find((p) => p.id === input.planId);
      if (plan) {
        const start = input.startDate ? new Date(input.startDate) : new Date();
        const end = membershipEndDate(start, plan);
        const membership: Membership = {
          id: uid("mship"),
          memberId: id,
          planId: plan.id,
          startDate: iso(start),
          endDate: iso(end),
          price: normalizeMoney(plan.price),
          discount: Math.min(Math.max(0, normalizeMoney(input.discount ?? 0)), normalizeMoney(plan.price)),
          joiningFee: Math.max(0, normalizeMoney(input.joiningFee ?? plan.joiningFee ?? 1000)),
          frozen: false,
          createdAt: iso(new Date()),
        };
        next = { ...next, memberships: [membership, ...next.memberships] };
        const payable = addMoney(
          subtractMoney(membership.price, membership.discount),
          membership.joiningFee ?? 0,
        );
        const paidNow = Math.min(Math.max(0, normalizeMoney(input.paidNow ?? 0)), payable);
        if (paidNow > 0) {
          const [withSeq, invoiceNo] = nextInvoice(next);
          const payment: Payment = {
            id: uid("pay"),
            invoiceNo,
            memberId: id,
            membershipId: membership.id,
            kind: "membership",
            amount: paidNow,
            method: input.paymentMethod ?? "cash",
            date: iso(new Date()),
            note: `${plan.name} — joining payment`,
          };
          next = { ...withSeq, payments: [payment, ...withSeq.payments] };
          next = log(
            next,
            "payment_received",
            "Payment received",
            `₹${paidNow.toLocaleString("en-IN")} from ${member.name}`,
          );
          next = log(
            next,
            "invoice_generated",
            "Invoice generated",
            `${invoiceNo} for ${member.name}`,
          );
        }
      }
    }
    return next;
  });
  if (created && createdId) auditCloud("member_created", "member", createdId);
  return created;
}

export function updateMember(id: string, patch: Partial<Member>) {
  setState((st) => {
    const current = st.members.find((member) => member.id === id);
    if (!current) return st;
    const updated = {
      ...current,
      ...patch,
      phone: patch.phone ? phoneForCountry(patch.phone, st.settings.phoneCountry) : current.phone,
      emergencyContact: patch.emergencyContact
        ? phoneForCountry(patch.emergencyContact, st.settings.phoneCountry)
        : current.emergencyContact,
    };
    return {
      ...st,
      members: st.members.map((member) => (member.id === id ? updated : member)),
      sales: st.sales.map((sale) =>
        sale.memberId === id
          ? {
              ...sale,
              buyer: updated.name,
              buyerPhone: updated.phone,
              buyerEmail: updated.email || undefined,
              buyerAddress: updated.address || undefined,
            }
          : sale,
      ),
    };
  });
  auditCloud("member_updated", "member", id);
}

export function trashMember(id: string, by: string) {
  setState((st) => {
    const member = st.members.find((m) => m.id === id);
    const next = {
      ...st,
      members: st.members.map((m) =>
        m.id === id ? { ...m, deletedAt: iso(new Date()), deletedBy: by } : m,
      ),
    };
    return log(
      next,
      "member_trashed",
      "Member moved to trash",
      `${member?.name ?? "Member"} moved to trash`,
    );
  });
  auditCloud("member_deleted", "member", id, { soft_delete: true });
}

export function restoreMember(id: string) {
  const current = getState();
  const memberToRestore = current.members.find((member) => member.id === id);
  const isRegular =
    memberToRestore && (memberToRestore.type === undefined || memberToRestore.type === "member");
  if (
    isRegular &&
    regularMemberCount(current) >= FREE_MEMBER_LIMIT &&
    !getSubscriptionSnapshot().active
  ) {
    return false;
  }
  setState((st) => {
    const member = st.members.find((m) => m.id === id);
    const next = {
      ...st,
      members: st.members.map((m) =>
        m.id === id ? { ...m, deletedAt: null, deletedBy: null } : m,
      ),
    };
    return log(
      next,
      "member_restored",
      "Member restored",
      `${member?.name ?? "Member"} restored from trash`,
    );
  });
  return true;
}

export function deleteMemberPermanently(id: string) {
  setState((st) => {
    const member = st.members.find((m) => m.id === id);
    const membershipIds = new Set(st.memberships.filter((m) => m.memberId === id).map((m) => m.id));
    const saleIds = new Set(st.sales.filter((sale) => sale.memberId === id).map((sale) => sale.id));
    const next: GymState = {
      ...st,
      members: st.members.filter((m) => m.id !== id),
      memberships: st.memberships.filter((m) => m.memberId !== id),
      payments: st.payments.filter(
        (payment) =>
          payment.memberId !== id &&
          !membershipIds.has(payment.membershipId ?? "") &&
          !saleIds.has(payment.saleId ?? ""),
      ),
      sales: st.sales.filter((sale) => sale.memberId !== id),
    };
    return log(
      next,
      "member_deleted",
      "Member permanently deleted",
      `${member?.name ?? "Member"} was permanently removed`,
    );
  });
  auditCloud("member_deleted", "member", id, { permanent: true });
}

export function addNote(memberId: string, title: string, note: string) {
  setState((st) => ({
    ...st,
    members: st.members.map((m) =>
      m.id === memberId
        ? { ...m, notes: [{ id: uid("note"), date: iso(new Date()), title, note }, ...m.notes] }
        : m,
    ),
  }));
}

export function updateNote(memberId: string, noteId: string, patch: { title: string; note: string }) {
  setState((st) => ({
    ...st,
    members: st.members.map((m) =>
      m.id === memberId
        ? {
            ...m,
            notes: m.notes.map((entry) =>
              entry.id === noteId
                ? { ...entry, title: patch.title.trim(), note: patch.note.trim() }
                : entry,
            ),
          }
        : m,
    ),
  }));
}

export function deleteNote(memberId: string, noteId: string) {
  setState((st) => ({
    ...st,
    members: st.members.map((m) =>
      m.id === memberId ? { ...m, notes: m.notes.filter((entry) => entry.id !== noteId) } : m,
    ),
  }));
}

export function addMeasurement(
  memberId: string,
  data: Omit<Member["measurements"][number], "id" | "date">,
) {
  setState((st) => ({
    ...st,
    members: st.members.map((m) =>
      m.id === memberId
        ? {
            ...m,
            measurements: [{ id: uid("msr"), date: iso(new Date()), ...data }, ...m.measurements],
          }
        : m,
    ),
  }));
}

export function updateMeasurement(
  memberId: string,
  measurementId: string,
  data: Omit<Member["measurements"][number], "id" | "date">,
) {
  setState((st) => ({
    ...st,
    members: st.members.map((m) =>
      m.id === memberId
        ? {
            ...m,
            measurements: m.measurements.map((entry) =>
              entry.id === measurementId ? { ...entry, ...data } : entry,
            ),
          }
        : m,
    ),
  }));
}

export function deleteMeasurement(memberId: string, measurementId: string) {
  setState((st) => ({
    ...st,
    members: st.members.map((m) =>
      m.id === memberId
        ? { ...m, measurements: m.measurements.filter((entry) => entry.id !== measurementId) }
        : m,
    ),
  }));
}

/* ------------------------------------------------------------------ */
/* Plans & memberships                                                 */
/* ------------------------------------------------------------------ */

export function savePlan(plan: Omit<Plan, "id"> & { id?: string }) {
  const normalizedPlan = {
    ...plan,
    price: normalizeMoney(plan.price),
    joiningFee: normalizeMoney(plan.joiningFee ?? 0),
  };
  setState((st) =>
    normalizedPlan.id
      ? {
          ...st,
          plans: st.plans.map((p) =>
            p.id === normalizedPlan.id ? ({ ...p, ...normalizedPlan } as Plan) : p,
          ),
        }
      : { ...st, plans: [...st.plans, { ...normalizedPlan, id: uid("plan") } as Plan] },
  );
}

export function deletePlan(id: string) {
  trashPlan(id);
}

export function trashPlan(id: string) {
  setState((st) => ({
    ...st,
    plans: st.plans.map((p) =>
      p.id === id && !p.locked ? { ...p, deletedAt: iso(new Date()) } : p,
    ),
  }));
}

export function restorePlan(id: string) {
  setState((st) => ({
    ...st,
    plans: st.plans.map((p) => (p.id === id ? { ...p, deletedAt: null } : p)),
  }));
}

export function deletePlanPermanently(id: string) {
  const inUse = getState().memberships.some((membership) => membership.planId === id);
  if (inUse) return false;
  setState((st) => ({ ...st, plans: st.plans.filter((p) => p.id !== id) }));
  return true;
}

export function renewMembership(
  memberId: string,
  planId: string,
  paidNow: number,
  discount = 0,
  paymentMethod: Payment["method"] = "cash",
) {
  let renewedMembershipId = "";
  setState((st) => {
    const plan = st.plans.find((p) => p.id === planId);
    const member = st.members.find((m) => m.id === memberId);
    if (!plan || !member) return st;
    const current = st.memberships
      .filter((m) => m.memberId === memberId)
      .sort((a, b) => +new Date(b.endDate) - +new Date(a.endDate))[0];
    const base =
      current && new Date(current.endDate) > new Date() ? new Date(current.endDate) : new Date();
    const end = membershipEndDate(base, plan);
    const membership: Membership = {
      id: uid("mship"),
      memberId,
      planId,
      startDate: iso(base),
      endDate: iso(end),
      price: normalizeMoney(plan.price),
      discount: Math.min(Math.max(0, normalizeMoney(discount)), normalizeMoney(plan.price)),
      joiningFee: 0,
      frozen: false,
      createdAt: iso(new Date()),
    };
    renewedMembershipId = membership.id;
    const payable = addMoney(
      subtractMoney(membership.price, membership.discount),
      membership.joiningFee ?? 0,
    );
    const collected = Math.min(Math.max(0, normalizeMoney(paidNow)), payable);
    let next: GymState = { ...st, memberships: [membership, ...st.memberships] };
    next = log(
      next,
      "membership_renewed",
      "Membership renewed",
      `${member.name} renewed ${plan.name} · ${plan.durationDays} days`,
    );
    if (collected > 0) {
      const [withSeq, invoiceNo] = nextInvoice(next);
      next = {
        ...withSeq,
        payments: [
          {
            id: uid("pay"),
            invoiceNo,
            memberId,
            membershipId: membership.id,
            kind: "membership",
            amount: collected,
            method: paymentMethod,
            date: iso(new Date()),
            note: `${plan.name} — renewal payment`,
          },
          ...withSeq.payments,
        ],
      };
      next = log(
        next,
        "payment_received",
        "Payment received",
        `₹${collected.toLocaleString("en-IN")} from ${member.name}`,
      );
    }
    return next;
  });
  if (renewedMembershipId)
    auditCloud("membership_renewed", "membership", renewedMembershipId, { member_id: memberId });
}

export function toggleFreeze(membershipId: string) {
  setState((st) => ({
    ...st,
    memberships: st.memberships.map((m) => {
      if (m.id !== membershipId) return m;
      const now = new Date();
      if (!m.frozen) return { ...m, frozen: true, frozenAt: iso(now) };

      const frozenAt = m.frozenAt ? new Date(m.frozenAt) : now;
      const frozenMs = Math.max(0, now.getTime() - frozenAt.getTime());
      const extendedEnd = new Date(new Date(m.endDate).getTime() + frozenMs);
      return { ...m, frozen: false, frozenAt: null, endDate: iso(extendedEnd) };
    }),
  }));
}

/* ------------------------------------------------------------------ */
/* Payments                                                            */
/* ------------------------------------------------------------------ */

export function addPayment(input: {
  memberId: string;
  membershipId?: string | null;
  amount: number;
  method: Payment["method"];
  date?: string;
  note?: string;
}) {
  const state = getState();
  const member = state.members.find((item) => item.id === input.memberId && !item.deletedAt);
  const membership = input.membershipId
    ? state.memberships.find(
        (item) => item.id === input.membershipId && item.memberId === input.memberId,
      )
    : undefined;
  const amount = normalizeMoney(input.amount);
  if (!member || !membership || !Number.isFinite(amount) || amount <= 0) return false;
  const alreadyPaid = sumMoney(
    state.payments.filter((payment) => payment.membershipId === membership.id),
    (payment) => payment.amount,
  );
  const remaining = Math.max(
    0,
    subtractMoney(
      addMoney(subtractMoney(membership.price, membership.discount), membership.joiningFee ?? 0),
      alreadyPaid,
    ),
  );
  if (amount > remaining) return false;

  let paymentId = "";
  setState((st) => {
    const [withSeq, invoiceNo] = nextInvoice(st);
    const payment: Payment = {
      id: uid("pay"),
      invoiceNo,
      memberId: input.memberId,
      membershipId: input.membershipId ?? null,
      kind: "membership",
      amount,
      method: input.method,
      date: input.date ?? iso(new Date()),
      note: input.note ?? "Manual payment entry",
    };
    paymentId = payment.id;
    let next: GymState = { ...withSeq, payments: [payment, ...withSeq.payments] };
    next = log(
      next,
      "payment_received",
      "Payment received",
      `₹${amount.toLocaleString("en-IN")} from ${member.name}`,
    );
    next = log(
      next,
      "invoice_generated",
      "Invoice generated",
      `${invoiceNo} created · ₹${amount.toLocaleString("en-IN")}`,
    );
    return next;
  });
  if (paymentId)
    auditCloud("payment_created", "payment", paymentId, {
      member_id: input.memberId,
      amount,
    });
  return true;
}

export function addSalePayment(
  saleId: string,
  amountInput: number,
  method: Payment["method"],
  note?: string,
) {
  const state = getState();
  const sale = state.sales.find((item) => item.id === saleId);
  const amount = normalizeMoney(amountInput);
  if (!sale || !Number.isFinite(amount) || amount <= 0) return false;

  const alreadyPaid = sumMoney(
    state.payments.filter((payment) => payment.saleId === sale.id),
    (payment) => payment.amount,
  );
  const remaining = Math.max(0, subtractMoney(sale.total, alreadyPaid));
  if (amount > remaining) return false;

  let paymentId = "";
  setState((st) => {
    const payment: Payment = {
      id: uid("pay"),
      invoiceNo: sale.invoiceNo,
      memberId: sale.memberId ?? null,
      saleId: sale.id,
      kind: "product",
      amount,
      method,
      date: iso(new Date()),
      note: note?.trim() || `${sale.productName} — balance payment`,
    };
    paymentId = payment.id;
    let next: GymState = { ...st, payments: [payment, ...st.payments] };
    next = log(
      next,
      "payment_received",
      "Payment received",
      `₹${amount.toLocaleString("en-IN")} from ${sale.buyer}`,
    );
    return next;
  });
  if (paymentId) auditCloud("payment_created", "payment", paymentId, { sale_id: sale.id, amount });
  return true;
}

/* ------------------------------------------------------------------ */
/* Products & sales                                                    */
/* ------------------------------------------------------------------ */

export function saveProduct(product: Omit<Product, "id" | "createdAt"> & { id?: string }) {
  const normalizedProduct = {
    ...product,
    cost: normalizeMoney(product.cost),
    price: normalizeMoney(product.price),
    stock: Math.max(0, Math.trunc(product.stock)),
    lowStockAt: Math.max(0, Math.trunc(product.lowStockAt)),
  };
  setState((st) => {
    if (normalizedProduct.id) {
      return {
        ...st,
        products: st.products.map((p) =>
          p.id === normalizedProduct.id ? ({ ...p, ...normalizedProduct } as Product) : p,
        ),
      };
    }
    const created: Product = {
      ...normalizedProduct,
      id: uid("prd"),
      createdAt: iso(new Date()),
    } as Product;
    const next = { ...st, products: [created, ...st.products] };
    return log(next, "product_added", "Product added", `${created.name} added to inventory`);
  });
}

export function deleteProduct(id: string) {
  trashProduct(id);
}

export function trashProduct(id: string) {
  setState((st) => ({
    ...st,
    products: st.products.map((p) =>
      p.id === id && !p.locked ? { ...p, deletedAt: iso(new Date()) } : p,
    ),
  }));
}

export function restoreProduct(id: string) {
  setState((st) => ({
    ...st,
    products: st.products.map((p) => (p.id === id ? { ...p, deletedAt: null } : p)),
  }));
}

export function deleteProductPermanently(id: string) {
  setState((st) => ({ ...st, products: st.products.filter((p) => p.id !== id) }));
}

export function adjustStock(id: string, delta: number) {
  setState((st) => ({
    ...st,
    products: st.products.map((p) =>
      p.id === id ? { ...p, stock: Math.max(0, p.stock + delta) } : p,
    ),
  }));
}

export function sellProduct(
  productId: string,
  qty: number,
  buyer: string,
  memberId?: string | null,
  extra?: {
    discount?: number;
    buyerPhone?: string;
    buyerEmail?: string;
    buyerAddress?: string;
    /** Amount collected now; defaults to the full payable total. */
    amountPaid?: number;
    paymentMethod?: PaymentMethod;
  },
) {
  let completedSaleId = "";
  setState((st) => {
    const product = st.products.find((p) => p.id === productId);
    if (!product || qty <= 0 || !Number.isInteger(qty) || product.stock < qty) return st;
    const gross = multiplyMoney(product.price, qty);
    const discount = Math.min(Math.max(0, normalizeMoney(extra?.discount ?? 0)), gross);
    const total = subtractMoney(gross, discount);
    const paid = Math.min(Math.max(0, normalizeMoney(extra?.amountPaid ?? total)), total);
    const buyerPhone = phoneForCountry(extra?.buyerPhone, st.settings.phoneCountry) || undefined;
    let saleMemberId = memberId ?? null;
    let saleBuyer = buyer || "Walk-in customer";
    let saleState = st;
    if (!saleMemberId) {
      const phoneKey = normalizedPhone(buyerPhone ?? "");
      const existing = phoneKey
        ? st.members.find(
            (member) =>
              !member.deletedAt &&
              member.type === "walk_in" &&
              normalizedPhone(member.phone) === phoneKey,
          )
        : undefined;
      if (existing) {
        saleMemberId = existing.id;
        saleBuyer = existing.name;
        saleState = {
          ...st,
          members: st.members.map((member) =>
            member.id === existing.id
              ? {
                  ...member,
                  name: buyer.trim() || member.name,
                  email: extra?.buyerEmail?.trim() || member.email,
                  address: extra?.buyerAddress?.trim() || member.address,
                }
              : member,
          ),
        };
        saleBuyer = buyer.trim() || existing.name;
      } else {
        const walkIn: Member = {
          id: uid("mem"),
          type: "walk_in",
          name: saleBuyer,
          email: extra?.buyerEmail?.trim() ?? "",
          phone: buyerPhone ?? "",
          gender: "other",
          dob: "",
          address: extra?.buyerAddress?.trim() ?? "",
          photo: null,
          joinDate: iso(new Date()),
          emergencyContact: "",
          notes: [],
          measurements: [],
          deletedAt: null,
          deletedBy: null,
        };
        saleMemberId = walkIn.id;
        saleState = { ...st, members: [walkIn, ...st.members] };
      }
    }
    const [withSeq, invoiceNo] = nextInvoice(saleState);
    const sale: Sale = {
      id: uid("sale"),
      invoiceNo,
      productId,
      productName: product.name,
      qty,
      unitPrice: product.price,
      unitCost: product.cost,
      discount,
      total,
      paid,
      buyer: saleBuyer,
      buyerPhone,
      buyerEmail: extra?.buyerEmail,
      buyerAddress: extra?.buyerAddress,
      memberId: saleMemberId,
      date: iso(new Date()),
    };
    completedSaleId = sale.id;
    let next: GymState = {
      ...withSeq,
      sales: [sale, ...withSeq.sales],
      products: withSeq.products.map((p) =>
        p.id === productId ? { ...p, stock: p.stock - qty } : p,
      ),
      payments:
        paid > 0
          ? [
              {
                id: uid("pay"),
                invoiceNo,
                saleId: sale.id,
                memberId: saleMemberId,
                kind: "product" as const,
                amount: paid,
                method: extra?.paymentMethod ?? "cash",
                date: sale.date,
                note: `${product.name} × ${qty}`,
              },
              ...withSeq.payments,
            ]
          : withSeq.payments,
    };
    next = log(
      next,
      "product_sold",
      "Product sold",
      `${product.name} × ${qty} sold to ${sale.buyer}`,
    );
    next = log(
      next,
      "invoice_generated",
      "Invoice generated",
      `${invoiceNo} created for ${sale.buyer} · ₹${sale.total.toLocaleString("en-IN")}`,
    );
    return next;
  });
  if (completedSaleId)
    auditCloud("product_sold", "sale", completedSaleId, { product_id: productId, quantity: qty });
}

/* ------------------------------------------------------------------ */
/* Settings, notifications, backup                                     */
/* ------------------------------------------------------------------ */

export function updateSettings(patch: Partial<Settings>) {
  setState((st) => {
    const phoneCountry = patch.phoneCountry ?? st.settings.phoneCountry ?? "india";
    const countryChanged = patch.phoneCountry && patch.phoneCountry !== st.settings.phoneCountry;
    return {
      ...st,
      settings: {
        ...st.settings,
        ...patch,
        phone: countryChanged
          ? phoneForCountry(patch.phone ?? st.settings.phone, phoneCountry)
          : (patch.phone ?? st.settings.phone),
      },
      members: countryChanged
        ? st.members.map((member) => ({
            ...member,
            phone: phoneForCountry(member.phone, phoneCountry),
            emergencyContact: phoneForCountry(member.emergencyContact, phoneCountry),
          }))
        : st.members,
      sales: countryChanged
        ? st.sales.map((sale) => ({
            ...sale,
            buyerPhone: phoneForCountry(sale.buyerPhone, phoneCountry) || undefined,
          }))
        : st.sales,
      inquiries: countryChanged
        ? (st.inquiries ?? []).map((inquiry) => ({
            ...inquiry,
            phone: phoneForCountry(inquiry.phone, phoneCountry),
          }))
        : (st.inquiries ?? []),
    };
  });
  auditCloud("settings_updated", "settings", cloudGymId ?? "gym", {
    fields: Object.keys(patch).join(","),
  });
}

export function markNotificationsRead(ids: string[]) {
  setState((st) => ({
    ...st,
    readNotifications: Array.from(new Set([...st.readNotifications, ...ids])).slice(-500),
  }));
}

export function exportBackup() {
  const current = getState();
  return JSON.stringify({ ...current, staff: sanitizedStaff(current.staff) }, null, 2);
}

export function restoreBackup(json: string) {
  const parsed = JSON.parse(json) as GymState;
  const expenses = parsed?.expenses ?? [];
  const inquiries = parsed?.inquiries ?? [];
  const arrays = [
    parsed?.members,
    parsed?.plans,
    parsed?.memberships,
    parsed?.payments,
    parsed?.products,
    parsed?.sales,
    parsed?.activities,
    expenses,
    inquiries,
    parsed?.readNotifications,
  ];
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !parsed.auth ||
    !parsed.settings ||
    !arrays.every(Array.isArray) ||
    !Number.isFinite(parsed.invoiceSeq)
  ) {
    throw new Error("Invalid backup file");
  }

  const memberIds = new Set(parsed.members.map((member) => member.id));
  const planIds = new Set(parsed.plans.map((plan) => plan.id));
  const membershipIds = new Set(parsed.memberships.map((membership) => membership.id));
  const saleIds = new Set(parsed.sales.map((sale) => sale.id));
  const valid =
    parsed.memberships.every(
      (membership) => memberIds.has(membership.memberId) && planIds.has(membership.planId),
    ) &&
    parsed.payments.every(
      (payment) =>
        Number.isFinite(payment.amount) &&
        payment.amount > 0 &&
        (!payment.memberId || memberIds.has(payment.memberId)) &&
        (!payment.membershipId || membershipIds.has(payment.membershipId)) &&
        (!payment.saleId || saleIds.has(payment.saleId)),
    ) &&
    parsed.sales.every((sale) => !sale.memberId || memberIds.has(sale.memberId)) &&
    expenses.every((expense) => Number.isFinite(expense.amount) && expense.amount > 0);
  if (!valid) throw new Error("Backup contains broken record references");

  if (regularMemberCount(parsed) > FREE_MEMBER_LIMIT && !getSubscriptionSnapshot().active) {
    throw new Error(
      `This backup contains more than ${FREE_MEMBER_LIMIT} active gym members. Activate Pro before restoring it.`,
    );
  }

  setState(() => ({
    ...parsed,
    expenses,
    inquiries,
    staff: sanitizedStaff(parsed.staff),
    version: 1,
  }));
  auditCloud("backup_restored", "workspace", cloudGymId ?? "gym");
}

export function resetData() {
  setState((st) => ({
    ...st,
    members: [],
    plans: [],
    memberships: [],
    payments: [],
    products: [],
    sales: [],
    activities: [],
    expenses: [],
    inquiries: [],
    readNotifications: [],
    invoiceSeq: 0,
  }));
}

export async function setupTemplateData() {
  const previous = getState();
  const ownerAtStart = cloudOwnerId;
  const hadPendingCloudSave = Boolean(cloudSaveTimer) || cloudSyncPending;

  // Flush pending edits before replacing business data, so the template save
  // uses the latest optimistic-lock revision and never silently loses work.
  if (cloudSaveTimer) {
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer = null;
  }
  if (cloudOwnerId && cloudRevision !== null && hadPendingCloudSave) {
    const saved = await flushCloudSave(previous, false);
    if (!saved) {
      throw new Error("Your current changes could not be saved. Check your connection and try again.");
    }
  }
  if (state !== previous || cloudOwnerId !== ownerAtStart) {
    throw new Error("Your workspace changed while setting up. Please try again.");
  }

  // Free workspaces get a representative starter dataset within their roster
  // allowance. Pro workspaces retain the complete demo dataset.
  const template = buildSeed(
    getSubscriptionSnapshot().active ? undefined : FREE_MEMBER_LIMIT,
  );
  const nextState: GymState = {
    ...template,
    auth: previous.auth,
    settings: previous.settings,
    staff: previous.staff,
  };

  replaceState(nextState, false);

  if (cloudOwnerId && cloudRevision !== null) {
    const saved = await flushCloudSave(nextState, false);
    if (!saved) {
      // Restore the server's latest revision when possible. If the request
      // failed offline, keep the last known good workspace in memory.
      const latest = await loadCloudWorkspace().catch(() => null);
      if (latest && cloudOwnerId === ownerAtStart) {
        replaceState(
          {
            ...latest.state,
            expenses: (latest.state.expenses ?? []).map((expense) => ({
              ...expense,
              locked: expense.locked !== false,
            })),
            inquiries: latest.state.inquiries ?? [],
            staff: sanitizedStaff(latest.state.staff),
          },
          false,
        );
        cloudRevision = latest.revision;
        cloudGymId = latest.gymId;
        cloudSyncPending = false;
      } else if (state === nextState) {
        replaceState(previous, false);
      }
      throw new Error(
        "Template data could not be saved to your gym. Your previous data was restored; check your connection and try again.",
      );
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Inquiries                                                          */
/* ------------------------------------------------------------------ */

export type InquiryInput = {
  name: string;
  phone: string;
  email?: string;
  source: InquirySource;
  interest: string;
  status: InquiryStatus;
  priority: InquiryPriority;
  nextFollowUp?: string | null;
  notes?: string;
};

export function addInquiry(input: InquiryInput) {
  setState((st) => {
    const now = iso(new Date());
    const inquiry: Inquiry = {
      id: uid("inq"),
      name: input.name.trim(),
      phone: phoneForCountry(input.phone, st.settings.phoneCountry),
      email: input.email?.trim() || undefined,
      source: input.source,
      interest: input.interest.trim(),
      status: input.status,
      priority: input.priority,
      nextFollowUp: input.nextFollowUp ?? null,
      notes: input.notes?.trim() ?? "",
      createdAt: now,
      updatedAt: now,
    };
    return log(
      { ...st, inquiries: [inquiry, ...(st.inquiries ?? [])] },
      "inquiry_added",
      "New inquiry",
      `${inquiry.name} added as a ${inquiry.priority} lead`,
    );
  });
}

export function updateInquiry(id: string, patch: Partial<InquiryInput>) {
  setState((st) => {
    const current = (st.inquiries ?? []).find((inquiry) => inquiry.id === id);
    if (!current) return st;
    const updated: Inquiry = {
      ...current,
      ...patch,
      name: patch.name?.trim() ?? current.name,
      phone:
        patch.phone === undefined
          ? current.phone
          : phoneForCountry(patch.phone, st.settings.phoneCountry),
      email: patch.email === undefined ? current.email : patch.email.trim() || undefined,
      interest: patch.interest?.trim() ?? current.interest,
      notes: patch.notes?.trim() ?? current.notes,
      updatedAt: iso(new Date()),
    };
    return log(
      {
        ...st,
        inquiries: st.inquiries.map((inquiry) => (inquiry.id === id ? updated : inquiry)),
      },
      "inquiry_updated",
      "Inquiry updated",
      `${updated.name} moved to ${updated.status.replace("_", " ")}`,
    );
  });
  auditCloud("inquiry_updated", "inquiry", id);
}

export function deleteInquiry(id: string) {
  setState((st) => {
    const inquiry = (st.inquiries ?? []).find((item) => item.id === id);
    if (!inquiry) return st;
    return log(
      { ...st, inquiries: st.inquiries.filter((item) => item.id !== id) },
      "inquiry_deleted",
      "Inquiry deleted",
      `${inquiry.name} removed from the lead pipeline`,
    );
  });
}

/* ------------------------------------------------------------------ */
/* Expenses                                                            */
/* ------------------------------------------------------------------ */

export type ExpenseInput = {
  title: string;
  category: Expense["category"];
  amount: number;
  date: string;
  method: Expense["method"];
  notes?: string;
  attachment?: Expense["attachment"];
  locked?: boolean;
};

function nextExpenseNo(list: Expense[]) {
  const max = list.reduce((n, e) => {
    const num = Number(String(e.expenseNo).split("-").pop());
    return Number.isFinite(num) ? Math.max(n, num) : n;
  }, 0);
  return `EXP-${String(max + 1).padStart(6, "0")}`;
}

export function addExpense(input: ExpenseInput) {
  let expenseId = "";
  setState((st) => {
    const list = st.expenses ?? [];
    const expense: Expense = {
      id: uid("exp"),
      expenseNo: nextExpenseNo(list),
      title: input.title.trim(),
      category: input.category,
      amount: Math.max(0, normalizeMoney(input.amount)),
      date: input.date,
      method: input.method,
      notes: input.notes?.trim() ?? "",
      attachment: input.attachment ?? null,
      createdAt: iso(new Date()),
      // Every newly-created expense starts protected from deletion.
      locked: true,
      deletedAt: null,
    };
    expenseId = expense.id;
    const next: GymState = { ...st, expenses: [expense, ...list] };
    return log(
      next,
      "expense_added",
      "Expense recorded",
      `${expense.title} — ₹${expense.amount.toLocaleString("en-IN")}`,
    );
  });
  if (expenseId)
    auditCloud("expense_created", "expense", expenseId, { amount: Math.max(0, Math.round(input.amount)) });
}

export function updateExpense(id: string, patch: Partial<ExpenseInput>) {
  setState((st) => {
    const next: GymState = {
      ...st,
      expenses: (st.expenses ?? []).map((e) =>
        e.id === id
          ? {
              ...e,
              ...patch,
              title: patch.title !== undefined ? patch.title.trim() : e.title,
              amount: patch.amount !== undefined ? Math.max(0, normalizeMoney(patch.amount)) : e.amount,
              notes: patch.notes !== undefined ? patch.notes.trim() : e.notes,
              attachment: patch.attachment !== undefined ? patch.attachment : e.attachment,
            }
          : e,
      ),
    };
    const updated = next.expenses?.find((e) => e.id === id);
    return log(
      next,
      "expense_updated",
      "Expense updated",
      `${updated?.title ?? "Expense"} — ₹${(updated?.amount ?? 0).toLocaleString("en-IN")}`,
    );
  });
  auditCloud("expense_updated", "expense", id);
}

export function trashExpense(id: string) {
  const existing = (getState().expenses ?? []).find((expense) => expense.id === id);
  if (!existing || existing.locked !== false) return false;
  setState((st) => {
    const target = (st.expenses ?? []).find((e) => e.id === id);
    const next: GymState = {
      ...st,
      expenses: (st.expenses ?? []).map((e) =>
        e.id === id ? { ...e, deletedAt: iso(new Date()) } : e,
      ),
    };
    return log(
      next,
      "expense_trashed",
      "Expense moved to trash",
      `${target?.title ?? "Expense"} moved to trash`,
    );
  });
  return true;
}

export function restoreExpense(id: string) {
  setState((st) => ({
    ...st,
    expenses: (st.expenses ?? []).map((e) => (e.id === id ? { ...e, deletedAt: null } : e)),
  }));
}

export function deleteExpensePermanently(id: string) {
  const existing = (getState().expenses ?? []).find((expense) => expense.id === id);
  if (!existing || existing.locked !== false) return false;
  setState((st) => ({ ...st, expenses: (st.expenses ?? []).filter((e) => e.id !== id) }));
  return true;
}
