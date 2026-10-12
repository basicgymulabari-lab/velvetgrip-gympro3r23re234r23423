import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl =
  process.env.E2E_BASE_URL ||
  "https://velvetgrip-gympro3r23re234r23423.basicgymulabari.workers.dev";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const pageErrors = [];
const cspViolations = [];

page.on("pageerror", (error) => pageErrors.push(error.message));
await page.addInitScript(() => {
  window.__securityCspViolations = [];
  document.addEventListener("securitypolicyviolation", (event) => {
    window.__securityCspViolations.push({
      directive: event.effectiveDirective,
      blocked: event.blockedURI,
      sample: event.sample,
      source: event.sourceFile,
      line: event.lineNumber,
      column: event.columnNumber,
    });
  });
});

async function collectCurrentDocumentCspViolations() {
  cspViolations.push(
    ...(await page.evaluate(() => {
      const events = window.__securityCspViolations || [];
      window.__securityCspViolations = [];
      return events;
    })),
  );
}

try {
  await page.goto(`${baseUrl}/login`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Welcome back" }).waitFor();
  await collectCurrentDocumentCspViolations();
  await page.getByRole("button", { name: "Gym owner" }).waitFor();
  await page.getByRole("button", { name: "Receptionist" }).waitFor();
  await page.getByLabel("Email address").waitFor();
  await page.locator("#account-password").waitFor();
  await page.getByRole("button", { name: "Sign in" }).waitFor();

  await page.goto(`${baseUrl}/ceo`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "CEO sign in" }).waitFor();
  await collectCurrentDocumentCspViolations();
  assert.equal(await page.getByText(/sample demo/i).count(), 0);
  assert.equal(await page.getByText(/demo@ironvault\.local/i).count(), 0);

  await page.goto(`${baseUrl}/ceo/demo`, { waitUntil: "networkidle" });
  await page.waitForURL(/\/ceo(?:$|\?)/);
  await page.getByRole("heading", { name: "CEO sign in" }).waitFor();
  await collectCurrentDocumentCspViolations();
  assert.equal(await page.getByText(/CEO Hub Demo|sample-only demo/i).count(), 0);
  assert.equal(await page.getByText(/DemoOnly!2026/i).count(), 0);

  const xssProbe = `<svg onload="document.body.dataset.securityProbe='executed'"></svg>`;
  await page.goto(`${baseUrl}/ceo?probe=${encodeURIComponent(xssProbe)}`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("heading", { name: "CEO sign in" }).waitFor();
  await collectCurrentDocumentCspViolations();
  assert.equal(await page.locator("svg[onload*='securityProbe']").count(), 0);
  assert.equal(await page.locator("body").getAttribute("data-security-probe"), null);

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
  await collectCurrentDocumentCspViolations();

  for (const path of ["/members", "/products", "/settings", "/reports", "/trash"]) {
    await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.location.pathname === "/login", null, {
      timeout: 10_000,
    }).catch(async () => {
      const body = (await page.locator("body").innerText()).slice(0, 180);
      throw new Error(`Unauthenticated ${path} did not redirect to login; at ${page.url()} (${body})`);
    });
    await collectCurrentDocumentCspViolations();
  }

  await page.waitForTimeout(100);
  await collectCurrentDocumentCspViolations();
  const cspRuntimeDetails = await page.evaluate(() => ({
    dynamicStyleNonce: document.createElement("style").nonce,
    styles: [...document.querySelectorAll("style")].map((style) => ({
      nonce: style.nonce,
      cssBytes: style.textContent?.length ?? 0,
    })),
  }));
  assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join(" | ")}`);
  assert.equal(
    cspViolations.length,
    0,
    `browser CSP violations: ${JSON.stringify({ violations: cspViolations, runtime: cspRuntimeDetails })}`,
  );
  console.log("Cloudflare browser smoke verification passed.");
} finally {
  await browser.close();
}
