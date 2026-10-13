import { addCspNonces } from "./lib/security/csp";

type AssetBinding = {
  fetch(request: Request): Promise<Response>;
};

type WorkerEnv = {
  ASSETS: AssetBinding;
};

type RewriterElement = {
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
    const requestUrl = new URL(request.url);

    // Retire the former public CEO demo before the SPA shell boots. A client
    // router redirect on this URL can collide with hydration when the CEO
    // console is already open in the same browser session.
    if (request.method === "GET" && requestUrl.pathname === "/ceo/demo") {
      return Response.redirect(new URL("/ceo", requestUrl), 308);
    }

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

    const responseHeaders = new Headers(assetResponse.headers);
    const nonce = createNonce();
    const existingPolicy = responseHeaders.get("Content-Security-Policy");
    const securedPolicy = existingPolicy ? addCspNonces(existingPolicy, nonce) : null;
    if (!securedPolicy) {
      responseHeaders.set("Cache-Control", "private, no-store");
      responseHeaders.set("X-Content-Type-Options", "nosniff");
      return new Response("Application security policy is misconfigured.", {
        status: 500,
        headers: responseHeaders,
      });
    }

    // Nonce only the tiny style bootstrap. Do not rewrite TanStack's script
    // tags: its script manifest intentionally controls the async attribute.
    const rewritten = new HTMLRewriter()
      .on("head", {
        element(element) {
          element.prepend(
            `<script nonce="${nonce}">(()=>{const n=document.currentScript?.nonce;if(!n)return;const s=e=>{if(e&&e.nodeType===1&&e.nodeName==="STYLE"&&!e.nonce)e.setAttribute("nonce",n)};const c=document.createElement.bind(document);document.createElement=function(t,o){const e=c(t,o);s(e);return e};const a=Node.prototype.appendChild;Node.prototype.appendChild=function(e){s(e);return a.call(this,e)};const i=Node.prototype.insertBefore;Node.prototype.insertBefore=function(e,r){s(e);return i.call(this,e,r)}})();</script>`,
            { html: true },
          );
        },
      })
      .transform(assetResponse);

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
