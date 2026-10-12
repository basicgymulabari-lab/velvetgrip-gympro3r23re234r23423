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
const controlledInputWarnings = new WeakMap<Page, string[]>();
const releaseStateByPage = new WeakMap<Page, {
  releases: Array<Record<string, unknown>>;
  deletedPaths: string[];
  losePublishReplyAfterCommit: Set<string>;
}>();

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

async function mockSupabase(page: Page) {
  const releases: Array<Record<string, unknown>> = [];
  const deletedPaths: string[] = [];
  const losePublishReplyAfterCommit = new Set<string>();
  releaseStateByPage.set(page, { releases, deletedPaths, losePublishReplyAfterCommit });
  const token = testToken();
  await page.route("https://release-center-test.supabase.co/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();

    if (pathname.endsWith("/auth/v1/token")) {
      return json(route, {
        access_token: token,
        token_type: "bearer",
        expires_in: 3600,
        expires_at: 4102444800,
        refresh_token: "release-center-test-refresh-token",
        user: ceoUser,
      });
    }
    if (pathname.endsWith("/auth/v1/user")) return json(route, ceoUser);
    if (pathname.endsWith("/auth/v1/logout")) return route.fulfill({ status: 204, body: "" });
    if (pathname.endsWith("/rest/v1/rpc/iv_is_platform_admin")) return json(route, true);
    if (pathname.endsWith("/rest/v1/rpc/platform_list_app_releases")) return json(route, releases);
    if (pathname.endsWith("/rest/v1/rpc/platform_publish_app_release")) {
      const args = route.request().postDataJSON() as Record<string, string | null>;
      if (releases.some((item) => item.platform === args.p_platform && item.version === args.p_version)) {
        return json(route, { code: "P0001", message: "APP_RELEASE_VERSION_EXISTS" }, 400);
      }
      const release = {
        id: `e2000000-0000-0000-0000-${String(releases.length + 1).padStart(12, "0")}`,
        platform: args.p_platform,
        version: args.p_version,
        release_notes: args.p_release_notes,
        download_url: args.p_download_url,
        artifact_path: args.p_artifact_path,
        file_name: args.p_file_name,
        status: "published",
        created_by: ceoUser.id,
        created_at: "2026-10-12T12:00:00.000Z",
        published_at: "2026-10-12T12:00:00.000Z",
      };
      releases.unshift(release);
      if (losePublishReplyAfterCommit.has(args.p_version)) {
        return route.abort("failed");
      }
      return json(route, [release]);
    }
    if (pathname.endsWith("/rest/v1/rpc/platform_archive_app_release")) {
      const args = route.request().postDataJSON() as { p_release_id: string };
      const release = releases.find((item) => item.id === args.p_release_id);
      if (!release) return json(route, { code: "P0001", message: "APP_RELEASE_NOT_FOUND" }, 400);
      release.status = "archived";
      return json(route, { id: release.id, platform: release.platform, version: release.version });
    }
    if (pathname.endsWith("/rest/v1/rpc/platform_dashboard_summary")) return json(route, {});
    if (pathname.endsWith("/rest/v1/rpc/platform_list_gyms") || pathname.endsWith("/rest/v1/rpc/platform_list_audit_logs")) return json(route, []);
    if (pathname.startsWith("/storage/v1/object/iv-platform-releases/")) {
      if (method === "DELETE") {
        deletedPaths.push(pathname);
        return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      }
      return json(route, { Key: pathname.replace("/storage/v1/object/", "") });
    }
    return json(route, {}, 404);
  });
}

async function signInAsTestPlatformAdmin(page: Page) {
  await page.goto("/ceo");
  await expect(page.getByRole("heading", { name: "CEO sign in" })).toBeVisible();
  await page.getByRole("textbox", { name: "Platform-owner email" }).fill(ceoUser.email);
  await page.getByRole("textbox", { name: "Password" }).fill("mock-only-password");
  await page.getByRole("button", { name: "Sign in to CEO console" }).click();
  await expect(page.getByRole("heading", { name: "Company operations" })).toBeVisible();
  await page.getByRole("button", { name: /App releases/ }).click();
  await expect(page.getByRole("heading", { name: "Publish an app release" })).toBeVisible();
}

