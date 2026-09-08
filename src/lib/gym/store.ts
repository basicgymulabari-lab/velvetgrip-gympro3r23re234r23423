import { useSyncExternalStore } from "react";
import { buildSeed, uid, iso } from "./seed";
import { configureCalendarSystem } from "./calendar";
import { phoneForCountry } from "./phone";
import { membershipEndDate } from "./membership";
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
import { getCloudIdentity, loadCloudState, saveCloudState, signOutFromCloud } from "./cloud";
import { newWorkspace } from "./new-workspace";
import { anonymizeDemoContacts } from "./demo-contacts";

const DB_KEY = "ironvault.db.v1";
const SESSION_KEY = "ironvault.session.v1";
const RECEPTIONIST_KEY = "ironvault.receptionist.v1";
const CLOUD_SYNC_PENDING_KEY = "ironvault.cloud-sync-pending.v1";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

let state: GymState | null = null;
const listeners = new Set<() => void>();
let cloudOwnerId: string | null = null;
let cloudSaveTimer: ReturnType<typeof setTimeout> | null = null;
let onlineSyncInstalled = false;

const isBrowser = () => typeof window !== "undefined";
const normalizedPhone = (value: string) => {
  const digits = value.replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
};

function receptionistFromLocalStorage(): ReceptionistAccount | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(RECEPTIONIST_KEY);
    return raw ? (JSON.parse(raw) as ReceptionistAccount) : null;
  } catch {
    return null;
  }
}

function openAuthDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open("ironvault-auth", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("accounts")) {
        request.result.createObjectStore("accounts");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function persistReceptionist(account: ReceptionistAccount) {
  if (!isBrowser()) return true;
  try {
    window.localStorage.setItem(RECEPTIONIST_KEY, JSON.stringify(account));
    return true;
  } catch {
    // Large member photos or attachments can fill localStorage. Use IndexedDB for auth fallback.
  }
  if (!window.indexedDB) return false;
  try {
    const database = await openAuthDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("accounts", "readwrite");
      transaction.objectStore("accounts").put(account, "receptionist");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
    return true;
  } catch {
    return false;
  }
}

async function loadPersistedReceptionist(): Promise<ReceptionistAccount | null> {
  const local = receptionistFromLocalStorage();
  if (local) return local;
  if (!isBrowser() || !window.indexedDB) return null;
  try {
    const database = await openAuthDatabase();
    const account = await new Promise<ReceptionistAccount | null>((resolve, reject) => {
      const request = database
        .transaction("accounts", "readonly")
        .objectStore("accounts")
        .get("receptionist");
      request.onsuccess = () =>
        resolve((request.result as ReceptionistAccount | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return account;
  } catch {
    return null;
  }
}

function persist() {
  if (!isBrowser() || !state) return;
  try {
    window.localStorage.setItem(DB_KEY, JSON.stringify(state));
  } catch {
    /* storage full or unavailable — keep in-memory state */
  }
}

function scheduleCloudSave(nextState: GymState) {
  if (!cloudOwnerId) return;
  const ownerId = cloudOwnerId;
  window.localStorage.setItem(CLOUD_SYNC_PENDING_KEY, "true");
  if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(() => {
    if (cloudOwnerId !== ownerId) return;
    void saveCloudState(ownerId, nextState)
      .then(() => {
        if (state === nextState) window.localStorage.removeItem(CLOUD_SYNC_PENDING_KEY);
      })
      .catch((error) => {
        // The local copy remains authoritative while offline. The online event
        // below retries the newest state instead of losing the edit.
        console.error("Unable to sync the gym workspace to Supabase", error);
      });
  }, 500);
}

function installOnlineSync() {
  if (onlineSyncInstalled || !isBrowser() || typeof window.addEventListener !== "function") return;
  onlineSyncInstalled = true;
  window.addEventListener("online", () => {
    if (cloudOwnerId && state && window.localStorage.getItem(CLOUD_SYNC_PENDING_KEY)) {
      scheduleCloudSave(state);
    }
  });
}

function emit() {
  listeners.forEach((l) => l());
}

function init() {
  if (state || !isBrowser()) return;
  installOnlineSync();
  try {
    const raw = window.localStorage.getItem(DB_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as GymState;
      if (parsed && parsed.version === 1) {
        state = {
          ...parsed,
          expenses: (parsed.expenses ?? []).map((expense) => ({
            ...expense,
            // Legacy local records predate expense locking; protect them by default.
            locked: expense.locked !== false,
          })),
          inquiries: parsed.inquiries ?? buildSeed().inquiries,
          staff: {
            ...(parsed.staff ?? {}),
            receptionist: receptionistFromLocalStorage() ?? parsed.staff?.receptionist,
          },
        };
        configureCalendarSystem(state.settings.calendarSystem);
        state = anonymizeDemoContacts(state);
        persist();
        purgeOldTrash();
        return;
      }
    }
  } catch {
    /* corrupt payload — fall through to a fresh seed */
  }
  state = buildSeed();
  configureCalendarSystem(state.settings.calendarSystem);
  persist();
}

function setState(updater: (s: GymState) => GymState) {
  if (!state) init();
  if (!state) return;
  state = updater(state);
  configureCalendarSystem(state.settings.calendarSystem);
  persist();
  scheduleCloudSave(state);
  emit();
}

function subscribe(listener: () => void) {
  init();
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
  if (!state) init();
  return state ?? buildSeed();
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

export async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function login(email: string, password: string) {
  let s = getState();
  const hash = await sha256(password.trim());
  const normalizedEmail = email.trim().toLowerCase();
  let receptionist = s.staff?.receptionist;
  if (
    import.meta.env.DEV &&
    normalizedEmail === "demo@ironvault.gym" &&
    hash === "b6980133ea06ec01d91af7186a928fd090900442e1527372fb650bd86db245dd"
  ) {
    receptionist = {
      enabled: true,
      name: "Demo Receptionist",
      email: normalizedEmail,
      passwordHash: hash,
      permissions: DEFAULT_RECEPTIONIST_PERMISSIONS,
    };
    setState((current) => ({
      ...current,
      staff: { ...current.staff, receptionist },
    }));
    s = getState();
  }
  if (!receptionist || normalizedEmail !== receptionist.email.toLowerCase()) {
    const persisted = await loadPersistedReceptionist();
    if (persisted) {
      receptionist = persisted;
      setState((current) => ({
        ...current,
        staff: { ...current.staff, receptionist: persisted },
      }));
      s = getState();
    }
  }
  const isAdmin = normalizedEmail === s.auth.email.toLowerCase() && hash === s.auth.passwordHash;
  const isReceptionist = Boolean(
    receptionist?.enabled &&
    normalizedEmail === receptionist.email.toLowerCase() &&
    hash === receptionist.passwordHash,
  );
  if ((isAdmin || isReceptionist) && isBrowser()) {
    const session = JSON.stringify({
      at: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
      email: normalizedEmail,
      role: isReceptionist ? "receptionist" : "admin",
    });
    window.sessionStorage.setItem(SESSION_KEY, session);
    window.localStorage.setItem(SESSION_KEY, session);
    emit();
  }
  return isAdmin || isReceptionist;
}

export function logout() {
  if (!isBrowser()) return;
  cloudOwnerId = null;
  if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
  cloudSaveTimer = null;
  window.sessionStorage.removeItem(SESSION_KEY);
  window.localStorage.removeItem(SESSION_KEY);
  void signOutFromCloud().catch(() => undefined);
  emit();
}

// Wait for pending changes and revoke the cloud session before returning to login.
export async function logoutSecurely() {
  if (cloudSaveTimer) {
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer = null;
  }
  if (cloudOwnerId && state) {
    await saveCloudState(cloudOwnerId, state);
    window.localStorage.removeItem(CLOUD_SYNC_PENDING_KEY);
  }
  await signOutFromCloud();
  cloudOwnerId = null;
  window.sessionStorage.removeItem(SESSION_KEY);
  window.localStorage.removeItem(SESSION_KEY);
  emit();
}

export async function completeCloudLogin() {
  if (!isBrowser()) return false;
  const identity = await getCloudIdentity();
  if (!identity) return false;
  if (cloudSaveTimer) {
    clearTimeout(cloudSaveTimer);
    // Navigating between pages must not discard a pending edit before reloading.
    if (cloudOwnerId === identity.id && state) await saveCloudState(identity.id, state);
  }
  cloudSaveTimer = null;
  cloudOwnerId = null;

  const localSession = getCurrentSession();
  const hasPendingLocalChanges =
    localSession?.cloudUserId === identity.id &&
    window.localStorage.getItem(CLOUD_SYNC_PENDING_KEY) === "true" &&
    state?.version === 1;

  if (hasPendingLocalChanges && state) {
    await saveCloudState(identity.id, state);
    window.localStorage.removeItem(CLOUD_SYNC_PENDING_KEY);
  }

  const cloudState = hasPendingLocalChanges ? state : await loadCloudState(identity.id);
  if (cloudState?.version === 1) {
    state = {
      ...cloudState,
      expenses: (cloudState.expenses ?? []).map((expense) => ({
        ...expense,
        locked: expense.locked !== false,
      })),
      inquiries: cloudState.inquiries ?? [],
      staff: cloudState.staff ?? {},
    };
    configureCalendarSystem(state.settings.calendarSystem);
    persist();
  } else {
    const fresh = newWorkspace(identity.email, identity.name, identity.gymName);
    // Insert only: a concurrent first login must never overwrite an existing workspace.
    const { supabase } = await import("../../integrations/supabase/client");
    const { error } = await supabase
      .from("gym_workspaces")
      .insert({ owner_id: identity.id, state: fresh });
    if (error && error.code !== "23505") throw error;
    state = error ? await loadCloudState(identity.id) : fresh;
    if (!state) throw new Error("Workspace could not be created.");
    configureCalendarSystem(state.settings.calendarSystem);
    persist();
  }

  cloudOwnerId = identity.id;
  state = anonymizeDemoContacts(getState());
  persist();
  const session = JSON.stringify({
    at: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
    email: identity.email.toLowerCase(),
    role: "admin",
    cloudUserId: identity.id,
  });
  window.sessionStorage.setItem(SESSION_KEY, session);
  window.localStorage.setItem(SESSION_KEY, session);
  emit();
  return true;
}

export function isLoggedIn() {
  return getCurrentSession() !== null;
}

export async function validateCurrentSession() {
  const session = getCurrentSession();
  if (!session) return false;
  if (session.role === "receptionist") return true;
  if (import.meta.env.DEV && session.email === getState().auth.email.toLowerCase()) return true;
  // A previously verified owner can keep working during a connection outage.
  // The normal cloud verification resumes as soon as the device is online.
  if (!window.navigator.onLine && session.cloudUserId) return true;
  // A browser session marker alone is not proof of an authenticated owner.
  return completeCloudLogin();
}

export type CurrentSession = {
  email: string;
  role: "admin" | "receptionist";
  name: string;
  cloudUserId?: string;
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
  if (!isBrowser()) return null;
  const raw =
    window.sessionStorage.getItem(SESSION_KEY) || window.localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as {
      at?: unknown;
      expiresAt?: unknown;
      email?: unknown;
      role?: unknown;
      cloudUserId?: unknown;
    };
    const at = typeof session.at === "number" ? session.at : 0;
    const expiresAt =
      typeof session.expiresAt === "number" ? session.expiresAt : at + SESSION_TTL_MS;
    const s = getState();
    const email = typeof session.email === "string" ? session.email.toLowerCase() : "";
    const receptionist = s.staff?.receptionist;
    const role = session.role === "receptionist" ? "receptionist" : "admin";
    const cloudUserId = typeof session.cloudUserId === "string" ? session.cloudUserId : "";
    const identityValid =
      role === "admin"
        ? Boolean(cloudUserId) || email === s.auth.email.toLowerCase()
        : Boolean(receptionist?.enabled && email === receptionist.email.toLowerCase());
    if (identityValid && at > 0 && expiresAt > Date.now()) {
      if (cloudUserId) cloudOwnerId = cloudUserId;
      return {
        email,
        role,
        name: role === "admin" ? s.settings.adminName : receptionist?.name || "Receptionist",
        cloudUserId: cloudUserId || undefined,
        permissions:
          role === "receptionist"
            ? { ...DEFAULT_RECEPTIONIST_PERMISSIONS, ...receptionist?.permissions }
            : undefined,
      };
    }
  } catch {
    // Invalid or tampered session payloads are removed below.
  }
  logout();
  return null;
}

export async function saveReceptionistAccount(input: {
  enabled: boolean;
  name: string;
  email: string;
  /** Omit to keep an already-saved receptionist password unchanged. */
  password?: string;
  permissions: ReceptionistPermissions;
}) {
  const current = getState();
  const currentReceptionist = current.staff?.receptionist;
  const normalizedPassword = input.password?.trim() ?? "";
  if (!currentReceptionist && normalizedPassword.length < 8) return false;

  let passwordHash = currentReceptionist?.passwordHash ?? "";
  if (normalizedPassword) {
    if (normalizedPassword.length < 8) return false;
    passwordHash = await sha256(normalizedPassword);
    if (passwordHash === current.auth.passwordHash) return false;
  }
  if (!passwordHash) return false;

  const account: ReceptionistAccount = {
    enabled: input.enabled,
    name: input.name.trim(),
    email: input.email.trim().toLowerCase(),
    passwordHash,
    passwordCopy: normalizedPassword || currentReceptionist?.passwordCopy,
    permissions: input.permissions,
  };
  if (!(await persistReceptionist(account))) return false;
  setState((st) => ({ ...st, staff: { ...st.staff, receptionist: account } }));
  return true;
}

export async function receptionistLoginIssue(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const receptionist = getState().staff?.receptionist ?? (await loadPersistedReceptionist());
  if (!receptionist || normalizedEmail !== receptionist.email.toLowerCase()) {
    return "No receptionist account exists for this email. Ask the administrator to create and save it in Settings.";
  }
  if (!receptionist.enabled) {
    return "This receptionist account is disabled. Ask the administrator to enable it in Settings.";
  }
  return "The password is incorrect. Ask the administrator to reset the receptionist password in Settings.";
}

export async function changePassword(current: string, next: string) {
  const s = getState();
  if ((await sha256(current)) !== s.auth.passwordHash) return false;
  const hash = await sha256(next);
  if (hash === s.staff?.receptionist?.passwordHash) return false;
  setState((st) => ({ ...st, auth: { ...st.auth, passwordHash: hash } }));
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
  setState((st) => {
    const id = uid("mem");
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
          price: plan.price,
          discount: Math.min(Math.max(0, Math.round(input.discount ?? 0)), plan.price),
          joiningFee: Math.max(0, Math.round(input.joiningFee ?? plan.joiningFee ?? 1000)),
          frozen: false,
          createdAt: iso(new Date()),
        };
        next = { ...next, memberships: [membership, ...next.memberships] };
        const payable = membership.price - membership.discount + (membership.joiningFee ?? 0);
        const paidNow = Math.min(Math.max(0, Math.round(input.paidNow ?? 0)), payable);
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
}

export function restoreMember(id: string) {
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
}

function purgeOldTrash() {
  if (!state) return;
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const expired = state.members.filter(
    (m) => m.deletedAt && new Date(m.deletedAt).getTime() < cutoff,
  );
  if (expired.length === 0) {
    purgeOldTrashedPlans();
    return;
  }
  const ids = new Set(expired.map((m) => m.id));
  const membershipIds = new Set(
    state.memberships.filter((m) => ids.has(m.memberId)).map((m) => m.id),
  );
  const saleIds = new Set(
    state.sales.filter((sale) => ids.has(sale.memberId ?? "")).map((sale) => sale.id),
  );
  state = {
    ...state,
    members: state.members.filter((m) => !ids.has(m.id)),
    memberships: state.memberships.filter((m) => !ids.has(m.memberId)),
    payments: state.payments.filter(
      (payment) =>
        !ids.has(payment.memberId ?? "") &&
        !membershipIds.has(payment.membershipId ?? "") &&
        !saleIds.has(payment.saleId ?? ""),
    ),
    sales: state.sales.filter((sale) => !ids.has(sale.memberId ?? "")),
  };
  purgeOldTrashedPlans();
  persist();
}

function purgeOldTrashedPlans() {
  if (!state) return;
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const referencedPlanIds = new Set(state.memberships.map((membership) => membership.planId));
  const keep = state.plans.filter(
    (p) =>
      referencedPlanIds.has(p.id) || !(p.deletedAt && new Date(p.deletedAt).getTime() < cutoff),
  );
  const keepProducts = state.products.filter(
    (p) => !(p.deletedAt && new Date(p.deletedAt).getTime() < cutoff),
  );
  const keepExpenses = (state.expenses ?? []).filter(
    (e) => !(e.deletedAt && new Date(e.deletedAt).getTime() < cutoff),
  );
  if (
    keep.length === state.plans.length &&
    keepProducts.length === state.products.length &&
    keepExpenses.length === (state.expenses ?? []).length
  )
    return;
  state = { ...state, plans: keep, products: keepProducts, expenses: keepExpenses };
  persist();
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
  setState((st) =>
    plan.id
      ? { ...st, plans: st.plans.map((p) => (p.id === plan.id ? ({ ...p, ...plan } as Plan) : p)) }
      : { ...st, plans: [...st.plans, { ...plan, id: uid("plan") } as Plan] },
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
      price: plan.price,
      discount: Math.min(Math.max(0, Math.round(discount)), plan.price),
      joiningFee: 0,
      frozen: false,
      createdAt: iso(new Date()),
    };
    const payable = membership.price - membership.discount + (membership.joiningFee ?? 0);
    const collected = Math.min(Math.max(0, Math.round(paidNow)), payable);
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
  const amount = Math.round(input.amount);
  if (!member || !membership || !Number.isFinite(amount) || amount <= 0) return false;
  const alreadyPaid = state.payments
    .filter((payment) => payment.membershipId === membership.id)
    .reduce((sum, payment) => sum + payment.amount, 0);
  const remaining = Math.max(
    0,
    membership.price - membership.discount + (membership.joiningFee ?? 0) - alreadyPaid,
  );
  if (amount > remaining) return false;

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
  const amount = Math.round(amountInput);
  if (!sale || !Number.isFinite(amount) || amount <= 0) return false;

  const alreadyPaid = state.payments
    .filter((payment) => payment.saleId === sale.id)
    .reduce((sum, payment) => sum + payment.amount, 0);
  const remaining = Math.max(0, sale.total - alreadyPaid);
  if (amount > remaining) return false;

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
    let next: GymState = { ...st, payments: [payment, ...st.payments] };
    next = log(
      next,
      "payment_received",
      "Payment received",
      `₹${amount.toLocaleString("en-IN")} from ${sale.buyer}`,
    );
    return next;
  });
  return true;
}

/* ------------------------------------------------------------------ */
/* Products & sales                                                    */
/* ------------------------------------------------------------------ */

export function saveProduct(product: Omit<Product, "id" | "createdAt"> & { id?: string }) {
  setState((st) => {
    if (product.id) {
      return {
        ...st,
        products: st.products.map((p) =>
          p.id === product.id ? ({ ...p, ...product } as Product) : p,
        ),
      };
    }
    const created: Product = { ...product, id: uid("prd"), createdAt: iso(new Date()) } as Product;
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
  setState((st) => {
    const product = st.products.find((p) => p.id === productId);
    if (!product || qty <= 0 || !Number.isInteger(qty) || product.stock < qty) return st;
    const gross = product.price * qty;
    const discount = Math.min(Math.max(0, Math.round(extra?.discount ?? 0)), gross);
    const total = gross - discount;
    const paid = Math.min(Math.max(0, Math.round(extra?.amountPaid ?? total)), total);
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
}

export function markNotificationsRead(ids: string[]) {
  setState((st) => ({
    ...st,
    readNotifications: Array.from(new Set([...st.readNotifications, ...ids])).slice(-500),
  }));
}

export function exportBackup() {
  return JSON.stringify(getState(), null, 2);
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

  setState(() => ({ ...parsed, expenses, inquiries, version: 1 }));
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

export function setupTemplateData() {
  setState((st) => {
    const template = buildSeed();
    return {
      ...template,
      auth: st.auth,
      settings: st.settings,
    };
  });
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
  setState((st) => {
    const list = st.expenses ?? [];
    const expense: Expense = {
      id: uid("exp"),
      expenseNo: nextExpenseNo(list),
      title: input.title.trim(),
      category: input.category,
      amount: Math.max(0, Math.round(input.amount)),
      date: input.date,
      method: input.method,
      notes: input.notes?.trim() ?? "",
      attachment: input.attachment ?? null,
      createdAt: iso(new Date()),
      // Every newly-created expense starts protected from deletion.
      locked: true,
      deletedAt: null,
    };
    const next: GymState = { ...st, expenses: [expense, ...list] };
    return log(
      next,
      "expense_added",
      "Expense recorded",
      `${expense.title} — ₹${expense.amount.toLocaleString("en-IN")}`,
    );
  });
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
              amount: patch.amount !== undefined ? Math.max(0, Math.round(patch.amount)) : e.amount,
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
