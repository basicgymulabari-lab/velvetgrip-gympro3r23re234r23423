import assert from "node:assert/strict";

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

  const policy = response.headers.get("content-security-policy") || "";
  const scriptDirective = policy.match(/(?:^|;)\s*script-src\s+([^;]*)/i)?.[1] || "";
  assert.ok(scriptDirective, `${path} must have script-src`);
  assert.doesNotMatch(scriptDirective, /'unsafe-inline'/i);
  const nonce = scriptDirective.match(/'nonce-([^']+)'/i)?.[1];
  assert.ok(nonce, `${path} must have a per-response script nonce`);

  const html = await response.text();
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)];
  assert.ok(scripts.length > 0, `${path} should contain bootstrap scripts`);
  for (const [, attributes] of scripts) {
    assert.ok(
      attributes.includes(`nonce="${nonce}"`) || attributes.includes(`nonce='${nonce}'`),
      `${path} script nonce should match its Content-Security-Policy`,
    );
  }
  const styleDirective = policy.match(/(?:^|;)\s*style-src\s+([^;]*)/i)?.[1] || "";
  const styleAttributeDirective = policy.match(/(?:^|;)\s*style-src-attr\s+([^;]*)/i)?.[1] || "";
  assert.ok(styleDirective, `${path} must have style-src`);
  assert.doesNotMatch(styleDirective, /'unsafe-inline'/i);
  assert.ok(styleDirective.includes(`'nonce-${nonce}'`));
  assert.match(styleAttributeDirective, /'unsafe-inline'/i);
  for (const [, attributes] of html.matchAll(/<style\b([^>]*)>/gi)) {
    assert.ok(
      attributes.includes(`nonce="${nonce}"`) || attributes.includes(`nonce='${nonce}'`),
      `${path} style nonce should match its Content-Security-Policy`,
    );
  }
  assert.match(response.headers.get("cache-control") || "", /no-store/i);
  return nonce;
}

const first = await verifyDocument("/ceo");
const second = await verifyDocument("/ceo");
assert.notEqual(first, second, "HTML CSP nonces must rotate between requests");
await verifyDocument("/login");

console.log("Cloud CSP verification passed (nonce header, script tags, no unsafe-inline, no-store, nonce rotation).");
