import { supabase } from "../../integrations/supabase/client";
import type { GymState } from "./types";

export async function getCloudIdentity() {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? "" };
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
  return supabase.auth.signOut();
}
