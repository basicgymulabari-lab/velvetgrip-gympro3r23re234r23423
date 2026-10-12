import assert from "node:assert/strict";

const { HttpError, corsHeaders, parseJson, readLimitedBodyText } = await import(
  "../supabase/functions/_shared/http.ts"
);
const { addCspNonces } = await import("../src/lib/security/csp.ts");

const testEnvironment = new Map([
  ["APP_ORIGIN", "https://ironvault-gym.pages.dev"],
  ["EXTRA_ALLOWED_ORIGINS", "https://preview.ironvault-gym.pages.dev,http://localhost:5173"],
]);
globalThis.Deno = { env: { get: (name) => testEnvironment.get(name) ?? undefined } };

function corsFor(origin) {
  return corsHeaders(new Request("https://edge.invalid/test", { headers: { origin } }));
}

assert.equal(
  corsFor("https://ironvault-gym.pages.dev")["Access-Control-Allow-Origin"],
  "https://ironvault-gym.pages.dev",
);
assert.equal(
  corsFor("https://preview.ironvault-gym.pages.dev")["Access-Control-Allow-Origin"],
  "https://preview.ironvault-gym.pages.dev",
);
assert.equal(
  corsFor("http://localhost:5173")["Access-Control-Allow-Origin"],
  "http://localhost:5173",
  "development origins remain available when explicitly configured",
);
assert.equal(
  corsFor("http://localhost:9999")["Access-Control-Allow-Origin"],
  "https://ironvault-gym.pages.dev",
  "unconfigured localhost ports must not be trusted",
);
assert.equal(
  corsFor("https://attacker.invalid")["Access-Control-Allow-Origin"],
  "https://ironvault-gym.pages.dev",
  "untrusted origins must not be echoed",
);

const originalCsp =
  "default-src 'self'; script-src 'self' 'unsafe-inline' https://checkout.razorpay.com; style-src 'self'; style-src-attr 'unsafe-inline'";
const nonceCsp = addCspNonces(originalCsp, "MTIzNDU2Nzg5MDEyMzQ1Njc4");
assert.ok(nonceCsp);
assert.match(nonceCsp, /script-src 'self' https:\/\/checkout\.razorpay\.com 'nonce-MTIzNDU2Nzg5MDEyMzQ1Njc4'/);
assert.doesNotMatch(nonceCsp, /script-src[^;]*'unsafe-inline'/);
assert.match(nonceCsp, /style-src 'self' 'nonce-MTIzNDU2Nzg5MDEyMzQ1Njc4'/);
assert.match(nonceCsp, /style-src-attr 'unsafe-inline'/);
assert.equal(addCspNonces(originalCsp, "nonce;inject"), null);
assert.equal(addCspNonces("default-src 'self'; script-src 'self'", "MTIzNDU2Nzg5MDEyMzQ1Njc4"), null);

function streamingRequest(chunks, headers = {}) {
  let index = 0;
  let canceled = false;
  const body = new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(new TextEncoder().encode(chunks[index++]));
      } else {
        controller.close();
      }
    },
    cancel() {
      canceled = true;
    },
  });
  const request = new Request("https://edge.invalid/test", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  });
  return { request, wasCanceled: () => canceled };
}

const valid = streamingRequest(['{"name":"Nabin"}'], {
  "content-type": "application/json",
});
assert.deepEqual(await parseJson(valid.request), { name: "Nabin" });

const withinLimit = streamingRequest(["1234"]);
assert.equal(await readLimitedBodyText(withinLimit.request, 4), "1234");

const streamedTooLarge = streamingRequest(["12345", "ignored"]);
await assert.rejects(readLimitedBodyText(streamedTooLarge.request, 4), (error) => {
  assert.ok(error instanceof HttpError);
  assert.equal(error.status, 413);
  assert.equal(error.code, "PAYLOAD_TOO_LARGE");
  return true;
});
assert.equal(streamedTooLarge.wasCanceled(), true, "oversized streams should be canceled early");

const declaredTooLarge = streamingRequest(["{}"], {
  "content-type": "application/json",
  "content-length": "1048577",
});
await assert.rejects(parseJson(declaredTooLarge.request), (error) => {
  assert.ok(error instanceof HttpError);
  assert.equal(error.status, 413);
  assert.equal(error.code, "PAYLOAD_TOO_LARGE");
  return true;
});

const invalidJson = streamingRequest(["{"] , { "content-type": "application/json" });
await assert.rejects(parseJson(invalidJson.request), (error) => {
  assert.ok(error instanceof HttpError);
  assert.equal(error.status, 400);
  assert.equal(error.code, "INVALID_JSON");
  return true;
});

const nonJson = streamingRequest(["{}"], { "content-type": "text/plain" });
await assert.rejects(parseJson(nonJson.request), (error) => {
  assert.ok(error instanceof HttpError);
  assert.equal(error.status, 415);
  assert.equal(error.code, "UNSUPPORTED_MEDIA_TYPE");
  return true;
});

console.log("Edge request security tests passed (bounded streams, JSON validation, and safe errors).");