test.describe("CEO app release center (mocked backend; no live data)", () => {
  test.beforeEach(async ({ page }) => {
    const warnings: string[] = [];
    controlledInputWarnings.set(page, warnings);
    page.on("console", async (message) => {
      if (!message.text().includes("uncontrolled input to be controlled")) return;
      warnings.push(message.text());
    });
    await mockSupabase(page);
  });

  test.afterEach(async ({ page }) => {
    expect(controlledInputWarnings.get(page)).toEqual([]);
  });

  test("publishes an Android APK to private storage and shows it in history", async ({ page }) => {
    await signInAsTestPlatformAdmin(page);
    await page.getByRole("combobox", { name: "Platform" }).click();
    await page.getByRole("option", { name: "Android APK" }).click();
    await page.getByLabel("Version").fill("1.2.0");
    await page.getByLabel("Android installer").setInputFiles({
      name: "ironvault.apk",
      mimeType: "application/vnd.android.package-archive",
      buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]),
    });
    await page.getByLabel("Release notes").fill("Fixes member sync and improves offline recovery.");
    await page.getByRole("button", { name: "Publish release" }).click();

    await expect(page.getByText("Android · v1.2.0")).toBeVisible();
    await expect(page.getByText("Fixes member sync and improves offline recovery.")).toBeVisible();
  });

  test("keeps a committed installer when the publish reply is lost", async ({ page }) => {
    await signInAsTestPlatformAdmin(page);
    releaseStateByPage.get(page)?.losePublishReplyAfterCommit.add("1.2.1");
    await page.getByRole("combobox", { name: "Platform" }).click();
    await page.getByRole("option", { name: "Android APK" }).click();
    await page.getByLabel("Version").fill("1.2.1");
    await page.getByLabel("Android installer").setInputFiles({
      name: "ironvault.apk",
      mimeType: "application/vnd.android.package-archive",
      buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]),
    });
    await page.getByLabel("Release notes").fill("Retain the artifact after an ambiguous publish response.");
    await page.getByRole("button", { name: "Publish release" }).click();

    await expect(page.getByText("Android · v1.2.1")).toBeVisible();
    await expect(page.getByText("Android 1.2.1 published to gym workspaces.")).toBeVisible();
    expect(releaseStateByPage.get(page)?.deletedPaths).toEqual([]);
  });

  test("rejects non-Apple iOS links before calling the backend", async ({ page }) => {
    await signInAsTestPlatformAdmin(page);
    await page.getByRole("combobox", { name: "Platform" }).click();
    await page.getByRole("option", { name: "iOS App Store / TestFlight" }).click();
    await page.getByLabel("Version").fill("1.0.0");
    await page.getByLabel("App Store or TestFlight URL").fill("https://example.com/ios");
    await page.getByLabel("Release notes").fill("Initial iOS release.");
    await page.getByRole("button", { name: "Publish release" }).click();

    await expect(page.getByText("Use an official HTTPS App Store or TestFlight URL for iOS.")).toBeVisible();
    await expect(page.getByText("No app releases yet")).toBeVisible();
  });

  test("publishes an App Store distribution link without accepting an IPA", async ({ page }) => {
    await signInAsTestPlatformAdmin(page);
    await page.getByRole("combobox", { name: "Platform" }).click();
    await page.getByRole("option", { name: "iOS App Store / TestFlight" }).click();
    await page.getByLabel("Version").fill("1.0.0");
    await page.getByLabel("App Store or TestFlight URL").fill("https://apps.apple.com/app/ironvault/id123456789");
    await page.getByLabel("Release notes").fill("Initial iOS release.");
    await page.getByRole("button", { name: "Publish release" }).click();

    await expect(page.getByText("iOS · v1.0.0")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open distribution" })).toBeVisible();
  });
});
