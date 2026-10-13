import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../supabase/migrations/20261013190000_member_migration_payment_preview.sql",
  import.meta.url,
);
const sourceUrl = new URL(
  "../supabase/migrations/20261011230000_optimize_member_migration_preview.sql",
  import.meta.url,
);
const testUrl = new URL(
  "../supabase/tests/member_migration_transfer_assert.sql",
  import.meta.url,
);

const [migration, sourceFunction, transferTest] = await Promise.all([
  readFile(migrationUrl, "utf8"),
  readFile(sourceUrl, "utf8"),
  readFile(testUrl, "utf8"),
]);

function oldAnchor(name) {
  const match = migration.match(
    new RegExp(`v_old_${name} text := \\$old\\$([\\s\\S]*?)\\$old\\$;`),
  );
  assert.ok(match, `payment-preview migration must define its ${name} anchor`);
  return match[1];
}

for (const anchorName of ["payment_cte", "fields", "join"]) {
  assert.ok(
    sourceFunction.includes(oldAnchor(anchorName)),
    `payment-preview migration ${anchorName} anchor must match the latest preview function`,
  );
}

assert.match(migration, /payment\.value ->> 'membershipId'/);
assert.match(migration, /linked\.membership_id = terms\.value ->> 'id'/);
assert.match(migration, /terms\.value ->> 'memberId' as member_id/);
assert.match(migration, /sum\(linked\.payment_total\)/);
assert.match(migration, /'linked_payment_count', coalesce\(payment_summary\.linked_payment_count, 0\)/);
assert.match(migration, /'linked_payment_total', coalesce\(payment_summary\.linked_payment_total, 0\)/);
assert.match(migration, /'payment_currency', coalesce\(/);
assert.match(transferTest, /'linked_payment_count'\)::integer <> 2/);
assert.match(transferTest, /'linked_payment_total'\)::numeric <> 1800/);

console.log(
  "Member-migration preview patch anchors and paid-history assertions match the latest source function.",
);
