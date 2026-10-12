import { useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { buildSeed, uid, iso } from "./seed";
import { configureCalendarSystem, parseCalendarDate } from "./calendar";
import { phoneForCountry } from "./phone";
import { membershipEndDate } from "./membership";
import {
  addMoney,
  isPositiveMoneyAmount,
  isSafeMoneyAmount,
  isSafeMoneySum,
  multiplyMoney,
  normalizeMoney,
  subtractMoney,
  sumMoney,
} from "./money";
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
  getCachedCloudIdentity,
  getCloudGymContext,
  getCloudIdentity,
  loadCloudWorkspace,
  recordCloudAuditEvent,
  saveCloudWorkspace,
  signOutFromCloud,
} from "./cloud";
import type { CloudWorkspace } from "./cloud";
import {
  readOfflineWorkspace,
  writeOfflineWorkspace,
  type OfflineWorkspaceRecord,
} from "./offline-cache";
import { isSupabaseConfigured } from "../../integrations/supabase/client";
import { invokeEdgeFunction } from "../../integrations/supabase/functions";
import { newWorkspace } from "./new-workspace";
import { dataUrlToBlob, deletePrivateAsset, uploadPrivateAsset } from "./storage";
import {
  canAddRegularMember,
  FREE_MEMBER_LIMIT,
  getSubscriptionSnapshot,
  regularMemberCount,
  setGymSubscriptionSnapshot,
} from "../billing/client";

let state: GymState | null = null;
const listeners = new Set<() => void>();
let cloudOwnerId: string | null = null;
let cloudGymId: string | null = null;
let cloudRevision: number | null = null;
let cloudSyncedState: GymState | null = null;
let cloudSaveTimer: ReturnType<typeof setTimeout> | null = null;
let cloudSaveQueue: Promise<void> = Promise.resolve();
let cloudSyncPending = false;
let cloudSyncMessage: string | null = null;
let onlineSyncInstalled = false;
const CLOUD_PERSISTED_DATA_KEYS = [
  "version",
  "settings",
  "members",
  "plans",
  "memberships",
  "payments",
  "products",
  "sales",
  "activities",
  "expenses",
  "inquiries",
  "readNotifications",
  "invoiceSeq",
] as const satisfies readonly (keyof GymState)[];
let currentSession: CurrentSession | null = null;
let offlineCacheQueue: Promise<void> = Promise.resolve();
let cloudWorkspaceIO: {
  load: typeof loadCloudWorkspace;
  save: typeof saveCloudWorkspace;
} = { load: loadCloudWorkspace, save: saveCloudWorkspace };
type CloudSessionIO = {
  getIdentity: typeof getCloudIdentity;
  getContext: typeof getCloudGymContext;
  ensureOwnerGym: typeof ensureOwnerGym;
  loadWorkspace: typeof loadCloudWorkspace;
  recordAuditEvent: typeof recordCloudAuditEvent;
};
const defaultCloudSessionIO: CloudSessionIO = {
  getIdentity: getCloudIdentity,
  getContext: getCloudGymContext,
  ensureOwnerGym,
  loadWorkspace: loadCloudWorkspace,
  recordAuditEvent: recordCloudAuditEvent,
};
let cloudSessionIO: CloudSessionIO = defaultCloudSessionIO;
let cloudSessionIOIsTestOverride = false;
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

function notifySyncStatus() {
  if (!isBrowser()) return;
  window.dispatchEvent(
    new CustomEvent("ironvault:cloud-sync-status", {
      detail: {
        pending: cloudSyncPending,
        online: window.navigator.onLine,
        offlineSession: currentSession?.offlineMode === true,
        message: cloudSyncMessage,
      },
    }),
  );
}

function queueOfflineWorkspaceSave(): Promise<void> {
  if (
    !isTauri() ||
    !state ||
    !currentSession?.cloudUserId ||
    !cloudGymId ||
    cloudRevision === null
  ) {
    return Promise.resolve();
  }

  const record: OfflineWorkspaceRecord = {
    schemaVersion: 1,
    ownerId: currentSession.cloudUserId,
    gymId: cloudGymId,
    revision: cloudRevision,
    state: structuredClone(state),
    ...(cloudSyncedState ? { baseState: structuredClone(cloudSyncedState) } : {}),
    session: {
      email: currentSession.email,
      role: currentSession.role,
      name: currentSession.name,
      cloudUserId: currentSession.cloudUserId,
      gymId: cloudGymId,
      accountStatus: currentSession.accountStatus,
      subscriptionExpired: currentSession.subscriptionExpired,
      subscriptionStatus: currentSession.subscriptionStatus,
      subscriptionSource: currentSession.subscriptionSource,
      subscriptionCurrentPeriodEnd: currentSession.subscriptionCurrentPeriodEnd,
      permissions: currentSession.permissions,
    },
    syncPending: cloudSyncPending,
    savedAt: new Date().toISOString(),
  };

  offlineCacheQueue = offlineCacheQueue
    .catch(() => undefined)
    .then(() => writeOfflineWorkspace(record))
    .catch((error) => {
      console.error("Unable to save the local offline workspace", error);
      if (isBrowser()) {
        window.dispatchEvent(
          new CustomEvent("ironvault:offline-cache-error", {
            detail: {
              message:
                "This change is still open in the app, but could not be saved for offline use. Keep the app open and check device storage.",
            },
          }),
        );
      }
    });
  return offlineCacheQueue;
}

function cachedWorkspaceIsValid(record: OfflineWorkspaceRecord, ownerId: string): boolean {
  return (
    record.schemaVersion === 1 &&
    record.ownerId === ownerId &&
    record.session?.cloudUserId === ownerId &&
    record.session?.gymId === record.gymId &&
    Number.isInteger(record.revision) &&
    record.revision >= 0 &&
    record.state?.version === 1 &&
    Array.isArray(record.state.members) &&
    Array.isArray(record.state.plans) &&
    Array.isArray(record.state.memberships) &&
    Array.isArray(record.state.payments) &&
    Array.isArray(record.state.products) &&
    Array.isArray(record.state.sales) &&
    Boolean(record.state.settings) &&
    isMergeableWorkspace(record.state) &&
    (record.baseState === undefined || isMergeableWorkspace(record.baseState))
  );
}

