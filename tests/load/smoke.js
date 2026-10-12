import http from "k6/http";
import { check, sleep } from "k6";

const baseUrl = (__ENV.K6_BASE_URL || "http://127.0.0.1:4173").replace(/\/+$/, "");
const parsedBaseUrl = new URL(baseUrl);
const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
const isLocal = localHosts.has(parsedBaseUrl.hostname);

if (!isLocal) {
  const explicitStagingHost = (__ENV.K6_ALLOWED_STAGING_HOST || "").toLowerCase();
  const hostname = parsedBaseUrl.hostname.toLowerCase();
  const looksLikeStaging = /(^|[.-])(staging|stage|preview|test|dev)([.-]|$)/.test(hostname);
  const knownProductionHost = hostname === "ironvault-gym-5ry.pages.dev" || hostname.endsWith(".workers.dev");

  if (
    parsedBaseUrl.protocol !== "https:" ||
    knownProductionHost ||
    !looksLikeStaging ||
    explicitStagingHost !== hostname
  ) {
    throw new Error(
      "Load tests are restricted to localhost or an explicitly approved HTTPS staging/preview/dev hostname. " +
        "Set K6_ALLOWED_STAGING_HOST to the exact staging hostname; production hosts are rejected.",
    );
  }
}

export const options = {
  stages: [
    { duration: "10s", target: 5 },
    { duration: "20s", target: 10 },
    { duration: "10s", target: 0 },
  ],
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<1000"],
    checks: ["rate>0.99"],
  },
};

export default function () {
  const path = __ITER % 2 === 0 ? "/login" : "/ceo";
  const response = http.get(`${baseUrl}${path}`, { redirects: 0, tags: { page: path } });

  check(response, {
    [`${path} responds successfully`]: (res) => res.status === 200,
    [`${path} returns the app shell`]: (res) => String(res.headers["Content-Type"] || "").includes("text/html"),
  });

  sleep(0.2);
}
