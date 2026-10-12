import { expect, test, type Page, type Route } from "@playwright/test";
import { newWorkspace } from "../../src/lib/gym/new-workspace";

const gymUser = {
  id: "e3000000-0000-0000-0000-000000000001",
  aud: "authenticated",
  role: "authenticated",
  email: "camera-test@example.invalid",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { full_name: "Camera Test Owner", gym_name: "Camera QA Gym" },
  identities: [],
  created_at: "2026-01-01T00:00:00.000Z",
};

const gymContext = {
  gym_id: "e3000000-0000-0000-0000-000000000002",
  role: "owner",
  permissions: {},
  display_name: "Camera Test Owner",
  email: gymUser.email,
  enabled: true,
  gym_name: "Camera QA Gym",
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

async function mockGymBackend(page: Page) {
  const workspace = newWorkspace(gymUser.email, "Camera Test Owner", "Camera QA Gym");
  await page.route("**/auth/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/token")) {
      return json(route, {
        access_token: testToken(),
        token_type: "bearer",
        expires_in: 3600,
        expires_at: 4102444800,
        refresh_token: "camera-test-refresh-token",
        user: gymUser,
      });
    }
    if (path.endsWith("/user")) return json(route, gymUser);
    return json(route, { message: "Unexpected auth request in isolated camera test." }, 404);
  });

  await page.route("**/rest/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/rpc/get_current_gym_context")) return json(route, gymContext);
    if (path.endsWith("/rpc/load_current_gym_workspace")) {
      return json(route, { ...gymContext, state: workspace, revision: 1 });
    }
    if (path.endsWith("/rpc/record_audit_event")) return json(route, null);
    if (path.endsWith("/gym_users")) {
      return json(route, { display_name: "", email: "", enabled: false, permissions: {} });
    }
    return json(route, {});
  });
}

async function signInAndOpenCamera(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(gymUser.email);
  await page.getByRole("textbox", { name: "Password" }).fill("camera-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto("/members");
  await expect(page.getByRole("heading", { name: "Member Management" })).toBeVisible();
  await page.getByRole("button", { name: "Add Member", exact: true }).last().click();
  await expect(page.getByRole("heading", { name: "Add new member" })).toBeVisible();
  await page.getByRole("button", { name: "Capture photo", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Capture member photo" })).toBeVisible();
}

test.describe("member-photo camera flow (synthetic gym and fake camera only)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((email) => {
      localStorage.setItem(`ironvault.app-tour.v1.${email.toLowerCase()}`, "done");
    }, gymUser.email);
    await mockGymBackend(page);
  });

  test("shows a live preview, captures it, and stops the camera stream", async ({ page }) => {
    await page.addInitScript(() => {
      const mediaDevices = navigator.mediaDevices;
      const originalGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
      const streams: MediaStream[] = [];
      Object.defineProperty(window, "__cameraStreams", { configurable: true, value: streams });
      Object.defineProperty(mediaDevices, "getUserMedia", {
        configurable: true,
        value: async (constraints: MediaStreamConstraints) => {
          const stream = await originalGetUserMedia(constraints);
          streams.push(stream);
          return stream;
        },
      });
    });

    await signInAndOpenCamera(page);
    await page.waitForFunction(() => {
      const video = document.querySelector("video");
      if (!video || video.readyState < 2 || video.videoWidth < 1) return false;
      const canvas = document.createElement("canvas");
      canvas.width = 32;
      canvas.height = 24;
      const context = canvas.getContext("2d");
      if (!context) return false;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let min = 255;
      let max = 0;
      let total = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const brightness = (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
        min = Math.min(min, brightness);
        max = Math.max(max, brightness);
        total += brightness;
      }
      return max - min > 40 && total / (pixels.length / 4) > 20;
    });
    const captureButton = page.getByRole("button", { name: "Capture photo", exact: true }).last();
    await expect(captureButton).toBeEnabled();
    await captureButton.click();
    await expect(page.getByRole("heading", { name: "Crop photo" })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const streams = (window as Window & { __cameraStreams?: MediaStream[] }).__cameraStreams;
          return streams?.flatMap((stream) => stream.getTracks().map((track) => track.readyState));
        }),
      )
      .toEqual(["ended"]);
  });

  test("identifies a camera feature blocked by the site's security policy", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(document, "permissionsPolicy", {
        configurable: true,
        value: { allowsFeature: (feature: string) => feature !== "camera" },
      });
      Object.defineProperty(window, "__cameraRequests", {
        configurable: true,
        writable: true,
        value: 0,
      });
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: async () => {
          const testWindow = window as Window & { __cameraRequests: number };
          testWindow.__cameraRequests += 1;
          throw new DOMException("Blocked by test policy", "NotAllowedError");
        },
      });
    });

    await signInAndOpenCamera(page);
    await expect(page.getByText(/blocks camera access in its security policy/)).toBeVisible();
    await page.getByRole("button", { name: "Retry camera" }).click();
    await expect(page.getByText(/blocks camera access in its security policy/)).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => (window as Window & { __cameraRequests: number }).__cameraRequests),
      )
      .toBe(0);
  });

  for (const [errorName, expectedMessage] of [
    ["NotAllowedError", "Camera access was denied"],
    ["NotFoundError", "No camera was found"],
    ["NotReadableError", "camera is unavailable or in use"],
  ]) {
    test(`explains ${errorName} distinctly`, async ({ page }) => {
      await page.addInitScript((name) => {
        Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
          configurable: true,
          value: async () => {
            throw new DOMException("Synthetic camera failure", name);
          },
        });
      }, errorName);

      await signInAndOpenCamera(page);
      await expect(page.getByText(new RegExp(expectedMessage, "i"))).toBeVisible();
      await expect(page.getByRole("button", { name: "Retry camera" })).toBeEnabled();
    });
  }
});

declare global {
  interface Window {
    __cameraStreams?: MediaStream[];
    __cameraRequests?: number;
  }
}
