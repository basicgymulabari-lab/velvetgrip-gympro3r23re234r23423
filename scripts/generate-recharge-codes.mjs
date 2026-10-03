import { createHash, randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const count = Math.max(1, Math.min(500, Number(value("count", "20")) || 20));
const days = Math.max(1, Math.min(366, Number(value("days", "30")) || 30));
const label = value("label", new Date().toISOString().slice(0, 7));
const validDays = Math.max(1, Math.min(366, Number(value("valid-days", "45")) || 45));
const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before generating recharge codes.");
  process.exit(1);
}

const normalize = (code) => code.trim().toUpperCase();
const hash = (code) => createHash("sha256").update(normalize(code)).digest("hex");
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const chunk = (length) => {
  const bytes = randomBytes(length);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
};
const prefix = `IV-${new Date().toISOString().slice(0, 7).replace("-", "")}`;

const codes = Array.from({ length: count }, () => `${prefix}-${chunk(4)}-${chunk(4)}-${chunk(4)}`);
const validUntil = new Date(Date.now() + validDays * 86_400_000).toISOString();
const rows = codes.map((code) => ({
  code_hash: hash(code),
  duration_days: days,
  batch_label: label,
  valid_until: validUntil,
}));

const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/recharge_codes`, {
  method: "POST",
  headers: {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    Prefer: "return=minimal",
  },
  body: JSON.stringify(rows),
});

if (!response.ok) {
  console.error(`Could not create recharge codes (${response.status}): ${await response.text()}`);
  process.exit(1);
}

console.log(`Generated ${codes.length} single-use recharge code(s). Each adds ${days} day(s).`);
console.log(`Batch: ${label} | Redeem before: ${validUntil}`);
console.log("Save these now; only their SHA-256 hashes are stored in the database.\n");
codes.forEach((code) => console.log(code));