function flushCloudSave(nextState: GymState, notifyOnError = true): Promise<boolean> {
  if (!cloudOwnerId || cloudRevision === null) return Promise.resolve(true);
  const ownerId = cloudOwnerId;
  const gymId = cloudGymId;
  cloudSyncPending = true;
  let saved = false;
  const queuedSave = cloudSaveQueue.then(async () => {
    if (cloudOwnerId !== ownerId || cloudGymId !== gymId || cloudRevision === null) return;
    let saveState = nextState;
    let rebaseAttempts = 0;
    let failureMessage = "Your latest change could not be saved. Check your connection and retry.";

    // Compare-and-swap conflicts are common when the same gym is open in two
    // tabs. Rebase independent edits onto the newer server snapshot and retry
    // a bounded number of times; overlapping edits are preserved locally and
    // surfaced instead of silently overwriting either copy.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const activeIdentity = await cloudSessionIO.getIdentity().catch(() => null);
      if (
        activeIdentity?.id !== ownerId ||
        cloudOwnerId !== ownerId ||
        cloudGymId !== gymId ||
        cloudRevision === null
      ) {
        return;
      }
      const expectedRevision = cloudRevision;
      try {
        const nextRevision = await cloudWorkspaceIO.save(saveState, expectedRevision);
        // A request can outlive the session/workspace that created it. Never let
        // its response move another account's optimistic-lock cursor backward.
        if (
          cloudOwnerId !== ownerId ||
          cloudGymId !== gymId ||
          cloudRevision !== expectedRevision
        ) {
          return;
        }
        cloudRevision = nextRevision;
        cloudSyncedState = stateFromCloudWorkspace(saveState);
        cloudSyncMessage = null;
        saved = true;
        if (state === saveState) {
          cloudSyncPending = false;
          if (currentSession) currentSession = { ...currentSession, offlineMode: false };
        }
        await queueOfflineWorkspaceSave();
        notifySyncStatus();
        return;
      } catch (error) {
        if (
          cloudOwnerId !== ownerId ||
          cloudGymId !== gymId ||
          cloudRevision !== expectedRevision
        ) {
          return;
        }

        // A network can drop the response after Supabase has committed the RPC.
        // Confirm the exact saved business payload before treating it as done.
        const latest = await cloudWorkspaceIO.load().catch(() => null);
        if (
          latest?.gymId === gymId &&
          isMergeableWorkspace(latest.state) &&
          latest.revision > expectedRevision &&
          persistedWorkspaceMatches(latest.state, saveState) &&
          cloudOwnerId === ownerId &&
          cloudGymId === gymId &&
          cloudRevision === expectedRevision
        ) {
          cloudRevision = latest.revision;
          cloudSyncedState = stateFromCloudWorkspace(latest.state);
          cloudSyncMessage = null;
          saved = true;
          if (state === saveState) {
            cloudSyncPending = false;
            if (currentSession) currentSession = { ...currentSession, offlineMode: false };
          }
          await queueOfflineWorkspaceSave();
          notifySyncStatus();
          return;
        }

        if (
          latest?.gymId === gymId &&
          isMergeableWorkspace(latest.state) &&
          latest.revision > expectedRevision &&
          cloudOwnerId === ownerId &&
          cloudGymId === gymId &&
          cloudRevision === expectedRevision
        ) {
          const base = cloudSyncedState;
          const latestState = stateFromCloudWorkspace(latest.state);
          const localState = state ?? saveState;
          const merged = base ? mergeWorkspaceStates(base, localState, latestState) : null;
          if (merged?.state) {
            cloudRevision = latest.revision;
            cloudSyncedState = structuredClone(latestState);
            cloudSyncMessage = null;
            if (persistedWorkspaceMatches(merged.state, latestState)) {
              cloudSyncPending = false;
              if (currentSession) currentSession = { ...currentSession, offlineMode: false };
              replaceState(merged.state, false);
              saved = true;
              await queueOfflineWorkspaceSave();
              notifySyncStatus();
              return;
            }

            cloudSyncPending = true;
            replaceState(merged.state, false);
            saveState = merged.state;
            rebaseAttempts += 1;
            await queueOfflineWorkspaceSave();
            continue;
          }

          const reasons = merged?.conflicts ?? ["the local recovery baseline is unavailable"];
          failureMessage = `Another tab or device changed overlapping data (${reasons.slice(0, 3).join(", ")}). Your device copy is preserved. Export a backup before resolving this conflict.`;
          cloudSyncMessage = failureMessage;
        } else {
          cloudSyncMessage = null;
        }

        console.error("Unable to sync the gym workspace to Supabase", error);
        break;
      }
    }

    if (!saved) {
      if (rebaseAttempts >= 3) {
        failureMessage =
          "This gym kept changing in another tab or device. Your device copy is preserved; close other editing tabs, then retry.";
        cloudSyncMessage = failureMessage;
      }
      if (notifyOnError && isBrowser()) {
        window.dispatchEvent(
          new CustomEvent("ironvault:cloud-sync-error", {
            detail: { message: failureMessage },
          }),
        );
      }
      void queueOfflineWorkspaceSave();
      notifySyncStatus();
    }
  });
  cloudSaveQueue = queuedSave;
  return queuedSave.then(() => saved);
}

async function flushPendingCloudWritesForOwner(ownerId: string): Promise<boolean> {
  if (cloudOwnerId !== ownerId || !state || cloudRevision === null) return false;
  const gymId = cloudGymId;

  // Cancel a not-yet-started debounce and flush the latest snapshot below.
  // If another edit arrives while the existing request settles, its new timer
  // is left intact and this function refuses to reload over that edit.
  if (cloudSaveTimer) {
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer = null;
  }

  // First let an already-running save settle. If its response is stale or a
  // newer local edit appeared while waiting, do not reload over that state.
  await cloudSaveQueue;
  if (cloudOwnerId !== ownerId || cloudGymId !== gymId || cloudSaveTimer) return false;
  if (!cloudSyncPending) return true;

  const pendingState = state;
  const saved = await flushCloudSave(pendingState);
  await cloudSaveQueue;
  return (
    saved &&
    cloudOwnerId === ownerId &&
    cloudGymId === gymId &&
    !cloudSaveTimer &&
    !cloudSyncPending
  );
}

function scheduleCloudSave(nextState: GymState) {
  if (!cloudOwnerId || cloudRevision === null) return;
  cloudSyncPending = true;
  void queueOfflineWorkspaceSave();
  notifySyncStatus();
  if (isBrowser() && !window.navigator.onLine) return;
  const ownerId = cloudOwnerId;
  if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(() => {
    cloudSaveTimer = null;
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
    } else if (currentSession?.offlineMode) {
      void completeCloudLogin().catch((error) => {
        console.warn("Could not revalidate the offline desktop session", error);
      });
    }
    notifySyncStatus();
  });
  window.addEventListener("offline", notifySyncStatus);
}

function emit() {
  listeners.forEach((l) => l());
}

function replaceState(nextState: GymState, syncCloud = true) {
  state = nextState;
  configureCalendarSystem(state.settings.calendarSystem);
  if (syncCloud) scheduleCloudSave(state);
  else void queueOfflineWorkspaceSave();
  notifySyncStatus();
  emit();
}

function readOnlyWriteMessage() {
  if (
    currentSession?.accountStatus === "suspended" ||
    currentSession?.accountStatus === "archived"
  ) {
    return "This gym account is suspended. Your existing records are available in read-only mode.";
  }
  if (currentSession?.accountStatus === "pending") {
    return "This gym account is awaiting approval and is currently read-only.";
  }
  if (currentSession?.subscriptionExpired) {
    return "Your Pro subscription has expired. Existing data is safe and available in read-only mode. Renew to make changes.";
  }
  return null;
}

