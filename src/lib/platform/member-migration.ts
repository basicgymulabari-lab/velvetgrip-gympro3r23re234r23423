import { readSheet } from "read-excel-file/browser";
import { localPhoneDigits } from "../gym/phone";
import { localDateInput } from "../gym/calendar";
import type { Gender } from "@/lib/gym/types";

export const MAX_MIGRATION_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_MIGRATION_ROWS = 5000;

export const MIGRATION_FIELDS = [
  "name",
  "email",
  "phone",
  "gender",
  "dob",
  "address",
  "emergencyContact",
  "joinDate",
] as const;

export type MigrationField = (typeof MIGRATION_FIELDS)[number];
export type MigrationDraft = Record<MigrationField, string>;
export type MigrationRow = {
  rowNumber: number;
  draft: MigrationDraft;
  errors: Partial<Record<MigrationField, string>>;
  duplicate: boolean;
  allowDuplicate: boolean;
  serverOutcome?: "skipped" | "failed" | "unknown";
  serverMessage?: string;
  origin?: "file" | "manual";
  sourceMemberId?: string;
  activeMembership?: {
    id: string;
    planId: string;
    planName: string;
    endDate: string;
    frozen: boolean;
  } | null;
};

export type TransferItemOutcome = {
  source_member_id?: string | null;
  outcome?: string | null;
  message?: string | null;
};

export function transferResultNotice(input: {
  transferred: number;
  skipped: number;
  failed: number;
  results?: TransferItemOutcome[];
}) {
  const alreadyTransferredRows = (input.results ?? []).filter((item) =>
    item.outcome === "skipped" && /already been transferred|already transferred to /i.test(item.message ?? ""),
  );
  const alreadyTransferred = alreadyTransferredRows.length;
  const confirmedDestinations = Array.from(new Set(alreadyTransferredRows
    .map((item) => item.message?.trim().replace(/\s*No duplicate was created\.?$/i, ""))
    .filter((message): message is string => Boolean(message && /^Already transferred to /i.test(message)))));
  const destinationNote = confirmedDestinations.length > 0
    ? ` ${confirmedDestinations.slice(0, 3).join(" ")}${confirmedDestinations.length > 3 ? " More destinations are listed in Migration history → View rows." : ""}`
    : " Open Migration history → View rows to confirm the destination.";

  if (input.transferred === 0 && input.failed === 0 && input.skipped > 0 && alreadyTransferred === input.skipped) {
    return {
      tone: "warning" as const,
      message: `${input.skipped === 1 ? "This member is" : "These members are"} already at the previously confirmed destination. No duplicate was created. Gym-owner Pro controls workspace capacity; it does not upgrade a gym member or move this profile again.${destinationNote}`,
    };
  }

  return {
    tone: input.skipped > 0 || input.failed > 0 ? "warning" as const : "success" as const,
    message: `Transfer recorded: ${input.transferred} transferred, ${input.skipped} skipped, ${input.failed} failed.${alreadyTransferred > 0 ? ` Already-migrated rows were not duplicated.${destinationNote}` : " See Migration history for row details."}`,
  };
}

export type MigrationRosterViewState = "loading" | "error" | "empty" | "rows";

export function migrationRosterViewState(input: {
  loading: boolean;
  error: boolean;
  hasRows: boolean;
}): MigrationRosterViewState {
  if (input.loading) return "loading";
  if (input.error) return "error";
  return input.hasRows ? "rows" : "empty";
}

export function migrationHistoryViewState(input: {
  loading: boolean;
  error: boolean;
  hasRows: boolean;
}): MigrationRosterViewState {
  if (input.loading) return "loading";
  if (input.error) return "error";
  return input.hasRows ? "rows" : "empty";
}

export function destinationCapacityNotice(destination: {
  member_count: number;
  has_pro?: boolean;
  remaining_free_slots?: number | null;
}) {
  const count = Math.max(0, Math.trunc(destination.member_count || 0));
  if (typeof destination.has_pro !== "boolean") {
    return {
      tone: "warning" as const,
      message: "The migration preview could not verify this gym’s Pro status or free-plan headroom. Refresh the preview; the server will make the final eligibility check before any transfer.",
    };
  }
  if (destination.has_pro) {
    return {
      tone: "success" as const,
      message: `Gym-owner Pro is active · ${count.toLocaleString()} current roster members. Pro affects workspace capacity, not a member’s own membership status.`,
    };
  }
  if (typeof destination.remaining_free_slots !== "number") {
    return {
      tone: "warning" as const,
      message: `Free plan · ${count.toLocaleString()} current roster members. The free limit is 10; refresh the preview to verify remaining capacity.`,
    };
  }
  const slots = Math.max(0, Math.trunc(destination.remaining_free_slots));
  return {
    tone: "warning" as const,
    message: `Free plan · ${count.toLocaleString()} of 10 roster members · ${slots.toLocaleString()} free slot${slots === 1 ? "" : "s"} remaining. Larger transfers require Pro.`,
  };
}

