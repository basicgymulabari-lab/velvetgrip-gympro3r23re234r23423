import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl =
  process.env.E2E_BASE_URL ||
  "https://velvetgrip-gympro3r23re234r23423.basicgymulabari.workers.dev";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const pageErrors = [];

page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  await page.goto(`${baseUrl}/login`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Welcome back" }).waitFor();
  await page.getByRole("button", { name: "Gym owner" }).waitFor();
  await page.getByRole("button", { name: "Receptionist" }).waitFor();
  await page.getByLabel("Email address").waitFor();
  await page.locator("#account-password").waitFor();
  await page.getByRole("button", { name: "Sign in" }).waitFor();

  await page.goto(`${baseUrl}/ceo`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "CEO sign in" }).waitFor();
  assert.equal(await page.getByText(/sample demo/i).count(), 0);
  assert.equal(await page.getByText(/demo@ironvault\.local/i).count(), 0);

  await page.goto(`${baseUrl}/ceo/demo`, { waitUntil: "networkidle" });
  await page.waitForURL(/\/ceo(?:$|\?)/);
  await page.getByRole("heading", { name: "CEO sign in" }).waitFor();
  assert.equal(await page.getByText(/CEO Hub Demo|sample-only demo/i).count(), 0);
  assert.equal(await page.getByText(/DemoOnly!2026/i).count(), 0);

  await page.goto(`${baseUrl}/login`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Receptionist" }).click();
  assert.equal(
    await page.getByRole("button", { name: "Receptionist" }).getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(await page.getByRole("button", { name: "Continue with Google" }).count(), 0);

  await page.getByRole("button", { name: "Gym owner" }).click();
  await page.getByRole("button", { name: "New here? Sign up" }).click();
  await page.getByRole("heading", { name: "Create your account" }).waitFor();
  await page.getByLabel("Your name").waitFor();
  await page.getByLabel("Gym name").waitFor();
  await page.getByLabel("Email address").waitFor();
  await page.locator("#account-password").waitFor();
  await page.getByLabel("Confirm password").waitFor();

  await page.getByRole("button", { name: "Already have an account? Sign in" }).click();
  await page.getByRole("heading", { name: "Welcome back" }).waitFor();

  for (const path of ["/members", "/products", "/settings", "/reports", "/trash"]) {
    await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle" });
    await page.waitForURL(/\/login(?:$|\?)/);
  }

  assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join(" | ")}`);
  console.log("Cloudflare production smoke verification passed.");
} finally {
  await browser.close();
}