function setState(updater: (s: GymState) => GymState): boolean {
  if (!state) throw new Error("Gym workspace is not loaded.");
  const blockedMessage = readOnlyWriteMessage();
  if (blockedMessage) {
    if (isBrowser()) {
      window.dispatchEvent(
        new CustomEvent("ironvault:cloud-sync-error", { detail: { message: blockedMessage } }),
      );
    }
    return false;
  }
  replaceState(updater(state));
  return true;
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
export function __setStateForLogicTests(next: GymState, session: CurrentSession | null = null) {
  if (typeof process === "undefined" || process.env.IRONVAULT_LOGIC_TESTS !== "1") {
    throw new Error("Test state injection is disabled.");
  }
  state = structuredClone(next);
  configureCalendarSystem(state.settings.calendarSystem);
  currentSession = session ? { ...session } : null;
  cloudOwnerId = null;
  cloudGymId = null;
  cloudRevision = null;
  cloudSyncedState = null;
  if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
  cloudSaveTimer = null;
  cloudSaveQueue = Promise.resolve();
  cloudSyncPending = false;
  cloudSyncMessage = null;
  cloudWorkspaceIO = { load: loadCloudWorkspace, save: saveCloudWorkspace };
  cloudSessionIO = defaultCloudSessionIO;
  cloudSessionIOIsTestOverride = false;
  emit();
}

/** Test-only cloud adapter injection for deterministic sync/race coverage. */
export function __setCloudWorkspaceIOForLogicTests(input: {
  ownerId: string;
  gymId: string;
  revision: number;
  load: () => Promise<CloudWorkspace | null>;
  save: (nextState: GymState, expectedRevision: number) => Promise<number>;
}) {
  if (typeof process === "undefined" || process.env.IRONVAULT_LOGIC_TESTS !== "1") {
    throw new Error("Cloud test adapter injection is disabled.");
  }
  cloudOwnerId = input.ownerId;
  cloudGymId = input.gymId;
  cloudRevision = input.revision;
  cloudSyncedState = state ? structuredClone(state) : null;
  cloudWorkspaceIO = { load: input.load, save: input.save };
  cloudSessionIO = {
    ...defaultCloudSessionIO,
    getIdentity: async () => ({
      id: input.ownerId,
      email: "qa-owner@example.test",
      name: "QA Owner",
      gymName: "QA Gym",
    }),
  };
  cloudSaveQueue = Promise.resolve();
  cloudSyncPending = false;
  cloudSyncMessage = null;
  if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
  cloudSaveTimer = null;
}

/** Test-only session adapter for pending-save/login race coverage. */
export function __setCloudSessionIOForLogicTests(input: CloudSessionIO) {
  if (typeof process === "undefined" || process.env.IRONVAULT_LOGIC_TESTS !== "1") {
    throw new Error("Cloud session test adapter injection is disabled.");
  }
  cloudSessionIO = input;
  cloudSessionIOIsTestOverride = true;
}

function stateFromCloudWorkspace(cloudState: GymState): GymState {
  return {
    ...cloudState,
    expenses: (cloudState.expenses ?? []).map((expense) => ({
      ...expense,
      locked: expense.locked !== false,
    })),
    inquiries: cloudState.inquiries ?? [],
    staff: sanitizedStaff(cloudState.staff),
  };
}

/** Pull a newer workspace revision from Supabase without overwriting local edits. */
export async function refreshCloudWorkspaceIfNewer() {
  if (
    !cloudOwnerId ||
    !cloudGymId ||
    cloudRevision === null ||
    !state ||
    !isBrowser() ||
    !window.navigator.onLine ||
    cloudSaveTimer ||
    cloudSyncPending
  ) {
    return false;
  }

  const ownerAtStart = cloudOwnerId;
  const gymAtStart = cloudGymId;
  const revisionAtStart = cloudRevision;
  const stateAtStart = state;
  const latest = await cloudWorkspaceIO.load();

  // The request may finish after a sign-out, workspace switch, or local edit.
  // In those cases leave the current copy untouched.
  if (
    cloudOwnerId !== ownerAtStart ||
    cloudGymId !== gymAtStart ||
    cloudRevision !== revisionAtStart ||
    state !== stateAtStart ||
    cloudSaveTimer ||
    cloudSyncPending ||
    !latest ||
    latest.gymId !== gymAtStart ||
    latest.revision <= revisionAtStart
  ) {
    return false;
  }

  cloudRevision = latest.revision;
  cloudSyncedState = stateFromCloudWorkspace(latest.state);
  cloudSyncMessage = null;
  replaceState(cloudSyncedState, false);
  return true;
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

export function logout() {
  void logoutSecurely().catch((error) => console.error("Could not complete sign out", error));
}

// Wait for pending changes and revoke the cloud session before returning to login.
export async function logoutSecurely() {
  const hasPendingCloudSave = Boolean(cloudSaveTimer) || cloudSyncPending;
  if (cloudSaveTimer) {
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer = null;
  }
  if (cloudOwnerId && state && cloudRevision !== null && hasPendingCloudSave) {
    const saved = await flushCloudSave(state);
    await cloudSaveQueue;
    if (!saved) {
      throw new Error(
        "Your latest gym changes could not be saved. Check your connection and try again before signing out.",
      );
    }
  }
  if (cloudOwnerId) {
    await recordCloudAuditEvent("logout").catch(() => undefined);
  }
  await signOutFromCloud();
  state = null;
  currentSession = null;
  cloudOwnerId = null;
  cloudGymId = null;
  cloudRevision = null;
  cloudSyncedState = null;
  cloudSyncPending = false;
  cloudSyncMessage = null;
  cloudSaveQueue = Promise.resolve();
  emit();
}

export async function completeCloudLogin() {
  if (!isBrowser() || (!isSupabaseConfigured() && !cloudSessionIOIsTestOverride)) return false;
  const identity = await cloudSessionIO.getIdentity();
  if (!identity) return false;

  const ownerAtStart = cloudOwnerId;
  const gymAtStart = cloudGymId;
  const hadPendingCloudSave = Boolean(
    state && cloudRevision !== null && (cloudSaveTimer || cloudSyncPending),
  );
  const sameOwner = ownerAtStart === identity.id;

  // An account switch must not send the previous gym's queued data using the
  // newly authenticated user's token, nor silently discard those unsynced edits.
  if (!sameOwner && hadPendingCloudSave) {
    if (cloudSaveTimer) {
      clearTimeout(cloudSaveTimer);
      cloudSaveTimer = null;
    }
    await queueOfflineWorkspaceSave();
    throw new Error(
      "Your previous gym still has unsynchronized changes. Sign back into that gym and sync them before switching accounts; no workspace data was replaced.",
    );
  }

  let context = await cloudSessionIO.getContext();
  if (!context) {
    // A confirmed user without a membership is a newly registered gym owner.
    // Tenant id is generated server-side; the browser never supplies it.
    const fresh = newWorkspace(identity.email, identity.name, identity.gymName);
    context = await cloudSessionIO.ensureOwnerGym(identity.gymName, fresh);
  }
  if (!context.enabled) throw new Error("This staff account has been disabled by the gym owner.");

  // Auth can change while the gym-context request is in flight. Do not bind a
  // stale response to the next account's session or workspace.
  const confirmedIdentity = await cloudSessionIO.getIdentity();
  if (!confirmedIdentity || confirmedIdentity.id !== identity.id) return false;

  if (sameOwner && hadPendingCloudSave && context.gymId !== gymAtStart) {
    if (cloudSaveTimer) {
      clearTimeout(cloudSaveTimer);
      cloudSaveTimer = null;
    }
    await queueOfflineWorkspaceSave();
    throw new Error(
      "Gym access changed while local changes were pending. The existing workspace was kept on this device; sign back into its gym before continuing.",
    );
  }

  if (sameOwner && hadPendingCloudSave) {
    const synchronized = await flushPendingCloudWritesForOwner(identity.id);
    const stillAuthenticated = await cloudSessionIO.getIdentity();
    if (!stillAuthenticated || stillAuthenticated.id !== identity.id) return false;
    if (!synchronized) {
      // A failed or superseded save is not permission to replace local state
      // with an older server snapshot during route validation.
      currentSession = sessionForCloudContext(identity, context);
      setGymSubscriptionSnapshot({
        status: currentSession.subscriptionStatus ?? "free",
        source: currentSession.subscriptionSource ?? null,
        currentPeriodEnd: currentSession.subscriptionCurrentPeriodEnd ?? null,
      });
      window.dispatchEvent(
        new CustomEvent("ironvault:cloud-sync-error", {
          detail: {
            message:
              cloudSyncMessage ??
              "Your latest gym changes are still on this device and could not be confirmed in the cloud. The app kept them open instead of replacing them with older data.",
          },
        }),
      );
      await cloudSessionIO.recordAuditEvent("login").catch(() => undefined);
      notifySyncStatus();
      emit();
      return true;
    }
  }

  if (cloudSaveTimer) {
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer = null;
  }
  cloudOwnerId = identity.id;
  const workspace = await cloudSessionIO.loadWorkspace();
  if (workspace?.state?.version === 1) {
    const cached = isTauri()
      ? await readOfflineWorkspace(identity.id).catch(() => null)
      : null;
    const resumePendingOfflineChanges = Boolean(
      cached &&
        cachedWorkspaceIsValid(cached, identity.id) &&
        cached.gymId === workspace.gymId &&
        cached.syncPending,
    );
    const serverState = stateFromCloudWorkspace(workspace.state);
    const cloudState = resumePendingOfflineChanges ? cached!.state : serverState;
    state = stateFromCloudWorkspace(cloudState);
    cloudRevision = resumePendingOfflineChanges ? cached!.revision : workspace.revision;
    cloudGymId = workspace.gymId;
    cloudSyncPending = resumePendingOfflineChanges;
    cloudSyncedState = resumePendingOfflineChanges
      ? cached!.baseState
        ? isMergeableWorkspace(cached!.baseState)
          ? stateFromCloudWorkspace(cached!.baseState)
          : null
        : cached!.revision === workspace.revision
          ? structuredClone(serverState)
          : null
      : structuredClone(serverState);
    cloudSyncMessage = null;
    configureCalendarSystem(state.settings.calendarSystem);

    // One-time migration for legacy inline photos/receipts. Persisted cloud
    // workspaces must reference private Storage objects instead of embedding
    // member PII/documents as base64 JSON.
    if (context.role === "owner" && !resumePendingOfflineChanges) {
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
          cloudSyncedState = stateFromCloudWorkspace(migratedState);
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
            cloudSyncedState = stateFromCloudWorkspace(latest.state);
            cloudSyncMessage = null;
            configureCalendarSystem(state.settings.calendarSystem);
          }
        } else {
          await Promise.all(
            uploadedPaths.map((path) => deletePrivateAsset(path).catch(() => undefined)),
          );
        }
        // Legacy files remain available in the loaded workspace and migration
        // can be retried at the next sign-in. It must not prevent gym access.
        console.warn("Could not migrate legacy private files during sign-in", error);
      }
    }
  } else {
    throw new Error("Your gym workspace could not be loaded.");
  }

  currentSession = sessionForCloudContext(identity, context);
  setGymSubscriptionSnapshot({
    status: currentSession.subscriptionStatus ?? "free",
    source: currentSession.subscriptionSource ?? null,
    currentPeriodEnd: currentSession.subscriptionCurrentPeriodEnd ?? null,
  });
  if (cloudSyncPending && state) {
    const saved = await flushCloudSave(state, false);
    if (!saved) {
      window.dispatchEvent(
        new CustomEvent("ironvault:cloud-sync-error", {
          detail: {
            message:
              "Your offline changes are still saved on this device, but the cloud workspace changed while you were away. Sync was stopped to avoid overwriting newer data. Export a backup before resolving the conflict.",
          },
        }),
      );
    }
  } else {
    cloudSyncPending = false;
    void queueOfflineWorkspaceSave();
  }
  await cloudSessionIO.recordAuditEvent("login").catch(() => undefined);
  notifySyncStatus();
  emit();
  return true;
}

