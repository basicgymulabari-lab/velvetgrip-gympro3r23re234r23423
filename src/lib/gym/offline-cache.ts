import type { ReceptionistPermissions, GymState } from "./types";

const DATABASE_NAME = "ironvault-offline-workspaces";
const DATABASE_VERSION = 1;
const WORKSPACE_STORE = "workspaces";

export type OfflineWorkspaceSession = {
  email: string;
  role: "admin" | "receptionist";
  name: string;
  cloudUserId: string;
  gymId: string;
  accountStatus?: "pending" | "active" | "suspended" | "archived";
  subscriptionExpired?: boolean;
  subscriptionStatus?: "free" | "active" | "past_due" | "canceled" | "expired";
  subscriptionSource?: "stripe" | "razorpay" | "recharge" | "manual" | null;
  subscriptionCurrentPeriodEnd?: string | null;
  permissions?: ReceptionistPermissions;
};

export type OfflineWorkspaceRecord = {
  schemaVersion: 1;
  ownerId: string;
  gymId: string;
  revision: number;
  state: GymState;
  /** Last confirmed cloud state used to safely merge edits made while offline. */
  baseState?: GymState;
  session: OfflineWorkspaceSession;
  syncPending: boolean;
  savedAt: string;
};

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("This device does not support offline workspace storage."));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(WORKSPACE_STORE)) {
        database.createObjectStore(WORKSPACE_STORE, { keyPath: "ownerId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Offline storage could not open."));
    request.onblocked = () => reject(new Error("Offline storage is busy. Close other app windows and retry."));
  });
}

export async function readOfflineWorkspace(ownerId: string): Promise<OfflineWorkspaceRecord | null> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(WORKSPACE_STORE, "readonly");
      const request = transaction.objectStore(WORKSPACE_STORE).get(ownerId);
      request.onsuccess = () => resolve((request.result as OfflineWorkspaceRecord | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error("Offline workspace could not be read."));
    });
  } finally {
    database.close();
  }
}

export async function writeOfflineWorkspace(record: OfflineWorkspaceRecord): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(WORKSPACE_STORE, "readwrite");
      transaction.objectStore(WORKSPACE_STORE).put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Offline workspace could not be saved."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Offline workspace save was interrupted."));
    });
  } finally {
    database.close();
  }
}
