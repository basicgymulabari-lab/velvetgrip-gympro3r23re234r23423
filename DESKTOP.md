# IRONVAULT for Windows

The Windows edition is a Tauri desktop app for gym owners and staff. Its route tree
contains the gym-management pages only; CEO/platform administration is not part of
the desktop application.

## Offline behavior

- Sign in online once on this Windows user profile so the app can verify the account
  and download its gym workspace.
- The desktop app stores a workspace copy in IndexedDB in the app's WebView profile.
  Reopening the app without internet restores that copy for the signed-in Supabase
  identity. Business changes are kept locally and queued for synchronization.
- When the connection returns, the app sends the queued workspace to Supabase using
  the last known revision. If the server workspace changed on another device while
  this PC was offline, the app stops instead of overwriting either copy. Export a
  backup and resolve that conflict before continuing cloud work.
- Google OAuth, subscription checkout, cloud backups, staff-account administration,
  and private file upload/viewing require an internet connection. Payments and sales
  can be recorded as gym records while offline; external payment-provider verification
  cannot happen offline.
- The offline copy and persistent login belong to the current Windows user profile.
  They are not encrypted by the app. Use a protected Windows account and device
  encryption, especially on a shared or portable computer. Signing out removes the
  Supabase login session; it does not erase the device's cached workspace.
- Offline access cannot learn that an account was suspended or a subscription expired
  until the app reconnects. The server still enforces authorization for every cloud
  write; offline changes that the server rejects remain on the device and do not become
  cloud data.

## Windows prerequisites

Install Rust with the MSVC toolchain, Microsoft C++ Build Tools (Desktop development
with C++), and the Microsoft Edge WebView2 Runtime. Tauri's Windows requirements are
documented at <https://v2.tauri.app/start/prerequisites/>.

Install JavaScript dependencies and create a frontend bundle:

```powershell
npm install
npm run build:desktop
```

To build Windows installer packages, make sure `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY` are configured in the local production environment,
then run:

```powershell
npm run desktop:build
```

Tauri writes Windows installers under `src-tauri/target/release/bundle/` (including
the NSIS setup executable when that target is available). The Supabase publishable
key is public client configuration, not a secret; never put a service-role key in
the desktop build.
