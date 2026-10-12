# Basic Gym QA program

This repo already has substantial synthetic business-logic checks. This QA layer adds browser coverage for the unauthenticated entry points and an opt-in, non-mutating HTTP load smoke test.

## Tools and fit

- [Microsoft Playwright](https://github.com/microsoft/playwright) is the browser end-to-end tool. It is already a dev dependency in this project; `npm run test:e2e` uses Chromium against a local Vite server.
- [Grafana k6](https://github.com/grafana/k6) is an optional HTTP load-testing tool. It is not an npm dependency and is intentionally not part of the default test gate. The checked-in script only GETs `/login` and `/ceo`; it does not authenticate or write application data.
- [StrykerJS](https://github.com/stryker-mutator/stryker-js) is a possible later addition for mutation testing (measuring whether tests catch deliberately introduced code faults), not a functional bug-fixer or load test. It is not installed/configured here.

No repository can automatically discover or repair every possible bug. These tools make repeatable checks and regressions practical; fixes still require a reproduced failure and review.

## Commands

```powershell
npm run test:logic       # Synthetic business rules, includes 5,000-member selector/import stress cases
npm run test:edge-security
npm run test:e2e          # Local Chromium tests; starts Vite on 127.0.0.1:4173
npm run test:all          # Typecheck, lint, logic, edge security, build, and local E2E
```

Install k6 separately from its official project/release instructions before using the optional HTTP load smoke:

```powershell
npm run dev -- --host 127.0.0.1 --port 4173 --strictPort
$env:K6_BASE_URL = 'http://127.0.0.1:4173'
npm run test:load
```

To point k6 at a staging service, use an HTTPS hostname containing a `staging`, `stage`, `preview`, `test`, or `dev` label and explicitly repeat that exact hostname in `K6_ALLOWED_STAGING_HOST`. Known production `ironvault-gym-5ry.pages.dev` and `*.workers.dev` hosts are rejected. Never aim load tests at customer production or use real customer records.

## Current coverage boundaries

The checked-in Playwright suite covers CEO login gating, password visibility, member deep-link redirection, receptionist-mode selection, and password-recovery open/close without sending a reset email. It does not authenticate or verify privileged CEO/gym workflows. Those require a dedicated staging project and test identities, followed by synthetic fixtures and cleanup.

The k6 script measures only delivery of the public app-shell routes; it does not represent authenticated database throughput or full client-side rendering. The 5,000-member test in `scripts/verify-business-logic.mjs` stresses selected local selectors/import duplicate detection in memory, not Supabase or a deployed backend.