export function isLoggedIn() {
  return currentSession !== null;
}

export async function validateCurrentSession() {
  if (!isBrowser()) return false;
  if (!isSupabaseConfigured()) return false;
  if (!window.navigator.onLine && currentSession) {
    return Boolean(
      state &&
      cloudRevision !== null &&
      cloudOwnerId === currentSession.cloudUserId &&
      cloudGymId === currentSession.gymId,
    );
  }
  if (!window.navigator.onLine) return restoreOfflineSession();
  try {
    return await completeCloudLogin();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const isConnectivityFailure =
      error instanceof TypeError ||
      /fetch|network|offline|timeout|connection|load failed/i.test(message) ||
      (error instanceof Error && /FetchError|NetworkError/i.test(error.name));
    if (isTauri() && isConnectivityFailure && (await restoreOfflineSession())) return true;
    throw error;
  }
}

async function restoreOfflineSession(): Promise<boolean> {
  if (!isTauri() || !isBrowser() || !isSupabaseConfigured()) return false;
  const identity = await getCachedCloudIdentity().catch(() => null);
  if (!identity?.id) return false;
  const cached = await readOfflineWorkspace(identity.id).catch((error) => {
    console.warn("The saved offline gym workspace could not be opened", error);
    return null;
  });
  if (!cached || !cachedWorkspaceIsValid(cached, identity.id)) return false;

  state = stateFromCloudWorkspace(cached.state);
  cloudOwnerId = identity.id;
  cloudGymId = cached.gymId;
  cloudRevision = cached.revision;
  cloudSyncedState = cached.syncPending
    ? cached.baseState && isMergeableWorkspace(cached.baseState)
      ? stateFromCloudWorkspace(cached.baseState)
      : null
    : stateFromCloudWorkspace(cached.state);
  cloudSyncPending = cached.syncPending;
  cloudSyncMessage = null;
  currentSession = { ...cached.session, offlineMode: true };
  setGymSubscriptionSnapshot({
    status: currentSession.subscriptionStatus ?? "free",
    source: currentSession.subscriptionSource ?? null,
    currentPeriodEnd: currentSession.subscriptionCurrentPeriodEnd ?? null,
  });
  configureCalendarSystem(state.settings.calendarSystem);
  installOnlineSync();
  notifySyncStatus();
  emit();
  return true;
}

export type CurrentSession = {
  email: string;
  role: "admin" | "receptionist";
  name: string;
  cloudUserId?: string;
  gymId?: string;
  accountStatus?: "pending" | "active" | "suspended" | "archived";
  subscriptionExpired?: boolean;
  subscriptionStatus?: "free" | "active" | "past_due" | "canceled" | "expired";
  subscriptionSource?: "stripe" | "razorpay" | "recharge" | "manual" | null;
  subscriptionCurrentPeriodEnd?: string | null;
  permissions?: ReceptionistPermissions;
  offlineMode?: boolean;
};

function sessionForCloudContext(
  identity: NonNullable<Awaited<ReturnType<typeof getCloudIdentity>>>,
  context: NonNullable<Awaited<ReturnType<typeof getCloudGymContext>>>,
): CurrentSession {
  const role = context.role === "owner" ? "admin" : "receptionist";
  const permissions =
    role === "receptionist"
      ? { ...DEFAULT_RECEPTIONIST_PERMISSIONS, ...context.permissions }
      : undefined;
  return {
    email: identity.email.toLowerCase(),
    role,
    cloudUserId: identity.id,
    gymId: context.gymId,
    accountStatus: context.accountStatus,
    subscriptionExpired: context.subscriptionExpired,
    subscriptionStatus: context.subscriptionStatus,
    subscriptionSource: context.subscriptionSource,
    subscriptionCurrentPeriodEnd: context.subscriptionCurrentPeriodEnd,
    name: context.displayName || (role === "admin" ? identity.name : "Receptionist"),
    permissions,
    offlineMode: false,
  };
}

