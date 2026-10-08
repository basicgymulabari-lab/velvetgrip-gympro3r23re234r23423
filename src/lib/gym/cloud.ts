import { isSupabaseConfigured, supabase } from "../../integrations/supabase/client";
import type { Json } from "../../integrations/supabase/types";
import type { GymState, ReceptionistPermissions } from "./types";

export type CloudGymRole = "owner" | "receptionist";

export type CloudGymContext = {
  gymId: string;
  role: CloudGymRole;
  permissions: Partial<ReceptionistPermissions>;
  displayName: string;
  email: string;
  enabled: boolean;
  gymName: string;
  accountStatus: "pending" | "active" | "suspended" | "archived";
  subscriptionExpired: boolean;
};

export type CloudWorkspace = CloudGymContext & {
  state: GymState;
  revision: number;
};

type JsonRecord = Record<string, unknown>;

const asRecord = (value: unknown): JsonRecord | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;

const permissionsFrom = (value: unknown): Partial<ReceptionistPermissions> => {
  const record = asRecord(value);
  if (!record) return {};
  const result: Partial<ReceptionistPermissions> = {};
  for (const key of [
    "dashboard",
    "members",
    "memberships",
    "payments",
    "products",
    "viewProductCost",
    "expenses",
    "reports",
    "inquiries",
    "notifications",
    "trash",
    "viewRevenue",
  ] as const) {
    if (typeof record[key] === "boolean") result[key] = record[key] as never;
  }
  return result;
};

const DEFAULT_CLOUD_RECEPTIONIST_PERMISSIONS: ReceptionistPermissions = {
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

function contextFrom(value: unknown): CloudGymContext | null {
  const row = asRecord(value);
  if (!row || typeof row.gym_id !== "string") return null;
  if (row.role !== "owner" && row.role !== "receptionist") return null;
  return {
    gymId: row.gym_id,
    role: row.role,
    permissions: permissionsFrom(row.permissions),
    displayName: typeof row.display_name === "string" ? row.display_name : "",
    email: typeof row.email === "string" ? row.email : "",
    enabled: row.enabled !== false,
    gymName: typeof row.gym_name === "string" ? row.gym_name : "My Gym",
    accountStatus:
      row.account_status === "pending" ||
      row.account_status === "suspended" ||
      row.account_status === "archived"
        ? row.account_status
        : "active",
    subscriptionExpired: row.subscription_expired === true,
  };
}

export async function getCloudIdentity() {
  if (!isSupabaseConfigured()) return null;
  const { data, error } = await supabase.auth.getUser();
  if (error) {
    if (error.name === "AuthSessionMissingError") return null;
    throw error;
  }
  if (!data.user) return null;
  return {
    id: data.user.id,
    email: data.user.email ?? "",
    name: String(data.user.user_metadata?.full_name ?? "Gym Owner"),
    gymName: String(data.user.user_metadata?.gym_name ?? "My Gym"),
  };
}

export async function getCloudGymContext(): Promise<CloudGymContext | null> {
  const { data, error } = await supabase.rpc("get_current_gym_context");
  if (error) throw error;
  return contextFrom(data);
}

export async function ensureOwnerGym(
  gymName: string,
  initialState: GymState,
): Promise<CloudGymContext> {
  const { data, error } = await supabase.rpc("ensure_owner_gym", {
    p_name: gymName,
    p_initial_state: initialState as unknown as Json,
  });
  if (error) throw error;
  const context = contextFrom(data);
  if (!context) throw new Error("Gym workspace could not be created.");
  return context;
}

async function ownerReceptionist(gymId: string) {
  const { data, error } = await supabase
    .from("gym_users")
    .select("display_name,email,enabled,permissions")
    .eq("gym_id", gymId)
    .eq("role", "receptionist")
    .maybeSingle();
  if (error) throw error;
  if (!data) return undefined;
  return {
    enabled: data.enabled,
    name: data.display_name || "Receptionist",
    email: data.email,
    passwordHash: "cloud-managed",
    permissions: {
      ...DEFAULT_CLOUD_RECEPTIONIST_PERMISSIONS,
      ...permissionsFrom(data.permissions),
    },
  };
}

export async function loadCloudWorkspace(): Promise<CloudWorkspace | null> {
  const { data, error } = await supabase.rpc("load_current_gym_workspace");
  if (error) throw error;
  const row = asRecord(data);
  if (!row) return null;
  const context = contextFrom(row);
  const workspace = asRecord(row.state);
  const revision = typeof row.revision === "number" ? row.revision : Number(row.revision);
  if (!context || !workspace || !Number.isFinite(revision)) return null;
  const next = workspace as unknown as GymState;
  if (context.role === "owner") {
    const receptionist = await ownerReceptionist(context.gymId);
    next.staff = receptionist ? { receptionist } : {};
  } else {
    next.staff = {};
  }
  return { ...context, state: next, revision };
}

export async function saveCloudWorkspace(state: GymState, expectedRevision: number) {
  const { data, error } = await supabase.rpc("save_current_gym_workspace", {
    p_state: state as unknown as Json,
    p_expected_revision: expectedRevision,
  });
  if (error) throw error;
  const row = asRecord(data);
  const revision = typeof row?.revision === "number" ? row.revision : Number(row?.revision);
  if (!Number.isFinite(revision)) throw new Error("Workspace save did not return a revision.");
  return revision;
}

export async function recordCloudAuditEvent(
  action: string,
  entityType?: string,
  entityId?: string,
  metadata: Record<string, Json> = {},
) {
  const { error } = await supabase.rpc("record_audit_event", {
    p_action: action,
    p_entity_type: entityType ?? null,
    p_entity_id: entityId ?? null,
    p_metadata: metadata,
  });
  if (error) throw error;
}

export async function signInWithGoogle() {
  return supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${window.location.origin}/login` },
  });
}

export async function signOutFromCloud() {
  if (!isSupabaseConfigured()) return { error: null };
  const result = await supabase.auth.signOut({ scope: "local" });
  if (result.error) throw result.error;
  return result;
}
