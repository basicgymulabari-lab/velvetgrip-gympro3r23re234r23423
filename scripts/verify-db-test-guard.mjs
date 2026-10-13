import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const env = { ...process.env };
delete env.SUPABASE_STAGING_PROJECT_REF;
delete env.SUPABASE_ALLOW_STAGING_DB_ASSERTIONS;

const result = spawnSync(
  process.execPath,
  ["scripts/run-linked-db-assertion.mjs", "member-migration"],
  { cwd: process.cwd(), env, encoding: "utf8" },
);

assert.equal(result.status, 2, "linked DB assertions must fail closed without a staging ref");
assert.match(result.stderr, /Refusing linked database assertions/);
assert.doesNotMatch(result.stdout, /Running rollback-only/);

console.log("Linked database assertion runner refuses to contact a project without explicit staging configuration.");
