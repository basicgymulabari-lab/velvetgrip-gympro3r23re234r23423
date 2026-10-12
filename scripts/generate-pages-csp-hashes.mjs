import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const htmlPath = new URL("../dist/client/index.html", import.meta.url);
const headersPath = new URL("../dist/client/_headers", import.meta.url);

const [html, headers] = await Promise.all([
  readFile(htmlPath, "utf8"),
  readFile(headersPath, "utf8"),
]);

const inlineScripts = [...html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi)]
  .map((match) => match[1])
  .filter((script) => script.trim().length > 0);

if (inlineScripts.length === 0) {
  throw new Error("Expected TanStack Start inline bootstrap scripts in dist/client/index.html");
}

const hashes = [...new Set(inlineScripts)].map((script) => {
  // HTML tokenization normalizes CRLF and replaces NUL characters inside
  // script data. TanStack's streamed route manifest can contain a NUL byte,
  // so hash the exact text the browser executes rather than the raw HTML bytes.
  const browserScriptText = script.replace(/\r\n?/g, "\n").replace(/\u0000/g, "\uFFFD");
  const digest = createHash("sha256").update(browserScriptText, "utf8").digest("base64");
  return `'sha256-${digest}'`;
});

const scriptDirective = /script-src 'self' https:\/\/checkout\.razorpay\.com(?: '[^']+')*;/;
if (!scriptDirective.test(headers)) {
  throw new Error("Could not find the expected strict script-src directive in dist/client/_headers");
}

const updatedHeaders = headers.replace(
  scriptDirective,
  `script-src 'self' https://checkout.razorpay.com ${hashes.join(" ")};`,
);

if (updatedHeaders.includes("script-src 'self' 'unsafe-inline'")) {
  throw new Error("Refusing to weaken the script-src policy with unsafe-inline");
}

await writeFile(headersPath, updatedHeaders, "utf8");
console.log(`Added ${hashes.length} exact inline-script CSP hash(es) to dist/client/_headers`);
