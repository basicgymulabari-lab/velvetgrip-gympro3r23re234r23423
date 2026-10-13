import { expect, test, type Page, type Route } from "@playwright/test";
import { BS_MONTHS, toNepaliDate } from "../../src/lib/gym/calendar";
import { newWorkspace } from "../../src/lib/gym/new-workspace";

const gymUser = {
  id: "e4000000-0000-0000-0000-000000000001",
  aud: "authenticated",
  role: "authenticated",
  email: "membership-date-test@example.invalid",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { full_name: "Membership Date Test", gym_name: "Date QA Gym" },
  identities: [],
  created_at: "2026-01-01T00:00:00.000Z",
};

const gymContext = {
  gym_id: "e4000000-0000-0000-0000-000000000002",
  role: "owner",
  permissions: {},
  display_name: "Membership Date Test",
  email: gymUser.email,
  enabled: true,
  gym_name: "Date QA Gym",
  account_status: "active",
  subscription_status: "active",
  subscription_source: "manual",
  subscription_current_period_end: "2099-01-01T00:00:00.000Z",
  subscription_expired: false,
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

async function mockGymBackend(
  page: Page,
  workspace = newWorkspace(gymUser.email, "Membership Date Test", "Date QA Gym"),
) {
  workspace.settings.calendarSystem = "bikram_sambat";

  await page.route("**/auth/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/token")) {
      return json(route, {
        access_token: testToken(),
        token_type: "bearer",
        expires_in: 3600,
        expires_at: 4102444800,
        refresh_token: "membership-date-test-refresh-token",
        user: gymUser,
      });
    }
    if (path.endsWith("/user")) return json(route, gymUser);
    return json(route, { message: "Unexpected auth request in isolated membership-date test." }, 404);
  });

  await page.route("**/rest/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/rpc/get_current_gym_context")) return json(route, gymContext);
    if (path.endsWith("/rpc/load_current_gym_workspace")) {
      return json(route, { ...gymContext, state: workspace, revision: 1 });
    }
    if (path.endsWith("/rpc/save_current_gym_workspace")) return json(route, { revision: 2 });
    if (path.endsWith("/rpc/record_audit_event")) return json(route, null);
    if (path.endsWith("/gym_users")) {
      return json(route, { display_name: "", email: "", enabled: false, permissions: {} });
    }
    return json(route, {});
  });
}

test("member form allows a backdated membership start in the Bikram Sambat calendar", async ({ page }) => {
  const fixedToday = new Date(2026, 9, 13, 12);
  await page.clock.install({ time: fixedToday });
  await page.addInitScript((email) => {
    localStorage.setItem(`ironvault.app-tour.v1.${email.toLowerCase()}`, "done");
  }, gymUser.email);
  await mockGymBackend(page);

  await page.goto("/login");
  await page.getByLabel("Email address").fill(gymUser.email);
  await page.getByRole("textbox", { name: "Password" }).fill("membership-date-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto("/members");
  await expect(page.getByRole("heading", { name: "Member Management" })).toBeVisible();
  await page.getByRole("button", { name: "Add Member", exact: true }).last().click();
  const dialog = page.getByRole("dialog").last();
  await expect(dialog.getByRole("heading", { name: "Add new member" })).toBeVisible();

  await dialog.getByRole("textbox").first().fill("Backdated QA Member");
  await dialog.getByRole("textbox", { name: /Phone number/ }).first().fill("9812345678");

  const previousDate = new Date(fixedToday);
  previousDate.setDate(previousDate.getDate() - 1);
  const previousBs = toNepaliDate(previousDate).getBS();
  const previousDay = page.getByRole("button", { name: String(previousBs.day), exact: true });

  await dialog.getByRole("button", { name: "Select date of birth" }).click();
  await expect(previousDay).toBeEnabled();
  await previousDay.click();
  await dialog.getByRole("button", { name: "Next", exact: true }).click();

  const startDate = dialog.getByText("Membership start date", { exact: true }).locator("..").getByRole("button");
  await startDate.click();
  const backdateButton = page.getByRole("button", { name: String(previousBs.day), exact: true });
  await expect(backdateButton).toBeEnabled();
  await backdateButton.click();
  await expect(startDate).toContainText(
    `${previousBs.day} ${BS_MONTHS[previousBs.month]} ${previousBs.year}`,
  );
});

test("renewal uses the selected past start date to calculate the new membership term", async ({ page }) => {
  const fixedToday = new Date(2026, 9, 13, 12);
  await page.clock.install({ time: fixedToday });
  await page.addInitScript((email) => {
    localStorage.setItem(`ironvault.app-tour.v1.${email.toLowerCase()}`, "done");
  }, gymUser.email);

  const workspace = newWorkspace(gymUser.email, "Membership Date Test", "Date QA Gym");
  workspace.settings.calendarSystem = "bikram_sambat";
  workspace.members.push({
    id: "renewal-date-member",
    type: "member",
    name: "Renewal Date QA Member",
    email: "",
    phone: "9812345678",
    gender: "other",
    dob: "2000-01-01",
    address: "",
    joinDate: "2020-01-01",
    emergencyContact: "",
    notes: [],
    measurements: [],
    deletedAt: null,
  });
  workspace.plans.push({
    id: "renewal-date-plan",
    name: "QA 30 Day Plan",
    price: 2500,
    joiningFee: 0,
    durationDays: 30,
    description: "Synthetic plan for renewal-date QA.",
    active: true,
    deletedAt: null,
  });
  await mockGymBackend(page, workspace);

  await page.goto("/login");
  await page.getByLabel("Email address").fill(gymUser.email);
  await page.getByRole("textbox", { name: "Password" }).fill("membership-date-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto("/members/renewal-date-member");
  await expect(page.getByRole("heading", { name: "Renewal Date QA Member" })).toBeVisible();
  await page.getByRole("button", { name: "Renew", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").first().click();
  await page.getByRole("option", { name: /QA 30 Day Plan/ }).click();

  const previousDate = new Date(fixedToday);
  previousDate.setDate(previousDate.getDate() - 1);
  const previousBs = toNepaliDate(previousDate).getBS();
  const startDate = dialog
    .getByText("Membership start date", { exact: true })
    .locator("..")
    .getByRole("button");
  await startDate.click();
  const previousDay = page.getByRole("button", { name: String(previousBs.day), exact: true });
  await expect(previousDay).toBeEnabled();
  await previousDay.click();

  await dialog.getByRole("button", { name: "Confirm renewal" }).click();
  const history = page.getByRole("table").getByRole("row").nth(1);
  await expect(history).toContainText("QA 30 Day Plan");
  await expect(history).toContainText(
    `${previousBs.day} ${BS_MONTHS[previousBs.month].slice(0, 3)} ${String(previousBs.year).slice(-2)}`,
  );
});
