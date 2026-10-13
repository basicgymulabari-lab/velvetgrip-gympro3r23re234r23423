import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const baseUrl = (
  process.env.E2E_BASE_URL ||
  "https://velvetgrip-gympro3r23re234r23423.basicgymulabari.workers.dev"
).replace(/\/$/, "");

async function verifyDocument(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { accept: "text/html", "cache-control": "no-cache" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200, `${path} should return a document`);
  assert.match(response.headers.get("content-type") || "", /text\/html/i);

  const permissionsPolicy = response.headers.get("permissions-policy") || "";
  assert.match(
    permissionsPolicy,
    /(?:^|,)\s*camera=\(self\)(?:,|$)/i,
    `${path} must allow camera access for the app's own origin`,
  );
  for (const feature of ["microphone", "geolocation", "usb", "serial", "bluetooth"]) {
    assert.match(
      permissionsPolicy,
      new RegExp(`(?:^|,)\\s*${feature}=\\(\\)(?:,|$)`, "i"),
      `${path} must keep ${feature} disabled`,
    );
  }

  const policy = response.headers.get("content-security-policy") || "";
  const scriptDirective = policy.match(/(?:^|;)\s*script-src\s+([^;]*)/i)?.[1] || "";
  assert.ok(scriptDirective, `${path} must have script-src`);
  assert.doesNotMatch(scriptDirective, /'unsafe-inline'/i);
  const nonce = scriptDirective.match(/'nonce-([^']+)'/i)?.[1];
  assert.ok(nonce, `${path} must carry a per-response CSP nonce`);
  const html = await response.text();
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  assert.ok(scripts.length > 0, `${path} should contain bootstrap scripts`);
  const inlineHashes = [];
  for (const [, attributes, body] of scripts) {
    if (/\bsrc\s*=/i.test(attributes) || !body.trim()) continue;
    const scriptNonce = attributes.match(/\bnonce\s*=\s*["']([^"']+)["']/i)?.[1];
    const browserScriptText = body.replace(/\r\n?/g, "\n").replace(/\u0000/g, "\uFFFD");
    const digest = createHash("sha256").update(browserScriptText, "utf8").digest("base64");
    const hash = `'sha256-${digest}'`;
    if (scriptNonce) {
      assert.equal(scriptNonce, nonce, `${path} inline script nonce must match the response CSP`);
      if (scriptDirective.includes(hash)) inlineHashes.push(hash);
      continue;
    }
    assert.ok(scriptDirective.includes(hash), `${path} inline bootstrap script must match CSP`);
    inlineHashes.push(hash);
  }
  assert.ok(
    scripts.some(([, attributes, body]) => !/\bsrc\s*=/i.test(attributes) && body.trim()),
    `${path} should contain an inline bootstrap script`,
  );
  const styleDirective = policy.match(/(?:^|;)\s*style-src\s+([^;]*)/i)?.[1] || "";
  const styleAttributeDirective = policy.match(/(?:^|;)\s*style-src-attr\s+([^;]*)/i)?.[1] || "";
  assert.ok(styleDirective, `${path} must have style-src`);
  assert.doesNotMatch(styleDirective, /'unsafe-inline'/i);
  assert.match(styleAttributeDirective, /'unsafe-inline'/i);
  assert.match(response.headers.get("cache-control") || "", /no-store/i);
  return { html, policy, nonce, inlineHashes };
}

const first = await verifyDocument("/ceo");
const second = await verifyDocument("/ceo");
assert.notEqual(first.nonce, second.nonce, "the document CSP nonce must rotate per response");
assert.deepEqual(first.inlineHashes, second.inlineHashes, "static bootstrap CSP hashes must be stable");
await verifyDocument("/login");

const fingerprintedAsset = first.html.match(/(?:src|href)=["'](\/assets\/[^"']+)["']/i)?.[1];
assert.ok(fingerprintedAsset, "the HTML document should reference a fingerprinted static asset");
const assetResponse = await fetch(`${baseUrl}${fingerprintedAsset}`, {
  cache: "no-store",
  signal: AbortSignal.timeout(15_000),
});
assert.equal(assetResponse.status, 200, "the fingerprinted static asset should be served");
const assetCacheControl = assetResponse.headers.get("cache-control") || "";
assert.match(
  assetCacheControl,
  /public,\s*max-age=31536000,\s*immutable/i,
  "fingerprinted assets should receive the long-lived immutable browser cache policy",
);
assert.doesNotMatch(
  assetCacheControl,
  /no-store|no-cache/i,
  "fingerprinted assets must not inherit the HTML no-store policy",
);

console.log("Cloud CSP and cache verification passed (nonce/hash-authorized inline scripts, no-store HTML, immutable fingerprinted assets).");