export function getCloudSyncStatus() {
  return {
    pending: cloudSyncPending,
    online: isBrowser() ? window.navigator.onLine : false,
    offlineSession: currentSession?.offlineMode === true,
    message: cloudSyncMessage,
  };
}

/** Keep the browser from silently discarding workspace edits awaiting cloud sync. */
export function guardPendingCloudChangesBeforeUnload(
  event: Pick<BeforeUnloadEvent, "preventDefault" | "returnValue">,
) {
  if (!cloudSyncPending) return false;
  event.preventDefault();
  event.returnValue = "";
  return true;
}

const TEMPLATE_DATA_KEYS = [
  "members",
  "plans",
  "memberships",
  "payments",
  "products",
  "sales",
  "activities",
  "expenses",
  "inquiries",
  "readNotifications",
  "invoiceSeq",
] as const satisfies readonly (keyof GymState)[];

/**
 * Migration links outlive workspace template resets. Seed IDs such as `mem_1`
 * must therefore not be reused for a later template generation, or the CEO
 * migration ledger will correctly mistake the new sample member for a profile
 * that was already transferred. Keep every in-workspace relationship intact
 * while assigning fresh source-member identities to the replacement roster.
 */
function freshTemplateMemberIds(template: GymState): GymState {
  const memberIds = new Map(template.members.map((member) => [member.id, uid("mem")]));
  const remapMemberId = (memberId: string | null | undefined) =>
    memberId == null ? memberId : (memberIds.get(memberId) ?? memberId);

  return {
    ...template,
    members: template.members.map((member) => ({
      ...member,
      id: memberIds.get(member.id)!,
    })),
    memberships: template.memberships.map((membership) => ({
      ...membership,
      memberId: remapMemberId(membership.memberId)!,
    })),
    payments: template.payments.map((payment) => ({
      ...payment,
      memberId: remapMemberId(payment.memberId),
    })),
    sales: template.sales.map((sale) => ({
      ...sale,
      memberId: remapMemberId(sale.memberId),
    })),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function persistedWorkspaceMatches(left: GymState, right: GymState): boolean {
  return CLOUD_PERSISTED_DATA_KEYS.every((key) => stableJson(left[key]) === stableJson(right[key]));
}

function isMergeableWorkspace(value: unknown): value is GymState {
  if (!isPlainRecord(value) || value.version !== 1 || !isPlainRecord(value.settings)) return false;
  return (
    [
      "members",
      "plans",
      "memberships",
      "payments",
      "products",
      "sales",
      "activities",
      "expenses",
      "inquiries",
      "readNotifications",
    ].every((key) => Array.isArray(value[key])) && Number.isSafeInteger(value.invoiceSeq)
  );
}

type WorkspaceMergeResult = { state: GymState; conflicts: [] } | { state: null; conflicts: string[] };
type ValueMergeResult = { value: unknown; conflicts: string[] };

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return stableJson(left) === stableJson(right);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mergeThreeWayValue(
  base: unknown,
  local: unknown,
  remote: unknown,
  path: string,
): ValueMergeResult {
  if (valuesEqual(local, base)) return { value: remote, conflicts: [] };
  if (valuesEqual(remote, base)) return { value: local, conflicts: [] };
  if (valuesEqual(local, remote)) return { value: local, conflicts: [] };

  if (isPlainRecord(base) && isPlainRecord(local) && isPlainRecord(remote)) {
    const value: Record<string, unknown> = {};
    const conflicts: string[] = [];
    const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
    for (const key of keys) {
      const result = mergeThreeWayValue(base[key], local[key], remote[key], `${path}.${key}`);
      if (result.value !== undefined) value[key] = result.value;
      conflicts.push(...result.conflicts);
    }
    return { value, conflicts };
  }

  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)) {
    const arrays = [base, local, remote];
    const areIdArrays = arrays.every((items) =>
      items.every((item) => isPlainRecord(item) && typeof item.id === "string"),
    );
    if (areIdArrays) {
      const toMap = (items: unknown[]) =>
        new Map(
          (items as Array<Record<string, unknown>>).map((item) => [item.id as string, item]),
        );
      const maps = arrays.map(toMap);
      if (maps.some((map, index) => map.size !== arrays[index]!.length)) {
        return { value: remote, conflicts: [`${path} (duplicate record id)`] };
      }
      const baseById = maps[0]!;
      const localById = maps[1]!;
      const remoteById = maps[2]!;
      const orderedIds = [
        ...remote.map((item) => (item as { id: string }).id),
        ...local.map((item) => (item as { id: string }).id),
        ...base.map((item) => (item as { id: string }).id),
      ];
      const value: unknown[] = [];
      const conflicts: string[] = [];
      for (const id of new Set(orderedIds)) {
        const result = mergeThreeWayValue(
          baseById.get(id),
          localById.get(id),
          remoteById.get(id),
          `${path}[${id}]`,
        );
        if (result.value !== undefined) value.push(result.value);
        conflicts.push(...result.conflicts);
      }
      return { value, conflicts };
    }

    // Read-notification IDs are a set in the application. Concurrent marking
    // as read is monotonic, so union is safe only when neither side removed an
    // existing ID (template reset/removal still produces a conflict).
    const baseValues = new Set(base);
    if (
      [...baseValues].every((item) => local.includes(item) && remote.includes(item))
    ) {
      return { value: Array.from(new Set([...remote, ...local])), conflicts: [] };
    }
  }

  return { value: remote, conflicts: [path] };
}

function workspaceRelationshipIssues(workspace: GymState): string[] {
  const memberIds = new Set(workspace.members.map((member) => member.id));
  const planIds = new Set(workspace.plans.map((plan) => plan.id));
  const membershipIds = new Set(workspace.memberships.map((membership) => membership.id));
  const saleIds = new Set(workspace.sales.map((sale) => sale.id));
  const issues: string[] = [];

  for (const membership of workspace.memberships) {
    if (!memberIds.has(membership.memberId)) issues.push(`membership:${membership.id}:member`);
    if (!planIds.has(membership.planId)) issues.push(`membership:${membership.id}:plan`);
  }
  for (const payment of workspace.payments) {
    if (payment.memberId && !memberIds.has(payment.memberId)) issues.push(`payment:${payment.id}:member`);
    if (payment.membershipId && !membershipIds.has(payment.membershipId)) {
      issues.push(`payment:${payment.id}:membership`);
    }
    if (payment.saleId && !saleIds.has(payment.saleId)) issues.push(`payment:${payment.id}:sale`);
  }
  for (const sale of workspace.sales) {
    if (sale.memberId && !memberIds.has(sale.memberId)) issues.push(`sale:${sale.id}:member`);
  }
  return issues;
}