/** Keep failed/unprocessed rows retryable, but drop members the server confirms moved. */
export function membersPendingTransferRetry(
  selectedMemberIds: string[],
  outcomes: TransferItemOutcome[],
) {
  const completed = new Set(
    outcomes
      .filter((item) => item.outcome === "transferred"
        || (item.outcome === "skipped" && /already (?:been )?transferred(?: to | from )/i.test(item.message ?? "")))
      .map((item) => item.source_member_id)
      .filter((id): id is string => Boolean(id)),
  );
  return selectedMemberIds.filter((id) => !completed.has(id));
}

/** Explain the full membership history included with selected member profiles. */
export function summarizeTransferSelection(
  selectedMemberIds: Iterable<string>,
  details: Record<string, { current_membership?: {
    active?: boolean;
    membership_count?: number;
    active_membership_count?: number;
    linked_payment_count?: number;
    linked_payment_total?: number;
    payment_currency?: string;
  } | null }>,
) {
  let selectedCount = 0;
  let activeMembershipCount = 0;
  let membershipCount = 0;
  let linkedPaymentCount = 0;
  let linkedPaymentTotal = 0;
  let paymentCurrency = "₹";
  let hasPaymentCurrency = false;
  let profileOnlyCount = 0;
  let missingPreviewCount = 0;

  for (const id of selectedMemberIds) {
    selectedCount += 1;
    const detail = details[id];
    if (!detail) {
      missingPreviewCount += 1;
    } else {
      const membership = detail.current_membership;
      const terms = Math.max(0, Math.trunc(membership?.membership_count ?? (membership ? 1 : 0)));
      const activeTerms = Math.max(0, Math.trunc(membership?.active_membership_count ?? (membership?.active ? 1 : 0)));
      const paymentCount = membership?.linked_payment_count ?? 0;
      const paymentTotal = membership?.linked_payment_total ?? 0;
      if (Number.isFinite(paymentCount)) linkedPaymentCount += Math.max(0, Math.trunc(paymentCount));
      if (Number.isFinite(paymentTotal)) linkedPaymentTotal += paymentTotal;
      if (!hasPaymentCurrency && membership?.payment_currency?.trim()) {
        paymentCurrency = membership.payment_currency.trim();
        hasPaymentCurrency = true;
      }
      membershipCount += terms;
      activeMembershipCount += activeTerms;
      if (terms === 0) profileOnlyCount += 1;
    }
  }

  return {
    selectedCount,
    membershipCount,
    activeMembershipCount,
    linkedPaymentCount,
    linkedPaymentTotal,
    paymentCurrency,
    profileOnlyCount,
    missingPreviewCount,
  };
}

export const FIELD_LABELS: Record<MigrationField, string> = {
  name: "Full name",
  email: "Email",
  phone: "Phone",
  gender: "Gender",
  dob: "Date of birth",
  address: "Address",
  emergencyContact: "Emergency contact",
  joinDate: "Join date",
};

const aliases: Record<MigrationField, string[]> = {
  name: ["name", "full name", "member name", "customer name"],
  email: ["email", "email address", "e mail"],
  phone: ["phone", "phone number", "mobile", "mobile number", "contact"],
  gender: ["gender", "sex"],
  dob: ["dob", "date of birth", "birth date", "birthday"],
  address: ["address", "home address"],
  emergencyContact: ["emergency contact", "emergency phone", "emergency number"],
  joinDate: ["join date", "joined", "joined date", "membership start"],
};

const emptyDraft = (): MigrationDraft => ({
  name: "",
  email: "",
  phone: "",
  gender: "",
  dob: "",
  address: "",
  emergencyContact: "",
  joinDate: "",
});

