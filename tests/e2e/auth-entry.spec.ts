import { expect, test } from "@playwright/test";

test.describe("unauthenticated application entry points", () => {
  test("CEO console shows its private sign-in gate and password visibility works", async ({ page }) => {
    await page.goto("/ceo");

    await expect(page.getByRole("heading", { name: "CEO sign in" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Platform-owner email" })).toHaveJSProperty("required", true);
    const password = page.getByRole("textbox", { name: "Password" });
    await expect(password).toHaveJSProperty("required", true);
    await expect(password).toHaveAttribute("type", "password");

    await page.getByRole("button", { name: "Show password" }).click();
    await expect(password).toHaveAttribute("type", "text");
    await page.getByRole("button", { name: "Hide password" }).click();
    await expect(password).toHaveAttribute("type", "password");
  });

  test("gym workspace deep links return unauthenticated visitors to the owner login", async ({ page }) => {
    await page.goto("/members");

    await expect(page).toHaveURL(/\/login(?:\?|$)/);
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("gym login can switch receptionist mode and open/close password recovery", async ({ page }) => {
    await page.goto("/login");

    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Gym owner" })).toBeVisible();
    await page.getByRole("button", { name: "Receptionist" }).click();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

    await page.getByRole("button", { name: "Forgot password?" }).click();
    await expect(page.getByRole("heading", { name: "Forgot password?" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Email address" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Show recovery steps" })).toBeVisible();

    // Return without sending an email or invoking the auth backend.
    await page.getByRole("button", { name: "Already have an account? Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  });
});

test.describe("public user-guide downloads", () => {
  test("both guides are served as downloadable PDF files", async ({ request }) => {
    for (const path of [
      "/guides/gym-management-guide.pdf",
      "/guides/ceo-dashboard-guide.pdf",
    ]) {
      const response = await request.get(path);
      expect(response.ok(), `${path} should be publicly downloadable`).toBeTruthy();
      expect(response.headers()["content-type"]).toContain("application/pdf");
      expect((await response.body()).subarray(0, 5).toString("ascii")).toBe("%PDF-");
    }
  });
});
