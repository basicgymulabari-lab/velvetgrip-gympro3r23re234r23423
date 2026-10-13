import { expect, test, type Page, type Route } from "@playwright/test";

const ceoUser = {
  id: "e1000000-0000-0000-0000-000000000001",
  aud: "authenticated",
  role: "authenticated",
  email: "ceo-test@example.invalid",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: {},
  factors: [],
  identities: [],
  created_at: "2026-01-01T00:00:00.000Z",
};

const auditEvents = [
  {
    id: 12,
    admin_email: "ceo-test@example.invalid",
    gym_id: "e2000000-0000-0000-0000-000000000001",
    gym_name: "Alpha Gym",
    action: "gym_status_changed",
    result: "success",
    metadata: { private_note: "Excluded from the export" },
    created_at: "2026-10-12T12:00:00.000Z",
    total_count: 2,
  },
  {
    id: 11,
    admin_email: "ceo-test@example.invalid",
    gym_id: "e2000000-0000-0000-0000-000000000002",
    gym_name: "=HYPERLINK(\"https://example.invalid\",\"Formula Gym\")",
    action: "backup_created",
    result: "success",
    metadata: { private_note: "Excluded from the export" },
    created_at: "2026-10-11T12:00:00.000Z",
    total_count: 2,
  },
];

function testToken() {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    sub: ceoUser.id,
    aud: "authenticated",
    role: "authenticated",
    email: ceoUser.email,
    exp: 4102444800,
    iat: 1791763200,
    aal: "aal1",
    app_metadata: ceoUser.app_metadata,
    user_metadata: {},
  })}.test-signature`;
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockSupabase(page: Page, failFirstAuditLoad = false) {
  let auditRequestCount = 0;
  const token = testToken();
  await page.route("https://release-center-test.supabase.co/**", async (route) => {
    const { pathname } = new URL(route.request().url());

    if (pathname.endsWith("/auth/v1/token")) {
      return json(route, {
        access_token: token,
        token_type: "bearer",
        expires_in: 3600,
        expires_at: 4102444800,
        refresh_token: "ceo-audit-test-refresh-token",
        user: ceoUser,
      });
    }
    if (pathname.endsWith("/auth/v1/user")) return json(route, ceoUser);
    if (pathname.endsWith("/auth/v1/factors")) return json(route, { all: [], totp: [], phone: [] });
    if (pathname.endsWith("/auth/v1/logout")) return route.fulfill({ status: 204, body: "" });
    if (pathname.endsWith("/rest/v1/rpc/iv_is_platform_admin")) return json(route, true);
    if (pathname.endsWith("/rest/v1/rpc/platform_dashboard_summary")) return json(route, {});
    if (pathname.endsWith("/rest/v1/rpc/platform_list_gyms")) return json(route, []);
    if (pathname.endsWith("/rest/v1/rpc/platform_list_audit_logs")) {
      auditRequestCount += 1;
      if (failFirstAuditLoad && auditRequestCount <= 2) {
        return json(route, { message: "temporary test outage" }, 503);
      }
      return json(route, auditEvents);
    }
    return json(route, {}, 404);
  });
}

async function openAuditLog(page: Page) {
  await page.goto("/ceo");
  await expect(page.getByRole("heading", { name: "CEO sign in" })).toBeVisible();
  await page.getByRole("textbox", { name: "Platform-owner email" }).fill(ceoUser.email);
  await page.getByRole("textbox", { name: "Password" }).fill("mock-only-password");
  await page.getByRole("button", { name: "Sign in to CEO console" }).click();
  await expect(page.getByRole("heading", { name: "Company operations" })).toBeVisible();
  await page.getByRole("button", { name: "Dashboard & gyms" }).click();
  await page.getByRole("button", { name: "Audit log", exact: true }).click();
}

test.describe("CEO platform audit improvements (mocked backend; no live data)", () => {
  test("filters visible events and exports safe CSV without private metadata", async ({ page }) => {
    await mockSupabase(page);
    await openAuditLog(page);

    await expect(page.getByText("gym status changed")).toBeVisible();
    await expect(page.getByText("backup created")).toBeVisible();
    await page.getByRole("textbox", { name: "Search visible audit events" }).fill("Formula Gym");
    await expect(page.getByText("gym status changed")).toHaveCount(0);
    await expect(page.getByText("backup created")).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export visible events (1)" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^platform-audit-page-1-\d{4}-\d{2}-\d{2}\.csv$/);
    const stream = await download.createReadStream();
    if (!stream) throw new Error("Expected an exported CSV download stream.");
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const csv = Buffer.concat(chunks).toString("utf8");
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).not.toContain("Excluded from the export");
  });

  test("shows a retryable failure instead of a false empty-state when loading the audit log fails", async ({ page }) => {
    await mockSupabase(page, true);
    await openAuditLog(page);

    await expect(page.getByRole("alert")).toContainText("Platform activity could not be loaded");
    await expect(page.getByText("No audit events have been recorded.")).toHaveCount(0);
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText("gym status changed")).toBeVisible();
  });
});