function cellText(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  return value == null ? "" : String(value).trim();
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const input = text.replace(/^\uFEFF/, "");

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ",") {
      row.push(field.trim());
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      row.push(field.trim());
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("The CSV file has an unclosed quoted field.");
  row.push(field.trim());
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

export async function readMigrationFile(file: File): Promise<{ headers: string[]; rows: string[][] }> {
  if (file.size > MAX_MIGRATION_FILE_BYTES) {
    throw new Error("File is larger than 8 MB. Split it into smaller files before importing.");
  }

  const extension = file.name.split(".").pop()?.toLowerCase();
  let rows: string[][];
  if (extension === "csv") {
    rows = parseCsvRows(await file.text());
  } else if (extension === "xlsx") {
    const sheet = await readSheet(file);
    rows = sheet.map((cells) => cells.map(cellText));
  } else {
    throw new Error("Choose a CSV or Excel .xlsx file. The older .xls format is not supported.");
  }

  const nonEmptyRows = rows.filter((candidate) => candidate.some((cell) => cell.trim() !== ""));
  if (nonEmptyRows.length < 2) throw new Error("The file needs a header row and at least one member.");
  const [rawHeaders, ...records] = nonEmptyRows;
  const headers = rawHeaders.map((header, index) => header.trim() || `Column ${index + 1}`);
  if (headers.length > 100) throw new Error("The file has too many columns (maximum 100).");
  if (records.length > MAX_MIGRATION_ROWS) {
    throw new Error(`The file contains more than ${MAX_MIGRATION_ROWS.toLocaleString()} rows. Split it before importing.`);
  }
  return { headers, rows: records };
}

export function suggestedColumnMapping(headers: string[]): Record<MigrationField, number | ""> {
  const normalized = headers.map((header) => header.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
  return Object.fromEntries(
    MIGRATION_FIELDS.map((field) => [field, normalized.findIndex((header) => aliases[field].includes(header))]),
  ) as Record<MigrationField, number | "">;
}

function validDate(value: string, optional: boolean): string | null {
  if (!value.trim()) return optional ? "" : null;
  const input = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/.exec(input);
  const dmy = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(input);
  const year = iso ? Number(iso[1]) : dmy ? Number(dmy[3]) : NaN;
  const month = iso ? Number(iso[2]) : dmy ? Number(dmy[2]) : NaN;
  const day = iso ? Number(iso[3]) : dmy ? Number(dmy[1]) : NaN;
  let parsed: Date;
  if (Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day)) {
    parsed = new Date(year, month - 1, day);
    if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return null;
  } else {
    parsed = new Date(input);
  }
  if (!Number.isFinite(parsed.getTime())) return null;
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  if (parsed > endOfToday) return null;
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
}

export function normalizeAndValidateDraft(source: Partial<MigrationDraft>): {
  draft: MigrationDraft;
  errors: Partial<Record<MigrationField, string>>;
} {
  const draft = { ...emptyDraft(), ...source };
  const errors: Partial<Record<MigrationField, string>> = {};
  draft.name = draft.name.trim();
  if (draft.name.length < 2) errors.name = "Enter a name with at least 2 characters.";
  else if (draft.name.length > 80) errors.name = "Name must be 80 characters or fewer.";

  draft.email = draft.email.trim().toLowerCase();
  if (draft.email && !/^\S+@\S+\.\S+$/.test(draft.email)) errors.email = "Enter a valid email address.";

  const phone = localPhoneDigits(draft.phone);
  if (phone.length !== 10) errors.phone = "Enter a 10-digit local phone number.";
  else draft.phone = phone;

  const gender = draft.gender.trim().toLowerCase();
  if (!(gender === "male" || gender === "female" || gender === "other")) {
    errors.gender = "Choose male, female, or other.";
  } else {
    draft.gender = gender as Gender;
  }

  const dob = validDate(draft.dob, false);
  if (!dob) errors.dob = "Enter a valid date of birth that is not in the future.";
  else draft.dob = dob;

  const joinDate = validDate(draft.joinDate, true);
  if (joinDate === null) errors.joinDate = "Enter a valid join date that is not in the future.";
  else draft.joinDate = joinDate || localDateInput(new Date());

  const emergency = localPhoneDigits(draft.emergencyContact);
  if (draft.emergencyContact.trim() && emergency.length !== 10) {
    errors.emergencyContact = "If provided, use a 10-digit local phone number.";
  } else if (emergency) {
    draft.emergencyContact = emergency;
  }
  draft.address = draft.address.trim();
  if (draft.address.length > 200) errors.address = "Address must be 200 characters or fewer.";
  return { draft, errors };
}

export function mapMigrationRows(
  headers: string[],
  records: string[][],
  mapping: Record<MigrationField, number | "">,
): MigrationRow[] {
  return records.map((record, index) => {
    const draft = emptyDraft();
    for (const field of MIGRATION_FIELDS) {
      const column = mapping[field];
      if (column !== "" && column >= 0) draft[field] = cellText(record[column]);
    }
    const validated = normalizeAndValidateDraft(draft);
    return {
      rowNumber: index + 2,
      draft: validated.draft,
      errors: validated.errors,
      duplicate: false,
      allowDuplicate: false,
    };
  });
}

export function findPossibleDuplicates(
  rows: MigrationRow[],
  existing: Array<{ email?: string | null; phone?: string | null }>,
): MigrationRow[] {
  const emails = new Set(existing.map((member) => member.email?.trim().toLowerCase()).filter(Boolean));
  const phones = new Set(existing.map((member) => localPhoneDigits(member.phone)).filter((phone) => phone.length === 10));
  const fileEmails = new Set<string>();
  const filePhones = new Set<string>();
  return rows.map((row) => {
    const email = row.draft.email.trim().toLowerCase();
    const phone = localPhoneDigits(row.draft.phone);
    const duplicate =
      (Boolean(email) && (emails.has(email) || fileEmails.has(email))) ||
      (phone.length === 10 && (phones.has(phone) || filePhones.has(phone)));
    if (email) fileEmails.add(email);
    if (phone) filePhones.add(phone);
    return { ...row, duplicate };
  });
}