function mergeWorkspaceStates(
  base: GymState,
  local: GymState,
  remote: GymState,
): WorkspaceMergeResult {
  if (![base, local, remote].every(isMergeableWorkspace)) {
    return { state: null, conflicts: ["workspace structure"] };
  }
  const mergedData: Partial<GymState> = {};
  const conflicts: string[] = [];
  for (const key of CLOUD_PERSISTED_DATA_KEYS) {
    const result = mergeThreeWayValue(base[key], local[key], remote[key], key);
    (mergedData as Record<string, unknown>)[key] = result.value;
    conflicts.push(...result.conflicts);
  }

  if (conflicts.length) return { state: null, conflicts };

  // Auth credentials are never part of the cloud workspace payload. The
  // server-returned staff record is authoritative because it is managed via a
  // separate, protected operation rather than the workspace revision.
  const state: GymState = { ...remote, ...mergedData, auth: local.auth, staff: remote.staff };
  const previouslyExistingIssues = new Set([
    ...workspaceRelationshipIssues(base),
    ...workspaceRelationshipIssues(local),
    ...workspaceRelationshipIssues(remote),
  ]);
  const introducedIssues = workspaceRelationshipIssues(state).filter(
    (issue) => !previouslyExistingIssues.has(issue),
  );
  if (introducedIssues.length) {
    return {
      state: null,
      conflicts: [`related records (${introducedIssues.slice(0, 3).join(", ")})`],
    };
  }
  return { state, conflicts: [] };
}

function hasSameTemplateBusinessData(left: GymState, right: GymState): boolean {
  return TEMPLATE_DATA_KEYS.every((key) => stableJson(left[key]) === stableJson(right[key]));
}

