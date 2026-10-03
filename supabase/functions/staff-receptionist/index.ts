import { admin, consumeRateLimit, requireOwner, writeAudit } from "../_shared/auth.ts";
import { errorResponse, HttpError, jsonResponse, optionsResponse, parseJson } from "../_shared/http.ts";

const PERMISSION_KEYS = [
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
] as const;

function normalizePermissions(value: unknown) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(PERMISSION_KEYS.map((key) => [key, input[key] === true]));
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return optionsResponse(request);
  if (request.method !== "POST") return jsonResponse(request, { error: "Method not allowed" }, 405);

  try {
    const { user: owner, membership } = await requireOwner(request);
    await consumeRateLimit("staff:receptionist-update", owner.id, 12, 60);
    const body = await parseJson<Record<string, unknown>>(request);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const enabled = body.enabled !== false;
    const permissions = normalizePermissions(body.permissions);

    if (name.length < 2 || name.length > 120) throw new HttpError("Enter a valid receptionist name.", 400, "INVALID_NAME");
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 320) throw new HttpError("Enter a valid receptionist email.", 400, "INVALID_EMAIL");
    if (password && password.length < 12) throw new HttpError("Receptionist passwords must be at least 12 characters.", 400, "WEAK_PASSWORD");
    if (email === (owner.email ?? "").toLowerCase()) throw new HttpError("Use an email different from the gym owner account.", 400, "EMAIL_CONFLICT");

    const { data: existing, error: lookupError } = await admin
      .from("gym_users")
      .select("user_id,email")
      .eq("gym_id", membership.gym_id)
      .eq("role", "receptionist")
      .maybeSingle();
    if (lookupError) throw new HttpError("Could not load the receptionist account.", 502, "STAFF_LOOKUP_FAILED");

    let staffUserId = existing?.user_id ?? "";
    let createdUser = false;
    if (staffUserId) {
      const attributes: {
        email: string;
        password?: string;
        email_confirm: boolean;
        user_metadata: Record<string, string>;
      } = {
        email,
        email_confirm: true,
        user_metadata: { full_name: name, ironvault_role: "receptionist" },
      };
      if (password) attributes.password = password;
      const { error } = await admin.auth.admin.updateUserById(staffUserId, attributes);
      if (error) throw new HttpError("Could not update the receptionist sign-in account.", 400, "STAFF_AUTH_UPDATE_FAILED");
    } else {
      if (!password) throw new HttpError("Set a password when creating the receptionist account.", 400, "PASSWORD_REQUIRED");
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: name, ironvault_role: "receptionist" },
      });
      if (error || !data.user) {
        throw new HttpError(
          error?.message?.toLowerCase().includes("registered")
            ? "That email is already registered. Use a different staff email."
            : "Could not create the receptionist sign-in account.",
          400,
          "STAFF_AUTH_CREATE_FAILED",
        );
      }
      staffUserId = data.user.id;
      createdUser = true;
    }

    const { error: membershipError } = await admin.from("gym_users").upsert(
      {
        gym_id: membership.gym_id,
        user_id: staffUserId,
        role: "receptionist",
        display_name: name,
        email,
        enabled,
        permissions,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "gym_id,user_id" },
    );
    if (membershipError) {
      if (createdUser) await admin.auth.admin.deleteUser(staffUserId).catch(() => undefined);
      throw new HttpError("Could not save receptionist permissions.", 502, "STAFF_MEMBERSHIP_UPDATE_FAILED");
    }

    await writeAudit({
      gymId: membership.gym_id,
      userId: owner.id,
      role: "owner",
      action: "staff_updated",
      entityType: "staff",
      entityId: staffUserId,
      metadata: {
        enabled,
        permissions,
        email_changed: Boolean(existing && existing.email !== email),
        password_changed: Boolean(password),
      },
    });

    return jsonResponse(request, {
      account: { enabled, name, email, permissions },
    });
  } catch (error) {
    return errorResponse(request, error);
  }
});
