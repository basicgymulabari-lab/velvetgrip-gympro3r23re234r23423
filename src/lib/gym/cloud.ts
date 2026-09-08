import { isSupabaseConfigured, supabase } from "../../integrations/supabase/client";
import type { GymState } from "./types";

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

export async function loadCloudState(ownerId: string): Promise<GymState | null> {
  const { data, error } = await supabase
    .from("gym_workspaces")
    .select("state")
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (error) throw error;
  return data?.state as GymState | null;
}

export async function saveCloudState(ownerId: string, state: GymState) {
  const { error } = await supabase.from("gym_workspaces").upsert(
    {
      owner_id: ownerId,
      state,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "owner_id" },
  );
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
