# IRONVAULT desktop application

The desktop edition uses Tauri 2 and a separate client-only Vite build. The existing TanStack
Start/Cloudflare web build is unchanged.

## How offline-first storage works

- Every business-data change is written to the desktop WebView's local storage immediately.
- When signed in as an owner, changes are debounced and uploaded to the owner's Supabase
  workspace.
- A failed upload remains marked as pending. When Windows reports that the connection is back,
  the newest local workspace is uploaded automatically.
- A previously verified owner can continue using the app during an outage. A first-time login
  and cloud account operations still require internet access.

## Development

Install the Windows prerequisites once: Microsoft C++ Build Tools with the **Desktop development
with C++** workload, WebView2, and the Rust stable toolchain.

```powershellpm install
npm install desktop
```

The desktop web bundle can be checked without Rust:

```powershell
npm run build:desktop
```

## Windows installer

Set the same `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` values used by the web app,
then run:

```powershell
npm run desktop:build
```

Tauri writes the installer under `src-tauri/target/release/bundle/`.
