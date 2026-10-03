// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  nitro: false,
  // The production frontend is a static Cloudflare Pages SPA. All privileged
  // server logic lives in Supabase Edge Functions, so the browser bundle never
  // needs a Cloudflare Worker/service-role environment.
  tanstackStart: {
    spa: {
      enabled: true,
      prerender: {
        // Cloudflare Pages expects the SPA fallback at /index.html. Using the
        // default /_shell.html triggers Pages' extensionless-HTML redirect and
        // creates an infinite /_shell ↔ /_shell.html loop.
        outputPath: "/index",
      },
    },
  },
});
