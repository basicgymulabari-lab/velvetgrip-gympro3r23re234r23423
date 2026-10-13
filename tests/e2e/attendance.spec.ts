import { expect, test, type Page, type Route } from "@playwright/test";
import { newWorkspace } from "../../src/lib/gym/new-workspace";

const gymUser = {
  id: "e5000000-0000-0000-0000-000000000001",
  aud: "authenticated",
  role: "authenticated",
  email: "attendance-test@example.invalid",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { full_name: "Attendance Test", gym_name: "Attendance QA Gym" },
  identities: [],
  created_at: "2026-01-01T00:00:00.000Z",
};

const gymContext = {
  gym_id: "e5000000-0000-0000-0000-000000000002",
  role: "owner",
  permissions: {},
  display_name: "Attendance Test",
  email: gymUser.email,
  enabled: true,
  gym_name: "Attendance QA Gym",
  account_status: "active",
  subscription_status: "active",
  subscription_source: "manual",
  subscription_current_period_end: "2099-01-01T00:00:00.000Z",
  subscription_expired: false,
};

const member = {
  id: "attendance-member-1",
  type: "member" as const,
  name: "Aarati Attendance QA",
  email: "aarati@example.invalid",
  phone: "9812345678",
  gender: "female" as const,
  dob: "1995-01-01",
  address: "",
  joinDate: "2026-01-01",
  emergencyContact: "",
  notes: [],
  measurements: [],
  deletedAt: null,
};

function testToken() {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    sub: gymUser.id,
    aud: "authenticated",
    role: "authenticated",
    email: gymUser.email,
    exp: 4102444800,
    iat: 1791763200,
    app_metadata: gymUser.app_metadata,
    user_metadata: gymUser.user_metadata,
  })}.test-signature`;
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockGymBackend(page: Page, startWithAttendanceOutage = false) {
  const workspace = newWorkspace(gymUser.email, "Attendance Test", "Attendance QA Gym");
  workspace.members.push(member);
  const attendanceRows: Array<{
    id: string;
    gym_id: string;
    member_id: string;
    attendance_date: string;
    checked_in_at: string;
    checked_in_by: string;
  }> = [];
  let checkInRequests = 0;
  let allowAttendanceReads = !startWithAttendanceOutage;

  await page.route("**/auth/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/token")) {
      return json(route, {
        access_token: testToken(),
        token_type: "bearer",
        expires_in: 3600,
        expires_at: 4102444800,
        refresh_token: "attendance-test-refresh-token",
        user: gymUser,
      });
    }
    if (path.endsWith("/user")) return json(route, gymUser);
    return json(route, { message: "Unexpected auth request in attendance test." }, 404);
  });

  await page.route("**/rest/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/rpc/get_current_gym_context")) return json(route, gymContext);
    if (path.endsWith("/rpc/load_current_gym_workspace")) {
      return json(route, { ...gymContext, state: workspace, revision: 1 });
    }
    if (path.endsWith("/rpc/save_current_gym_workspace")) return json(route, { revision: 2 });
    if (path.endsWith("/rpc/record_audit_event")) return json(route, null);
    if (path.endsWith("/gym_users")) {
      return json(route, { display_name: "", email: "", enabled: false, permissions: {} });
    }
    if (path.endsWith("/gym_member_attendance")) {
      if (!allowAttendanceReads) {
        return json(route, { message: "Synthetic attendance read outage" }, 503);
      }
      const dateFilter = url.searchParams.get("attendance_date")?.replace(/^eq\./, "");
      return json(
        route,
        attendanceRows.filter((row) => row.attendance_date === dateFilter),
      );
    }
    if (path.endsWith("/rpc/record_current_member_attendance")) {
      checkInRequests += 1;
      const input = route.request().postDataJSON() as {
        p_member_id: string;
        p_attendance_date: string;
      };
      const existing = attendanceRows.find(
        (row) =>
          row.member_id === input.p_member_id && row.attendance_date === input.p_attendance_date,
      );
      if (existing) return json(route, { ...existing, status: "already_checked_in" });
      const record = {
        id: `attendance-row-${attendanceRows.length + 1}`,
        gym_id: gymContext.gym_id,
        member_id: input.p_member_id,
        attendance_date: input.p_attendance_date,
        checked_in_at: new Date().toISOString(),
        checked_in_by: gymUser.id,
      };
      attendanceRows.unshift(record);
      return json(route, { ...record, status: "checked_in" });
    }
    return json(route, {}, 404);
  });

  await page.addInitScript((email) => {
    localStorage.setItem(`ironvault.app-tour.v1.${email.toLowerCase()}`, "done");
  }, gymUser.email);

  return {
    checkInRequestCount: () => checkInRequests,
    allowAttendanceReads: () => {
      allowAttendanceReads = true;
    },
  };
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(gymUser.email);
  await page.getByRole("textbox", { name: "Password" }).fill("attendance-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe("member attendance (synthetic Supabase backend)", () => {
  test("records a one-tap check-in and prevents duplicate check-ins", async ({ page }) => {
    await page.clock.install({ time: new Date(2026, 9, 13, 12) });
    const backend = await mockGymBackend(page);
    await signIn(page);
    await page.goto("/attendance");

    await expect(page.getByRole("heading", { name: "Attendance", exact: true })).toBeVisible();
    await expect(page.getByText("No attendance recorded")).toBeVisible();
    await page.getByRole("textbox", { name: "Search current members" }).fill("Aarati");
    await expect(page.getByText("Aarati Attendance QA").first()).toBeVisible();
    await page.getByRole("button", { name: "Check in", exact: true }).click();

    await expect(page.getByRole("button", { name: "Checked in", exact: true })).toBeDisabled();
    await expect(page.getByText("Aarati Attendance QA").last()).toBeVisible();
    expect(backend.checkInRequestCount()).toBe(1);

    await page.getByRole("button", { name: "Checked in", exact: true }).click({ force: true });
    expect(backend.checkInRequestCount()).toBe(1);
  });

  test("shows a retry action instead of presenting a failed read as an empty day", async ({
    page,
  }) => {
    await page.clock.install({ time: new Date(2026, 9, 13, 12) });
    const backend = await mockGymBackend(page, true);
    await signIn(page);
    await page.goto("/attendance");

    await expect(page.getByRole("alert")).toContainText("Attendance could not be loaded");
    await expect(page.getByText("No attendance recorded")).toHaveCount(0);
    backend.allowAttendanceReads();
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText("No attendance recorded")).toBeVisible();
  });
});
