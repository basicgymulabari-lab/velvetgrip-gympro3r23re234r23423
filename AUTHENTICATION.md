# Authentication

Owner accounts use Supabase Auth: Google, email/password sign-up, email confirmation, email/password sign-in, reset emails, and authenticated password changes. All callback links return to `/login`. The login component handles `PASSWORD_RECOVERY` before opening the workspace and preserves recovery mode across refreshes in the same tab. New accounts receive an empty workspace; browser/demo data is never imported automatically.

The Settings account-password form verifies the current email password with Supabase before changing it. Google users can request a reset email to set an application email password; this does not change their Google password. Logout waits for pending workspace saves and Supabase sign-out before clearing the local session.

## Verified locally

- Production build and TypeScript check.
- Business logic regression tests, including independent empty workspaces without inherited credentials, staff or financial records.
- Browser sign-up mismatch validation and reset-form navigation.
- Public Supabase settings: email and Google enabled, sign-up allowed, email confirmation required.

## Release verification still required

- Complete confirmation and reset links through a real test mailbox, including expired links and a fresh browser session. Do not claim email delivery solely from a successful API response.
- Verify custom SMTP/delivery limits for public users. Public auth settings do not expose SMTP configuration.
- Keep `http://localhost:4173/login` and the production `/login` URL in the Supabase redirect allowlist.
- Test successful sign-in, password change, sign-out, and subsequent sign-in with a controlled test account.
- Receptionist credentials and permissions still use the legacy browser workspace. They do not yet provide server-enforced, cross-device staff authentication or email recovery. Migrating staff requires a server-side workspace membership model and corresponding row-level security, rather than exposing owner credentials to staff.

These changes remain local until explicitly released. This document does not certify the whole application as production-ready.
