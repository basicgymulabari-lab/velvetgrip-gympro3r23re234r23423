import { addCspNonces } from "./lib/security/csp";

type AssetBinding = {
  fetch(request: Request): Promise<Response>;
};

type WorkerEnv = {
  ASSETS: AssetBinding;
};

type RewriterElement = {
  setAttribute(name: string, value: string): void;
  prepend(content: string, options?: { html?: boolean }): void;
};

declare class HTMLRewriter {
  on(
    selector: string,
    handlers: { element(element: RewriterElement): void },
  ): HTMLRewriter;
  transform(response: Response): Response;
}

function createNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const acceptsHtml = request.headers.get("accept")?.toLowerCase().includes("text/html");
    const isDocumentRequest = request.method === "GET" && acceptsHtml;

    // Conditional requests can produce an empty 304 response, which cannot be
    // assigned a fresh CSP nonce. HTML is no-store; force the asset binding to
    // return the document body if a client sends stale validators anyway.
    let assetRequest = request;
    if (isDocumentRequest && (request.headers.has("if-none-match") || request.headers.has("if-modified-since"))) {
      const headers = new Headers(request.headers);
      headers.delete("if-none-match");
      headers.delete("if-modified-since");
      assetRequest = new Request(request, { headers });
    }

    const assetResponse = await env.ASSETS.fetch(assetRequest);
    if (!isDocumentRequest || !assetResponse.headers.get("content-type")?.includes("text/html")) {
      return assetResponse;
    }

    const headers = new Headers(assetResponse.headers);
    const nonce = createNonce();
    const existingPolicy = headers.get("Content-Security-Policy");
    const securedPolicy = existingPolicy ? addCspNonces(existingPolicy, nonce) : null;
    if (!securedPolicy) {
      headers.set("Cache-Control", "no-store");
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response("Application security policy is misconfigured.", {
        status: 500,
        headers,
      });
    }

    const rewritten = new HTMLRewriter()
      .on("head", {
        element(element) {
          // Sonner injects its stylesheet dynamically. Give those trusted
          // runtime style elements the same per-response nonce without
          // allowing arbitrary inline style blocks through the CSP.
          element.prepend(
            `<script nonce="${nonce}">(()=>{const n=document.currentScript?.nonce;if(!n)return;const s=e=>{if(e&&e.nodeType===1&&e.nodeName==="STYLE"&&!e.nonce)e.setAttribute("nonce",n)};const c=document.createElement.bind(document);document.createElement=function(t,o){const e=c(t,o);s(e);return e};const a=Node.prototype.appendChild;Node.prototype.appendChild=function(e){s(e);return a.call(this,e)};const i=Node.prototype.insertBefore;Node.prototype.insertBefore=function(e,r){s(e);return i.call(this,e,r)}})();</script>`,
            { html: true },
          );
        },
      })
      .on("script", {
        element(element) {
          element.setAttribute("nonce", nonce);
        },
      })
      .on("style", {
        element(element) {
          element.setAttribute("nonce", nonce);
        },
      })
      .transform(assetResponse);

    const responseHeaders = new Headers(rewritten.headers);
    responseHeaders.set("Content-Security-Policy", securedPolicy);
    responseHeaders.set("Cache-Control", "private, no-store");
    responseHeaders.delete("ETag");
    responseHeaders.delete("Content-Length");
    responseHeaders.delete("Content-Encoding");

    return new Response(rewritten.body, {
      status: rewritten.status,
      statusText: rewritten.statusText,
      headers: responseHeaders,
    });
  },
};