export async function retryCloudSync() {
  if (!isBrowser() || !window.navigator.onLine) return false;
  if (!currentSession || !state) return false;
  const authenticated = await completeCloudLogin();
  return authenticated && !cloudSyncPending;
}

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
  void queueOfflineWorkspaceSave();
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
  const currentState = getState();
  if (!canAddRegularMember(currentState)) return false;

  if (input.planId) {
    const plan = currentState.plans.find((item) => item.id === input.planId && !item.deletedAt);
    if (!plan) return false;
    try {
      const price = normalizeMoney(plan.price);
      const discount = Math.min(Math.max(0, normalizeMoney(input.discount ?? 0)), price);
      const joiningFee = Math.max(
        0,
        normalizeMoney(input.joiningFee ?? plan.joiningFee ?? 1000),
      );
      addMoney(subtractMoney(price, discount), joiningFee);
      normalizeMoney(input.paidNow ?? 0);
    } catch {
      return false;
    }
  }

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
          discount: Math.min(
            Math.max(0, normalizeMoney(input.discount ?? 0)),
            normalizeMoney(plan.price),
          ),
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
  if (!getState().members.some((member) => member.id === id)) return false;
  const saved = setState((st) => {
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
  if (!saved) return false;
  auditCloud("member_updated", "member", id);
  return true;
}

export function trashMember(id: string, by: string) {
  if (!getState().members.some((member) => member.id === id && !member.deletedAt)) return false;
  const saved = setState((st) => {
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
  if (!saved) return false;
  auditCloud("member_deleted", "member", id, { soft_delete: true });
  return true;
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
  if (!memberToRestore?.deletedAt) return false;
  return setState((st) => {
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
  if (!getState().members.some((member) => member.id === id && member.deletedAt)) return false;
  const saved = setState((st) => {
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
  if (!saved) return false;
  auditCloud("member_deleted", "member", id, { permanent: true });
  return true;
}

export function addNote(memberId: string, title: string, note: string) {
  const member = getState().members.find((item) => item.id === memberId && !item.deletedAt);
  if (!member || !title.trim() || !note.trim()) return false;
  return setState((st) => ({
    ...st,
    members: st.members.map((m) =>
      m.id === memberId
        ? { ...m, notes: [{ id: uid("note"), date: iso(new Date()), title, note }, ...m.notes] }
        : m,
    ),
  }));
}

export function updateNote(
  memberId: string,
  noteId: string,
  patch: { title: string; note: string },
) {
  if (!getState().members.some((member) => member.id === memberId && member.notes.some((entry) => entry.id === noteId))) return false;
  return setState((st) => ({
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
  if (!getState().members.some((member) => member.id === memberId && member.notes.some((entry) => entry.id === noteId))) return false;
  return setState((st) => ({
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
  if (!getState().members.some((member) => member.id === memberId && !member.deletedAt)) return false;
  return setState((st) => ({
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
  if (!getState().members.some((member) => member.id === memberId && member.measurements.some((entry) => entry.id === measurementId))) return false;
  return setState((st) => ({
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
  if (!getState().members.some((member) => member.id === memberId && member.measurements.some((entry) => entry.id === measurementId))) return false;
  return setState((st) => ({
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
  if (
    plan.name.trim().length < 2 ||
    plan.name.trim().length > 60 ||
    !isPositiveMoneyAmount(plan.price) ||
    !isSafeMoneyAmount(plan.joiningFee ?? 0) ||
    (plan.joiningFee ?? 0) < 0 ||
    !isSafeMoneySum(plan.price, plan.joiningFee ?? 0) ||
    !Number.isSafeInteger(plan.durationDays) ||
    plan.durationDays <= 0
  ) {
    return false;
  }

  const normalizedPlan = {
    ...plan,
    price: normalizeMoney(plan.price),
    joiningFee: normalizeMoney(plan.joiningFee ?? 0),
  };
  if (normalizedPlan.id && !getState().plans.some((item) => item.id === normalizedPlan.id)) return false;
  return setState((st) =>
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
  return trashPlan(id);
}

export function trashPlan(id: string) {
  const plan = getState().plans.find((item) => item.id === id);
  if (!plan || plan.deletedAt || plan.locked) return false;
  return setState((st) => ({
    ...st,
    plans: st.plans.map((p) =>
      p.id === id && !p.locked ? { ...p, deletedAt: iso(new Date()) } : p,
    ),
  }));
}

export function restorePlan(id: string) {
  if (!getState().plans.some((plan) => plan.id === id && plan.deletedAt)) return false;
  return setState((st) => ({
    ...st,
    plans: st.plans.map((p) => (p.id === id ? { ...p, deletedAt: null } : p)),
  }));
}

export function deletePlanPermanently(id: string) {
  const current = getState();
  const plan = current.plans.find((item) => item.id === id);
  if (!plan?.deletedAt || plan.locked) return false;
  const inUse = current.memberships.some((membership) => membership.planId === id);
  if (inUse) return false;
  return setState((st) => ({ ...st, plans: st.plans.filter((p) => p.id !== id) }));
}

export function renewMembership(
  memberId: string,
  planId: string,
  paidNow: number,
  discount = 0,
  paymentMethod: Payment["method"] = "cash",
  startDate?: string,
) {
  const before = getState();
  const selectedPlan = before.plans.find((item) => item.id === planId && !item.deletedAt);
  const selectedMember = before.members.find(
    (item) => item.id === memberId && !item.deletedAt && item.type !== "walk_in",
  );
  const requestedStart = startDate ? parseCalendarDate(startDate) : undefined;
  if (
    !selectedPlan ||
    !selectedMember ||
    !isPositiveMoneyAmount(selectedPlan.price) ||
    !isSafeMoneyAmount(paidNow) ||
    !isSafeMoneyAmount(discount) ||
    (startDate !== undefined &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
        !requestedStart ||
        !Number.isFinite(requestedStart.getTime()))) ||
    (startDate !== undefined && before.memberships.some((item) => item.memberId === memberId))
  ) {
    return false;
  }

  let renewedMembershipId = "";
  const saved = setState((st) => {
    const plan = st.plans.find((p) => p.id === planId);
    const member = st.members.find((m) => m.id === memberId);
    if (!plan || !member) return st;
    const history = st.memberships.filter((m) => m.memberId === memberId);
    if (startDate !== undefined && history.length > 0) return st;
    const isFirstAssignment = history.length === 0;
    const current = history.sort((a, b) => +new Date(b.endDate) - +new Date(a.endDate))[0];
    const base =
      requestedStart ??
      (current && new Date(current.endDate) > new Date() ? new Date(current.endDate) : new Date());
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
      isFirstAssignment ? "Membership assigned" : "Membership renewed",
      `${member.name} ${isFirstAssignment ? "started" : "renewed"} ${plan.name} · ${plan.durationDays} days`,
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
            note: `${plan.name} — ${isFirstAssignment ? "joining" : "renewal"} payment`,
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
  if (!saved || !renewedMembershipId) return false;
  auditCloud("membership_renewed", "membership", renewedMembershipId, { member_id: memberId });
  return true;
}

export function toggleFreeze(membershipId: string) {
  if (!getState().memberships.some((membership) => membership.id === membershipId)) return false;
  return setState((st) => ({
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
  if (!isPositiveMoneyAmount(input.amount)) return false;
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
  const saved = setState((st) => {
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
  if (!saved || !paymentId) return false;
  auditCloud("payment_created", "payment", paymentId, {
    member_id: input.memberId,
    amount,
  });
  return true;
}

/** Records a standalone walk-in payment without creating a gym member or membership. */
export function addCustomerPayment(input: {
  payerName: string;
  payerPhone?: string;
  payerEmail?: string;
  amount: number;
  method: Payment["method"];
  note?: string;
}) {
  const payerName = input.payerName.trim();
  const rawPhone = input.payerPhone?.trim() ?? "";
  const rawEmail = input.payerEmail?.trim() ?? "";
  const phoneDigits = rawPhone.replace(/\D/g, "");
  const email = rawEmail.toLowerCase();
  if (
    payerName.length < 2 ||
    payerName.length > 80 ||
    !isPositiveMoneyAmount(input.amount) ||
    (rawPhone && (phoneDigits.length < 7 || phoneDigits.length > 15)) ||
    (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
  ) {
    return false;
  }
  let paymentId = "";
  const amount = normalizeMoney(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const saved = setState((st) => {
    const [withSeq, invoiceNo] = nextInvoice(st);
    const payment: Payment = {
      id: uid("pay"),
      invoiceNo,
      kind: "other",
      payerName,
      payerPhone: rawPhone || undefined,
      payerEmail: email || undefined,
      amount,
      method: input.method,
      date: iso(new Date()),
      note: input.note?.trim().slice(0, 120) || "Walk-in customer payment",
    };
    paymentId = payment.id;
    let next: GymState = { ...withSeq, payments: [payment, ...withSeq.payments] };
    next = log(
      next,
      "payment_received",
      "Customer payment received",
      `${invoiceNo} · ₹${amount.toLocaleString("en-IN")}`,
    );
    next = log(
      next,
      "invoice_generated",
      "Invoice generated",
      `${invoiceNo} created · ₹${amount.toLocaleString("en-IN")}`,
    );
    return next;
  });
  if (!saved || !paymentId) return false;
  auditCloud("payment_created", "payment", paymentId, { amount, payer_type: "walk_in" });
  return true;
}

export function addSalePayment(
  saleId: string,
  amountInput: number,
  method: Payment["method"],
  note?: string,
) {
  if (!isPositiveMoneyAmount(amountInput)) return false;
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
  const saved = setState((st) => {
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
  if (!saved || !paymentId) return false;
  auditCloud("payment_created", "payment", paymentId, { sale_id: sale.id, amount });
  return true;
}

/* ------------------------------------------------------------------ */
/* Products & sales                                                    */
/* ------------------------------------------------------------------ */

export function saveProduct(product: Omit<Product, "id" | "createdAt"> & { id?: string }) {
  if (
    product.name.trim().length < 2 ||
    product.name.trim().length > 60 ||
    !isSafeMoneyAmount(product.cost) ||
    product.cost < 0 ||
    !isPositiveMoneyAmount(product.price) ||
    !Number.isSafeInteger(product.stock) ||
    product.stock < 0 ||
    !Number.isSafeInteger(product.lowStockAt) ||
    product.lowStockAt < 0
  ) {
    return false;
  }

  const normalizedProduct = {
    ...product,
    cost: normalizeMoney(product.cost),
    price: normalizeMoney(product.price),
    stock: Math.max(0, Math.trunc(product.stock)),
    lowStockAt: Math.max(0, Math.trunc(product.lowStockAt)),
  };
  if (normalizedProduct.id && !getState().products.some((item) => item.id === normalizedProduct.id)) return false;
  return setState((st) => {
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
  return trashProduct(id);
}

export function trashProduct(id: string) {
  const current = getState().products.find((product) => product.id === id);
  if (!current || current.deletedAt || current.locked) return false;
  return setState((st) => ({
    ...st,
    products: st.products.map((p) =>
      p.id === id && !p.locked ? { ...p, deletedAt: iso(new Date()) } : p,
    ),
  }));
}

export function restoreProduct(id: string) {
  if (!getState().products.some((product) => product.id === id && product.deletedAt)) return false;
  return setState((st) => ({
    ...st,
    products: st.products.map((p) => (p.id === id ? { ...p, deletedAt: null } : p)),
  }));
}

export function deleteProductPermanently(id: string) {
  if (
    !getState().products.some(
      (product) => product.id === id && product.deletedAt && !product.locked,
    )
  )
    return false;
  return setState((st) => ({ ...st, products: st.products.filter((p) => p.id !== id) }));
}

export function adjustStock(id: string, delta: number) {
  if (!Number.isSafeInteger(delta)) return false;
  let adjusted = false;
  const saved = setState((st) => ({
    ...st,
    products: st.products.map((p) => {
      if (p.id !== id || !Number.isSafeInteger(p.stock) || p.stock < 0) return p;
      const stock = Math.max(0, p.stock + delta);
      if (!Number.isSafeInteger(stock)) return p;
      adjusted = true;
      return { ...p, stock };
    }),
  }));
  return saved && adjusted;
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
    if (
      !product ||
      !isPositiveMoneyAmount(product.price) ||
      !isSafeMoneyAmount(product.cost) ||
      product.cost < 0 ||
      !Number.isSafeInteger(product.stock) ||
      product.stock < 0 ||
      qty <= 0 ||
      !Number.isSafeInteger(qty) ||
      product.stock < qty ||
      !Number.isSafeInteger(Math.round(product.price * 100) * qty) ||
      (extra?.discount !== undefined && (!isSafeMoneyAmount(extra.discount) || extra.discount < 0)) ||
      (extra?.amountPaid !== undefined && (!isSafeMoneyAmount(extra.amountPaid) || extra.amountPaid < 0))
    ) {
      return st;
    }
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
  return Boolean(completedSaleId);
}

/* ------------------------------------------------------------------ */
/* Settings, notifications, backup                                     */
/* ------------------------------------------------------------------ */

export function updateSettings(patch: Partial<Settings>) {
  const saved = setState((st) => {
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
  if (saved)
    auditCloud("settings_updated", "settings", cloudGymId ?? "gym", {
      fields: Object.keys(patch).join(","),
    });
  return saved;
}

export function markNotificationsRead(ids: string[]) {
  return setState((st) => ({
    ...st,
    // Notifications are generated from the current roster, so busy gyms can
    // have far more than 500 active alerts. Capping this list leaves older
    // alerts unread after “Mark all read” even though the save succeeds.
    readNotifications: Array.from(new Set([...st.readNotifications, ...ids])),
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

  const restored = setState(() => ({
    ...parsed,
    expenses,
    inquiries,
    staff: sanitizedStaff(parsed.staff),
    version: 1,
  }));
  if (!restored) return false;
  auditCloud("backup_restored", "workspace", cloudGymId ?? "gym");
  return true;
}

export function resetData() {
  return setState((st) => ({
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
  const blockedMessage = readOnlyWriteMessage();
  if (blockedMessage) throw new Error(blockedMessage);

  let previous = getState();
  const ownerAtStart = cloudOwnerId;
  const offline = isBrowser() && !window.navigator.onLine;
  const hadPendingCloudSave = Boolean(cloudSaveTimer) || cloudSyncPending;

  // Flush pending edits before replacing business data, so the template save
  // uses the latest optimistic-lock revision and never silently loses work.
  if (cloudSaveTimer) {
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer = null;
  }
  if (cloudOwnerId && cloudRevision !== null && hadPendingCloudSave && !offline) {
    const saved = await flushCloudSave(previous, false);
    if (!saved) {
      throw new Error(
        "Your current changes could not be saved. Check your connection and try again.",
      );
    }
  }
  if (state !== previous || cloudOwnerId !== ownerAtStart) {
    throw new Error("Your workspace changed while setting up. Please try again.");
  }

  // Confirm the server revision immediately before this replacement. The gym
  // may have been edited from another open tab/device since this page loaded.
  // Use that newest state as the rollback point and the revision for the
  // template save; otherwise a stale tab can make the reset appear to succeed
  // locally and then lose the template when the next route reloads Supabase.
  if (cloudOwnerId && !offline) {
    if (cloudRevision === null || cloudGymId === null) {
      throw new Error("Your cloud workspace is still loading. Refresh the page and try again.");
    }
    let latest: CloudWorkspace | null;
    try {
      latest = await cloudWorkspaceIO.load();
    } catch {
      throw new Error(
        "We could not verify your latest gym data. Check your connection and try again.",
      );
    }
    if (state !== previous || cloudOwnerId !== ownerAtStart) {
      throw new Error("Your workspace changed while setting up. Please try again.");
    }
    if (!latest || latest.gymId !== cloudGymId || latest.revision < cloudRevision) {
      throw new Error(
        "Your latest gym data could not be confirmed. Refresh the page and try again.",
      );
    }
    if (latest.revision > cloudRevision) {
      previous = stateFromCloudWorkspace(latest.state);
      cloudRevision = latest.revision;
      cloudSyncedState = stateFromCloudWorkspace(latest.state);
      cloudSyncMessage = null;
      replaceState(previous, false);
    }
  }

  // Free workspaces get a representative starter dataset within their roster
  // allowance. Pro workspaces retain the complete demo dataset.
  const template = freshTemplateMemberIds(
    buildSeed(getSubscriptionSnapshot().active ? undefined : FREE_MEMBER_LIMIT),
  );
  const nextState: GymState = {
    ...template,
    auth: previous.auth,
    settings: previous.settings,
    staff: previous.staff,
  };

  const blockedBeforeCommit = readOnlyWriteMessage();
  if (blockedBeforeCommit) throw new Error(blockedBeforeCommit);

  replaceState(nextState, offline);

  if (offline) {
    // Keep the confirmed template replacement on this device and queue its
    // full workspace snapshot for the next successful connection.
    cloudSyncPending = true;
    notifySyncStatus();
    await queueOfflineWorkspaceSave();
    return true;
  }

  if (cloudOwnerId && cloudRevision !== null) {
    const saved = await flushCloudSave(nextState, false);
    if (!saved) {
      // Restore the server's latest revision when possible. If the request
      // failed offline, keep the last known good workspace in memory.
      const latest = await cloudWorkspaceIO.load().catch(() => null);
      if (latest && cloudOwnerId === ownerAtStart) {
        const latestState = stateFromCloudWorkspace(latest.state);
        replaceState(latestState, false);
        cloudRevision = latest.revision;
        cloudGymId = latest.gymId;
        cloudSyncedState = structuredClone(latestState);
        cloudSyncPending = false;
        cloudSyncMessage = null;
        if (hasSameTemplateBusinessData(latestState, nextState)) {
          // A lost HTTP response can follow a committed database transaction.
          // Treat the operation as successful when the server confirms the
          // exact replacement payload, rather than showing a false failure.
          void queueOfflineWorkspaceSave();
          notifySyncStatus();
          return true;
        }
      } else if (state === nextState) {
        replaceState(previous, false);
        cloudSyncPending = false;
        void queueOfflineWorkspaceSave();
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
  const name = input.name.trim();
  const phone = input.phone.trim();
  if (name.length < 2 || name.length > 100 || !phone) return false;
  let inquiryId = "";
  const saved = setState((st) => {
    const now = iso(new Date());
    const inquiry: Inquiry = {
      id: uid("inq"),
      name,
      phone: phoneForCountry(phone, st.settings.phoneCountry),
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
    inquiryId = inquiry.id;
    return log(
      { ...st, inquiries: [inquiry, ...(st.inquiries ?? [])] },
      "inquiry_added",
      "New inquiry",
      `${inquiry.name} added as a ${inquiry.priority} lead`,
    );
  });
  return saved && Boolean(inquiryId);
}

export function updateInquiry(id: string, patch: Partial<InquiryInput>) {
  if (!(getState().inquiries ?? []).some((inquiry) => inquiry.id === id)) return false;
  const saved = setState((st) => {
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
  if (!saved) return false;
  auditCloud("inquiry_updated", "inquiry", id);
  return true;
}

export function deleteInquiry(id: string) {
  if (!(getState().inquiries ?? []).some((inquiry) => inquiry.id === id)) return false;
  return setState((st) => {
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
  if (!isPositiveMoneyAmount(input.amount)) return false;
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
    auditCloud("expense_created", "expense", expenseId, {
      amount: Math.max(0, Math.round(input.amount)),
    });
  return Boolean(expenseId);
}

export function updateExpense(id: string, patch: Partial<ExpenseInput>) {
  if (patch.amount !== undefined && !isPositiveMoneyAmount(patch.amount)) {
    return false;
  }
  if (!(getState().expenses ?? []).some((expense) => expense.id === id)) return false;
  const saved = setState((st) => {
    const next: GymState = {
      ...st,
      expenses: (st.expenses ?? []).map((e) =>
        e.id === id
          ? {
              ...e,
              ...patch,
              title: patch.title !== undefined ? patch.title.trim() : e.title,
              amount:
                patch.amount !== undefined ? Math.max(0, normalizeMoney(patch.amount)) : e.amount,
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
  if (!saved) return false;
  auditCloud("expense_updated", "expense", id);
  return true;
}

export function trashExpense(id: string) {
  const existing = (getState().expenses ?? []).find((expense) => expense.id === id);
  if (!existing || existing.deletedAt || existing.locked !== false) return false;
  return setState((st) => {
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
}

export function restoreExpense(id: string) {
  if (!(getState().expenses ?? []).some((expense) => expense.id === id && expense.deletedAt)) return false;
  return setState((st) => ({
    ...st,
    expenses: (st.expenses ?? []).map((e) => (e.id === id ? { ...e, deletedAt: null } : e)),
  }));
}

export function deleteExpensePermanently(id: string) {
  const existing = (getState().expenses ?? []).find((expense) => expense.id === id);
  if (!existing?.deletedAt || existing.locked !== false) return false;
  return setState((st) => ({ ...st, expenses: (st.expenses ?? []).filter((e) => e.id !== id) }));
}
