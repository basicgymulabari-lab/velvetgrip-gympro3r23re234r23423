import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const assertions = {
  "tenant-isolation": "supabase/tests/tenant_isolation_assert.sql",
  "member-migration": "supabase/tests/member_migration_transfer_assert.sql",
  recharge: "supabase/tests/recharge_redemption_assert.sql",
};
const assertionName = process.argv[2];
const assertionPath = assertions[assertionName];

if (!assertionPath) {
  console.error(`Choose one: ${Object.keys(assertions).join(", ")}.`);
  process.exit(2);
}

const expectedStagingRef = process.env.SUPABASE_STAGING_PROJECT_REF?.trim() ?? "";
if (!/^[a-z0-9]{20}$/.test(expectedStagingRef)) {
  console.error(
    "Refusing linked database assertions. Set SUPABASE_STAGING_PROJECT_REF to the 20-character ref for a disposable staging project.",
  );
  process.exit(2);
}

if (process.env.SUPABASE_ALLOW_STAGING_DB_ASSERTIONS !== "yes") {
  console.error(
    "Refusing linked database assertions. After confirming this is disposable staging, set SUPABASE_ALLOW_STAGING_DB_ASSERTIONS=yes.",
  );
  process.exit(2);
}

let linkedProjectRef;
try {
  linkedProjectRef = (
    await readFile(new URL("../supabase/.temp/project-ref", import.meta.url), "utf8")
  ).trim();
} catch {
  console.error(
    "No Supabase project link is present for this worktree. Link it to the disposable staging project before running database assertions.",
  );
  process.exit(2);
}

if (linkedProjectRef !== expectedStagingRef) {
  console.error(
    "Refusing linked database assertions: the Supabase CLI project link does not match SUPABASE_STAGING_PROJECT_REF.",
  );
  process.exit(2);
}

console.log(`Running rollback-only ${assertionName} assertions against the confirmed staging project.`);
const executable = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(
  executable,
  ["supabase", "db", "query", "--linked", "--file", assertionPath],
  { stdio: "inherit", shell: process.platform === "win32" },
);

if (result.error) {
  console.error(`Could not start Supabase CLI: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
