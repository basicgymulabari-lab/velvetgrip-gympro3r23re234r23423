import assert from "node:assert/strict";
import { createServer } from "vite";

process.env.IRONVAULT_LOGIC_TESTS = "1";
process.env.VITE_ENABLE_LOCAL_BILLING = "true";
// The developer may have a real Supabase `.env.local`; business-logic tests
// intentionally exercise the isolated local state model instead.
process.env.VITE_SUPABASE_URL = "";
process.env.VITE_SUPABASE_PUBLISHABLE_KEY = "";
process.env.SUPABASE_URL = "";
process.env.SUPABASE_PUBLISHABLE_KEY = "";

class MemoryStorage {
  #values = new Map();

  getItem(key) {
    return this.#values.get(key) ?? null;
  }

  setItem(key, value) {
    this.#values.set(key, String(value));
  }

  removeItem(key) {
    this.#values.delete(key);
  }

  clear() {
    this.#values.clear();
  }
}

globalThis.CustomEvent ??= class CustomEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail;
  }
};

globalThis.window = {
  localStorage: new MemoryStorage(),
  sessionStorage: new MemoryStorage(),
  navigator: { onLine: true },
  dispatchEvent: () => true,
};

const vite = await createServer({
  configFile: false,
  cacheDir: "node_modules/.vite-logic-tests",
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});

try {
  const store = await vite.ssrLoadModule("/src/lib/gym/store.ts");
  const cloud = await vite.ssrLoadModule("/src/lib/gym/cloud.ts");
  const billing = await vite.ssrLoadModule("/src/lib/billing/client.ts");
  const selectors = await vite.ssrLoadModule("/src/lib/gym/selectors.ts");
  const calendar = await vite.ssrLoadModule("/src/lib/gym/calendar.ts");
  const phone = await vite.ssrLoadModule("/src/lib/gym/phone.ts");
  const money = await vite.ssrLoadModule("/src/lib/gym/money.ts");
  const migration = await vite.ssrLoadModule("/src/lib/platform/member-migration.ts");
  assert.equal(
    await billing.withRequestDeadline(Promise.resolve("verified"), 50),
    "verified",
    "subscription verification should keep successful requests",
  );
  const gymPro = billing.subscriptionFromGymContext({
    subscription_status: "active",
    subscription_source: "manual",
    subscription_current_period_end: "2099-01-01T00:00:00.000Z",
  });
  assert.deepEqual(
    gymPro,
    {
      loaded: true,
      status: "active",
      source: "manual",
      currentPeriodEnd: "2099-01-01T00:00:00.000Z",
    },
    "the same gym-level Pro entitlement should be available to owner and receptionist contexts",
  );
  const legacyGymPro = billing.subscriptionFromGymContext({
    subscription_expires_at: "2099-01-01T00:00:00.000Z",
    subscription_expired: false,
  });
  assert.deepEqual(
    legacyGymPro,
    {
      loaded: true,
      status: "active",
      source: null,
      currentPeriodEnd: "2099-01-01T00:00:00.000Z",
    },
    "staff must retain the gym's Pro entitlement when an older deployed context returns legacy expiry fields",
  );
  const legacyReceptionistContext = cloud.cloudGymContextFrom({
    gym_id: "00000000-0000-0000-0000-000000000001",
    role: "receptionist",
    enabled: true,
    subscription_expires_at: "2099-01-01T00:00:00.000Z",
    subscription_expired: false,
  });
  assert.equal(legacyReceptionistContext?.subscriptionStatus, "active");
  assert.equal(
    legacyReceptionistContext?.subscriptionCurrentPeriodEnd,
    "2099-01-01T00:00:00.000Z",
    "legacy receptionist contexts must persist the shared Pro term for offline-session restoration",
  );
  assert.equal(
    billing.subscriptionFromGymContext({
      subscription_expires_at: "2000-01-01T00:00:00.000Z",
      subscription_expired: true,
    }).status,
    "expired",
    "expired legacy gym entitlements must remain expired",
  );
  assert.equal(
    billing.subscriptionFromGymContext({
      subscription_expires_at: null,
      subscription_expired: false,
    }).status,
    "free",
    "a legacy context without an active period must not grant Pro",
  );
  billing.setGymSubscriptionSnapshot(gymPro);
  assert.equal(
    billing.getSubscriptionSnapshot().active,
    true,
    "a receptionist must receive the gym's active Pro member allowance",
  );
  billing.setGymSubscriptionSnapshot({ status: "free", source: null, currentPeriodEnd: null });
  assert.deepEqual(
    billing.subscriptionFromGymContext({ subscription_status: "unknown" }),
    { loaded: true, status: "free", source: null, currentPeriodEnd: null },
    "unrecognized entitlement values must fail closed",
  );
  await assert.rejects(
    billing.withRequestDeadline(new Promise(() => {}), 1),
    /verification timed out/i,
    "stalled subscription checks must time out instead of leaving the app loading forever",
  );
  assert.equal(
    migration.migrationRosterViewState({ loading: true, error: false, hasRows: false }),
    "loading",
    "an empty roster must not be shown before its initial server response is complete",
  );
  assert.equal(
    migration.migrationRosterViewState({ loading: false, error: true, hasRows: false }),
    "error",
    "a failed roster request must not be presented as a successful empty search",
  );
  assert.equal(
    migration.migrationRosterViewState({ loading: false, error: false, hasRows: false }),
    "empty",
    "only a completed successful request with no rows should show the empty state",
  );
  assert.equal(
    migration.migrationRosterViewState({ loading: false, error: false, hasRows: true }),
    "rows",
  );
  assert.equal(
    migration.migrationHistoryViewState({ loading: true, error: false, hasRows: false }),
    "loading",
    "migration history must show loading rather than a false empty result",
  );
  assert.equal(
    migration.migrationHistoryViewState({ loading: false, error: true, hasRows: false }),
    "error",
    "a failed migration-history request must not appear as if there were no operations",
  );
  assert.equal(
    migration.migrationHistoryViewState({ loading: false, error: false, hasRows: false }),
    "empty",
    "only a successful history response with no rows should show the empty state",
  );
  assert.equal(
    migration.migrationHistoryViewState({ loading: false, error: false, hasRows: true }),
    "rows",
  );
  assert.match(
    migration.destinationCapacityNotice({ member_count: 4 }).message,
    /could not verify this gym’s Pro status or free-plan headroom/i,
    "a migration preview missing the backend entitlement fields explains the missing Pro/capacity status",
  );
  assert.match(
    migration.destinationCapacityNotice({ member_count: 14, has_pro: true }).message,
    /Gym-owner Pro is active.*14 current roster members.*not a member’s own membership status/i,
    "destination Pro is shown as a gym-owner workspace entitlement, separate from member membership status",
  );
  assert.match(
    migration.destinationCapacityNotice({ member_count: 9, has_pro: false, remaining_free_slots: 1 }).message,
    /9 of 10 roster members.*1 free slot remaining/i,
    "a free destination shows the exact remaining roster capacity",
  );
  assert.deepEqual(
    migration.membersPendingTransferRetry(["moved", "failed", "duplicate", "not-reached"], [
      { source_member_id: "moved", outcome: "transferred", message: "Profile transferred." },
      { source_member_id: "failed", outcome: "failed", message: "Free limit." },
      { source_member_id: "duplicate", outcome: "skipped", message: "Possible duplicate email or phone." },
      { source_member_id: "already-moved", outcome: "skipped", message: "This member has already been transferred from the source gym." },
    ]),
    ["failed", "duplicate", "not-reached"],
    "a failed transfer keeps unresolved rows retryable without selecting already-transferred members",
  );
  assert.deepEqual(
    migration.membersPendingTransferRetry(["already-moved"], [{
      source_member_id: "already-moved",
      outcome: "skipped",
      message: "Already transferred to My Gym — owner@example.invalid on 11 Oct 2026 10:00 UTC. No duplicate was created.",
    }]),
    [],
    "the detailed idempotent-retry response also removes an already-migrated row from the retry selection",
  );
  assert.deepEqual(
    migration.membersPendingTransferRetry(["atomic-rejection"], []),
    ["atomic-rejection"],
    "an atomic backend rejection retains every selected member for retry after the prerequisite is fixed",
  );
  assert.deepEqual(
    migration.summarizeTransferSelection(["active", "profile-only", "missing"], {
      active: { current_membership: { active: true, membership_count: 3, active_membership_count: 1 } },
      "profile-only": { current_membership: null },
    }),
    { selectedCount: 3, membershipCount: 3, activeMembershipCount: 1, profileOnlyCount: 1, missingPreviewCount: 1 },
    "migration confirmation counts every historical membership, profile-only transfers, and missing previews",
  );
  assert.deepEqual(
    migration.transferResultNotice({
      transferred: 0,
      skipped: 1,
      failed: 0,
      results: [{
        source_member_id: "already-moved",
        outcome: "skipped",
        message: "Already transferred to My Gym — owner@example.invalid on 11 Oct 2026 10:00 UTC. No duplicate was created.",
      }],
    }),
    {
      tone: "warning",
      message: "This member is already at the previously confirmed destination. No duplicate was created. Gym-owner Pro controls workspace capacity; it does not upgrade a gym member or move this profile again. Already transferred to My Gym — owner@example.invalid on 11 Oct 2026 10:00 UTC.",
    },
    "a safe replay explains the member is already at its destination and gym-owner Pro cannot upgrade the member",
  );
  assert.deepEqual(
    migration.transferResultNotice({
      transferred: 1,
      skipped: 1,
      failed: 0,
      results: [
        { source_member_id: "moved", outcome: "transferred" },
        { source_member_id: "duplicate", outcome: "skipped", message: "Possible duplicate email or phone." },
      ],
    }),
    {
      tone: "warning",
      message: "Transfer recorded: 1 transferred, 1 skipped, 0 failed. See Migration history for row details.",
    },
    "ordinary duplicate skips keep the standard transfer summary",
  );
  const { csvText } = await vite.ssrLoadModule("/src/lib/gym/csv.ts");
  const monthCheckNow = new Date("2026-10-11T12:00:00+05:45");
  assert.equal(
    selectors.isInCurrentMonthToDate("2026-10-01", monthCheckNow),
    true,
    "month-to-date includes the first local calendar day",
  );
  assert.equal(
    selectors.isInCurrentMonthToDate("2026-10-11", monthCheckNow),
    true,
    "date-only values are interpreted as local calendar dates",
  );
  assert.equal(
    selectors.isInCurrentMonthToDate("2026-10-12", monthCheckNow),
    false,
    "month-to-date excludes future dates even in the current month",
  );
  assert.equal(
    selectors.isInCurrentMonthToDate("2026-11-01", monthCheckNow),
    false,
    "month-to-date excludes dates in future months",
  );
  assert.equal(
    selectors.isInCurrentMonthToDate("invalid", monthCheckNow),
    false,
    "month-to-date ignores invalid date values",
  );
  assert.equal(
    selectors.isInCurrentMonthToDate("2026-02-29", new Date(2026, 2, 15)),
    false,
    "month-to-date rejects invalid calendar dates instead of normalizing into a different month",
  );
  const previousTimeZone = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    const dayAfterDaylightSaving = new Date(2026, 2, 9, 12);
    assert.equal(
      selectors.daysUntil("2026-03-08", dayAfterDaylightSaving),
      -1,
      "date-only expiry is not shifted by the local timezone",
    );
    assert.equal(
      selectors.daysUntil("2026-03-08T12:00:00-08:00", dayAfterDaylightSaving),
      -1,
      "expiry day counts remain correct across a 23-hour daylight-saving day",
    );
    assert.equal(
      selectors.membershipDaysLeft({
        endDate: "2026-03-08T12:00:00-08:00",
        frozen: true,
        frozenAt: "2026-03-09T12:00:00-07:00",
      }),
      -1,
      "frozen membership days use calendar days across daylight-saving transitions",
    );
    assert.equal(
      selectors.birthdayOffset("1990-03-10", dayAfterDaylightSaving),
      1,
      "date-only birthdays retain their intended local calendar day",
    );
    assert.equal(
      calendar.localDateInput(calendar.parseCalendarDate("2026-03-10")),
      "2026-03-10",
      "date-only values round-trip as local calendar dates",
    );
    assert.equal(
      calendar.localDateInput(calendar.parseCalendarDate("2026-10-01")),
      "2026-10-01",
      "an imported date-only join date remains on the same local day in US timezones",
    );
    assert.equal(
      selectors.isInCurrentMonthToDate("2026-10-01", new Date(2026, 9, 1, 12)),
      true,
      "an imported date-only join date is included in the correct local month",
    );
  } finally {
    if (previousTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimeZone;
  }
  assert.equal(csvText([["=1+1", 'A,"B', 12]]), '\uFEFF"\'=1+1","A,""B","12"');
  assert.equal(money.addMoney(100.15, 240.35), 340.5);
  assert.throws(
    () => money.addMoney(90_000_000_000_000, 90_000_000_000_000),
    /Monetary value is too large/,
    "a currency total beyond safe minor-unit precision must not be silently rounded",
  );
  assert.throws(
    () => money.sumMoney([90_000_000_000_000, 90_000_000_000_000], (amount) => amount),
    /Monetary value is too large/,
    "aggregate revenue must retain exact minor-unit precision",
  );
  assert.equal(
    money.sumMoney(
      [90_000_000_000_000, 90_000_000_000_000, -90_000_000_000_000],
      (amount) => amount,
    ),
    90_000_000_000_000,
    "large intermediate aggregate totals may cancel if the final exact amount is representable",
  );
  assert.throws(
    () => money.subtractMoney(90_000_000_000_000, -90_000_000_000_000),
    /Monetary value is too large/,
    "currency subtraction must reject unsafe results rather than lose cents",
  );
  const migrationDraft = {
    name: " Aarati Karki ",
    email: "AARATI@example.com",
    phone: "+977 9812345678",
    gender: "female",
    dob: "1995-03-10",
    address: " Kathmandu ",
    emergencyContact: "",
    joinDate: "2024-04-01",
  };
  const normalizedMigration = migration.normalizeAndValidateDraft(migrationDraft);
  assert.deepEqual(normalizedMigration.errors, {}, "member migration accepts valid member data");
  assert.equal(normalizedMigration.draft.name, "Aarati Karki");
  assert.equal(normalizedMigration.draft.phone, "9812345678");
  assert.equal(normalizedMigration.draft.email, "aarati@example.com");
  assert.equal(
    migration.normalizeAndValidateDraft({
      ...migrationDraft,
      phone: "123",
      address: "x".repeat(201),
    }).errors.phone,
    "Enter a 10-digit local phone number.",
  );
  assert.equal(
    migration.normalizeAndValidateDraft({ ...migrationDraft, address: "x".repeat(201) }).errors
      .address,
    "Address must be 200 characters or fewer.",
    "overlong addresses must be rejected rather than silently truncated",
  );
  assert.equal(
    migration.normalizeAndValidateDraft({ ...migrationDraft, dob: "2025-02-30" }).errors.dob,
    "Enter a valid date of birth that is not in the future.",
  );
  const mappedHeaders = migration.suggestedColumnMapping(["Member Name", "Phone Number", "DOB"]);
  assert.equal(mappedHeaders.name, 0);
  assert.equal(mappedHeaders.phone, 1);
  assert.equal(mappedHeaders.dob, 2);
  const parsedMigrationRows = migration.mapMigrationRows(
    ["Member Name", "Phone Number", "DOB"],
    [["Suman Thapa", "9800000001", "1994-06-12"]],
    mappedHeaders,
  );
  const duplicateMigrationRows = migration.findPossibleDuplicates(parsedMigrationRows, [
    { email: null, phone: "+977 9800000001" },
  ]);
  assert.equal(
    duplicateMigrationRows[0].duplicate,
    true,
    "phone contact matches are surfaced for review",
  );
  const migrationStressRows = Array.from({ length: 5000 }, (_, index) => ({
    rowNumber: index + 2,
    draft: {
      ...normalizedMigration.draft,
      name: `Migration stress member ${index}`,
      email: `migration-stress-${index}@example.test`,
      phone: String(9800000000 + index),
    },
    errors: {},
    duplicate: false,
    allowDuplicate: false,
  }));
  migrationStressRows.at(-1).draft = {
    ...migrationStressRows.at(-1).draft,
    email: migrationStressRows[0].draft.email,
    phone: migrationStressRows[0].draft.phone,
  };
  const migrationStressResults = migration.findPossibleDuplicates(migrationStressRows, []);
  assert.equal(migrationStressResults.length, 5000, "duplicate preview handles the maximum supported migration size");
  assert.equal(migrationStressResults.filter((row) => row.duplicate).length, 1, "duplicate preview detects an in-file duplicate at scale");
  assert.equal(migrationStressResults.at(-1).duplicate, true);
  const migrationCsv = new File(
    ['Member Name,Phone Number,DOB\n"Riya, ""Riri"" Sharma",9800000002,1996-08-17'],
    "members.csv",
    { type: "text/csv" },
  );
  const migrationCsvRows = await migration.readMigrationFile(migrationCsv);
  assert.equal(
    migrationCsvRows.rows[0][0],
    'Riya, "Riri" Sharma',
    "CSV quoting preserves commas and quotes in names",
  );
  assert.equal(migrationCsvRows.headers.length, 3);
  await assert.rejects(
    migration.readMigrationFile(new File(['Name,Phone\n"unclosed'], "bad.csv")),
    /unclosed quoted field/,
  );
  const { anonymizeDemoContacts } = await vite.ssrLoadModule("/src/lib/gym/demo-contacts.ts");
  const { buildSeed } = await vite.ssrLoadModule("/src/lib/gym/seed.ts");
  const demoState = buildSeed();

  // Stress the selectors used by the dashboard using disposable in-memory data.
  // This never loads or writes a real gym workspace.
  const stressState = structuredClone(demoState);
  const stressMemberCount = 5000;
  const stressMember = demoState.members[0];
  const stressPlan = demoState.plans[0];
  const stressNow = new Date();
  const stressMembershipEnd = new Date(
    stressNow.getTime() + 45 * 24 * 60 * 60 * 1000,
  ).toISOString();
  stressState.members = Array.from({ length: stressMemberCount }, (_, index) => ({
    ...stressMember,
    id: `stress-member-${index}`,
    type: "member",
    name: `Stress member ${index}`,
    email: `stress-member-${index}@example.test`,
    deletedAt: null,
  }));
  stressState.memberships = stressState.members.map((member, index) => ({
    id: `stress-membership-${index}`,
    memberId: member.id,
    planId: stressPlan.id,
    startDate: stressNow.toISOString(),
    endDate: stressMembershipEnd,
    price: 1000,
    discount: 0,
    joiningFee: 0,
    frozen: false,
    createdAt: stressNow.toISOString(),
  }));
  stressState.payments = stressState.memberships.map((membership, index) => ({
    id: `stress-payment-${index}`,
    invoiceNo: `STRESS-${index}`,
    memberId: membership.memberId,
    membershipId: membership.id,
    kind: "membership",
    amount: 500,
    method: "cash",
    date: stressNow.toISOString(),
  }));
  stressState.sales = [];

  const membershipFollowUpState = structuredClone(stressState);
  const unassignedMember = {
    ...stressMember,
    id: "follow-up-no-membership",
    name: "Follow-up without a term",
    type: "member",
    deletedAt: null,
  };
  const expiredTermMember = {
    ...stressMember,
    id: "follow-up-expired-term",
    name: "Follow-up with expired term",
    type: "member",
    deletedAt: null,
  };
  const expiredTermEnd = new Date(stressNow.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
  membershipFollowUpState.members.push(unassignedMember, expiredTermMember);
  membershipFollowUpState.memberships.push({
    id: "follow-up-expired-membership",
    memberId: expiredTermMember.id,
    planId: stressPlan.id,
    startDate: new Date(stressNow.getTime() - 32 * 24 * 60 * 60 * 1000).toISOString(),
    endDate: expiredTermEnd,
    price: 1000,
    discount: 0,
    joiningFee: 0,
    frozen: false,
    createdAt: new Date(stressNow.getTime() - 32 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const followUpRows = selectors.membershipRoster(membershipFollowUpState);
  const dashboardExpiredCount = selectors.gymMembers(membershipFollowUpState).filter(
    (member) => selectors.statusOf(membershipFollowUpState, member.id) === "expired",
  ).length;
  assert.equal(
    followUpRows.filter((row) => row.status === "expired").length,
    dashboardExpiredCount,
    "membership follow-up expired count matches actual expired terms, not unassigned profiles",
  );
  assert.equal(
    followUpRows.find((row) => row.member.id === unassignedMember.id)?.ms,
    undefined,
    "members without a membership term remain visible in lifecycle follow-up rows",
  );
  assert.equal(
    followUpRows.find((row) => row.member.id === unassignedMember.id)?.status,
    "unassigned",
    "a profile without a membership term is distinct from an expired membership",
  );
  assert.equal(
    followUpRows.find((row) => row.member.id === expiredTermMember.id)?.status,
    "expired",
    "a member with an actually expired membership term remains in follow-up",
  );

  assert.equal(
    stressState.members.filter((member) => {
      const status = selectors.statusOf(stressState, member.id);
      return selectors.isCurrentMemberStatus(status);
    }).length,
    stressMemberCount,
    "membership status selectors handle a 5,000-member workspace",
  );
  assert.equal(selectors.isCurrentMemberStatus("active"), true);
  assert.equal(selectors.isCurrentMemberStatus("expiring"), true);
  assert.equal(selectors.isCurrentMemberStatus("expired"), false);
  assert.equal(selectors.isCurrentMemberStatus("frozen"), false);
  assert.equal(selectors.dueFor(stressState, "stress-member-0"), 500);
  assert.equal(selectors.totalDue(stressState), stressMemberCount * 500);
  assert.deepEqual(selectors.planDistribution(stressState), [
    { name: stressPlan.name, value: stressMemberCount },
  ]);
  const mixedMembershipState = {
    ...stressState,
    memberships: stressState.memberships.map((membership, index) =>
      index === 0
        ? { ...membership, frozen: true }
        : index === 1
          ? {
              ...membership,
              endDate: new Date(stressNow.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(),
            }
          : membership,
    ),
  };
  assert.deepEqual(
    selectors.activePlanDistribution(mixedMembershipState),
    [{ name: stressPlan.name, value: stressMemberCount - 2 }],
    "dashboard plan chart excludes frozen and expired memberships",
  );
  assert.deepEqual(
    selectors.planDistribution(mixedMembershipState),
    [{ name: stressPlan.name, value: stressMemberCount }],
    "reports retain whole-roster plan distribution",
  );
  assert.equal(
    selectors
      .buildNotifications(stressState)
      .filter((notification) => notification.category === "due").length,
    stressMemberCount,
    "due notifications remain complete at larger roster sizes",
  );
  assert.equal(selectors.paymentsWithNames(stressState).length, stressMemberCount);
  const revisedStressState = {
    ...stressState,
    payments: stressState.payments.map((payment, index) =>
      index === 0 ? { ...payment, amount: 1000 } : payment,
    ),
  };
  assert.equal(
    selectors.dueFor(revisedStressState, "stress-member-0"),
    0,
    "selector indexes refresh when the immutable workspace revision changes",
  );

  assert.deepEqual(
    demoState.members.map((member) => member.name),
    [
      "Aarati Karki",
      "Suman Thapa",
      "Bikash Gurung",
      "Prakash Rai",
      "Nabin Shrestha",
      "Sabina Tamang",
      "Pooja Adhikari",
      "Ramesh K.C.",
      "Samikshya Bhandari",
      "Dipesh Poudel",
      "Sunita Magar",
      "Sandesh Lama",
      "Manisha Basnet",
      "Utsav Khadka",
      "Kriti Gurung",
      "Ashish Ghimire",
    ],
    "starter members use the requested Nepali names",
  );
  demoState.sales.forEach((sale) => {
    assert.equal(sale.discount, 0, "starter sales provide the required non-negative discount");
    assert.equal(sale.paid, sale.total, "starter sales persist their fully collected amount");
  });
  assert(
    demoState.members.every((m) => m.phone === "0000000000" && m.email.endsWith("@example.com")),
  );
  const editedDemo = structuredClone(demoState);
  // Legacy starter rows are still recognized and anonymized after the current
  // starter roster changes to Nepali names.
  editedDemo.members[0].name = "Priya Sharma";
  editedDemo.members[0].phone = "+91 98200 41122";
  editedDemo.members[0].email = "priya.sharma@mail.com";
  const sanitizedDemo = anonymizeDemoContacts(editedDemo);
  assert.equal(sanitizedDemo.members[0].phone, "0000000000");
  assert.equal(sanitizedDemo.members[0].email, "demo.member1@example.com");
  editedDemo.members[0].phone = "custom phone";
  editedDemo.members[0].email = "custom@example.com";
  assert.equal(anonymizeDemoContacts(editedDemo).members[0].phone, "custom phone");
  assert.equal(anonymizeDemoContacts(editedDemo).members[0].email, "custom@example.com");
  const { newWorkspace } = await vite.ssrLoadModule("/src/lib/gym/new-workspace.ts");
  const newOwner = newWorkspace("new-owner@example.com", "New Owner", "New Gym");
  assert.equal(newOwner.settings.gymName, "New Gym");
  assert.equal(newOwner.auth.email, "new-owner@example.com");
  assert.equal(newOwner.auth.passwordHash, "", "cloud owners must not inherit the demo password");
  for (const key of [
    "members",
    "plans",
    "memberships",
    "payments",
    "products",
    "sales",
    "expenses",
    "inquiries",
    "activities",
    "readNotifications",
  ]) {
    assert.deepEqual(newOwner[key], [], `new owner must not inherit ${key}`);
  }
  assert.deepEqual(newOwner.staff, {}, "new owners must not inherit another gym's receptionist");
  newOwner.settings.gymName = "Modified";
  assert.equal(
    newWorkspace("second@example.com").settings.gymName,
    "My Gym",
    "workspaces must be independent",
  );
  store.__setStateForLogicTests(demoState);
  const bulkNotificationIds = Array.from({ length: 690 }, (_, index) => `bulk-notification-${index}`);
  store.__setStateForLogicTests({ ...demoState, readNotifications: ["previously-read"] });
  assert.equal(store.markNotificationsRead(bulkNotificationIds), true);
  assert.equal(
    store.getState().readNotifications.length,
    691,
    "marking more than 500 notifications read must retain every ID and prior read state",
  );
  assert(store.getState().readNotifications.includes(bulkNotificationIds[0]));
  assert(store.getState().readNotifications.includes(bulkNotificationIds.at(-1)));
  store.__setStateForLogicTests(demoState);

  const checkInState = structuredClone(buildSeed(10));
  const checkInMember = checkInState.members.find(
    (member) =>
      !member.deletedAt &&
      member.type !== "walk_in" &&
      checkInState.memberships.some((item) => item.memberId === member.id),
  );
  assert(checkInMember, "check-in tests need a member with a membership term");
  const checkInMembership = selectors.currentMembership(checkInState, checkInMember.id);
  assert(checkInMembership);
  checkInMembership.endDate = calendar.localDateInput(new Date(Date.now() + 15 * selectors.DAY));
  checkInMembership.frozen = false;
  checkInMembership.frozenAt = null;
  store.__setStateForLogicTests(checkInState);
  assert.equal(store.checkInMember(checkInMember.id), true);
  assert.equal(
    selectors.hasCheckedInToday(
      store.getState().members.find((member) => member.id === checkInMember.id),
    ),
    true,
    "a successful check-in records the member's last visit for today",
  );
  assert.equal(
    store.checkInMember(checkInMember.id),
    false,
    "a member cannot accidentally be checked in twice on the same local day",
  );
  const laterCheckInState = structuredClone(store.getState());
  laterCheckInState.members.find((member) => member.id === checkInMember.id).lastCheckInAt =
    new Date(Date.now() - 2 * selectors.DAY).toISOString();
  store.__setStateForLogicTests(laterCheckInState);
  assert.equal(store.checkInMember(checkInMember.id), true, "the member can check in again on a later day");
  assert.equal(
    store.getState().activities.filter((activity) => activity.type === "member_checked_in").length,
    2,
    "successful visits are visible in the activity feed",
  );

  const expiredCheckInState = structuredClone(checkInState);
  selectors.currentMembership(expiredCheckInState, checkInMember.id).endDate =
    calendar.localDateInput(new Date(Date.now() - 2 * selectors.DAY));
  store.__setStateForLogicTests(expiredCheckInState);
  assert.equal(store.checkInMember(checkInMember.id), false, "expired memberships cannot check in");
  const frozenCheckInState = structuredClone(checkInState);
  selectors.currentMembership(frozenCheckInState, checkInMember.id).frozen = true;
  store.__setStateForLogicTests(frozenCheckInState);
  assert.equal(store.checkInMember(checkInMember.id), false, "frozen memberships cannot check in");
  const walkInCheckInState = structuredClone(checkInState);
  walkInCheckInState.members.find((member) => member.id === checkInMember.id).type = "walk_in";
  store.__setStateForLogicTests(walkInCheckInState);
  assert.equal(store.checkInMember(checkInMember.id), false, "walk-in customers are not member check-ins");
  store.__setStateForLogicTests(demoState);

  const assertIntegrity = (state) => {
    const unique = (items, label) => {
      const ids = items.map((item) => item.id);
      assert.equal(new Set(ids).size, ids.length, `${label} IDs must be unique`);
    };

    unique(state.members, "member");
    unique(state.memberships, "membership");
    unique(state.payments, "payment");
    unique(state.plans, "plan");
    unique(state.products, "product");
    unique(state.sales, "sale");
    unique(state.expenses ?? [], "expense");
    unique(state.inquiries ?? [], "inquiry");

    const memberIds = new Set(state.members.map((item) => item.id));
    const planIds = new Set(state.plans.map((item) => item.id));
    const membershipIds = new Set(state.memberships.map((item) => item.id));
    const saleIds = new Set(state.sales.map((item) => item.id));

    state.memberships.forEach((item) => {
      assert(memberIds.has(item.memberId), `membership ${item.id} has a missing member`);
      assert(planIds.has(item.planId), `membership ${item.id} has a missing plan`);
      assert(item.price >= 0 && item.discount >= 0 && item.discount <= item.price);
      assert((item.joiningFee ?? 0) >= 0);
      assert(new Date(item.endDate) >= new Date(item.startDate));
    });
    state.payments.forEach((item) => {
      assert(item.amount > 0, `payment ${item.id} must be positive`);
      if (item.memberId) assert(memberIds.has(item.memberId));
      if (item.membershipId) assert(membershipIds.has(item.membershipId));
      if (item.saleId) assert(saleIds.has(item.saleId));
    });
    state.sales.forEach((item) => {
      if (item.memberId) assert(memberIds.has(item.memberId));
      assert(item.qty > 0 && item.total >= 0);
      assert(selectors.salePaid(state, item) <= item.total);
    });
    state.products.forEach((item) => {
      assert(item.stock >= 0 && item.cost >= 0 && item.price >= 0);
    });
    state.plans.forEach((item) => assert((item.joiningFee ?? 0) >= 0));

    assert.equal(
      selectors.totalRevenue(state),
      state.payments.reduce((sum, payment) => sum + payment.amount, 0),
    );
    assert(selectors.totalDue(state) >= 0);
  };

  assert.equal(
    await store.setupTemplateData(),
    true,
    "free workspaces can load starter template data",
  );
  let state = store.getState();
  assert.equal(state.members.length, 10, "free starter data stays within the included roster");
  assertIntegrity(state);
  const firstTemplateMemberIds = new Set(state.members.map((member) => member.id));
  assert(state.expenses.length > 0, "starter data must exercise expense reporting");
  assert.equal(selectors.rangeWindow("monthly").start.getDate(), 1);
  billing.activateLocalPro(30);
  assert.equal(await store.setupTemplateData(), true, "Pro workspaces can load the full template");
  state = store.getState();
  assert.equal(state.members.length, 16);
  assert(
    state.members.every((member) => !firstTemplateMemberIds.has(member.id)),
    "repeated template setup must not reuse source-member IDs retained by the CEO migration ledger",
  );
  assertIntegrity(state);
  billing.resetLocalPro();

  // Exercise the cloud-backed template path against an isolated fake Supabase
  // workspace whose revision has advanced in another tab/device.
  store.__setStateForLogicTests(buildSeed(10));
  let remoteState = newWorkspace("cloud-owner@example.com", "Cloud Owner", "Latest Cloud Gym");
  let remoteRevision = 12;
  const cloudContext = {
    gymId: "test-gym",
    role: "owner",
    permissions: {},
    displayName: "Cloud Owner",
    email: "cloud-owner@example.com",
    enabled: true,
    gymName: "Latest Cloud Gym",
    accountStatus: "active",
    subscriptionExpired: false,
  };
  store.__setCloudWorkspaceIOForLogicTests({
    ownerId: "test-owner",
    gymId: cloudContext.gymId,
    revision: 10,
    load: async () => ({
      ...cloudContext,
      state: structuredClone(remoteState),
      revision: remoteRevision,
    }),
    save: async (nextState, expectedRevision) => {
      assert.equal(
        expectedRevision,
        remoteRevision,
        "template save must use the latest cloud revision",
      );
      remoteState = structuredClone(nextState);
      return ++remoteRevision;
    },
  });
  assert.equal(
    await store.setupTemplateData(),
    true,
    "stale clients refresh before setting up templates",
  );
  assert.equal(remoteState.members.length, 10);
  assert.equal(
    remoteState.settings.gymName,
    "Latest Cloud Gym",
    "cloud gym settings survive template setup",
  );
  assert.equal(store.getState().members.length, 10);

  remoteState = structuredClone(remoteState);
  remoteState.products[0].name = "Updated from another tab";
  remoteRevision += 1;
  assert.equal(
    await store.refreshCloudWorkspaceIfNewer(),
    true,
    "open gym views pull newer cloud revisions",
  );
  assert.equal(store.getState().products[0].name, "Updated from another tab");
  assert.equal(
    await store.refreshCloudWorkspaceIfNewer(),
    false,
    "an already-current view does not reload",
  );

  // A save may commit in Supabase while its HTTP acknowledgement is lost.
  // The client must verify the exact committed payload and advance its
  // revision, rather than leaving the sync indicator stuck on Retry forever.
  store.__setStateForLogicTests(buildSeed(10), {
    email: "qa-lost-ack-owner@example.test",
    role: "admin",
    name: "QA Lost Ack Owner",
    cloudUserId: "qa-lost-ack-owner",
    gymId: cloudContext.gymId,
    accountStatus: "active",
    subscriptionExpired: false,
    offlineMode: false,
  });
  remoteState = newWorkspace("qa-lost-ack-owner@example.test", "QA Lost Ack Owner", "Latest Cloud Gym");
  remoteRevision = 25;
  store.__setCloudWorkspaceIOForLogicTests({
    ownerId: "qa-lost-ack-owner",
    gymId: cloudContext.gymId,
    revision: remoteRevision,
    load: async () => ({
      ...cloudContext,
      state: structuredClone(remoteState),
      revision: remoteRevision,
    }),
    save: async (nextState, expectedRevision) => {
      assert.equal(expectedRevision, remoteRevision);
      remoteState = structuredClone(nextState);
      remoteRevision += 1;
      throw new Error("response lost after database commit");
    },
  });
  assert.equal(store.savePlan({
    name: "Confirmed despite lost response",
    price: 1,
    durationDays: 30,
    description: "",
    active: true,
  }), true);
  const lostAckConsoleError = console.error;
  console.error = () => {};
  try {
    await new Promise((resolve) => setTimeout(resolve, 700));
  } finally {
    console.error = lostAckConsoleError;
  }
  assert(remoteState.plans.some((plan) => plan.name === "Confirmed despite lost response"));
  assert.equal(
    store.getCloudSyncStatus().pending,
    false,
    "a server-confirmed save does not leave a false pending-sync warning",
  );

  // When another tab advances the workspace revision, independent local edits
  // must be merged onto the newer cloud state and retried with its revision.
  const rebaseBase = buildSeed(10);
  store.__setStateForLogicTests(rebaseBase);
  remoteState = structuredClone(rebaseBase);
  remoteState.settings.tagline = "Saved from the other tab";
  const remotelyEditedMemberId = remoteState.members[0].id;
  remoteState.members[0] = { ...remoteState.members[0], name: "Remote tab member edit" };
  const locallyEditedMemberId = rebaseBase.members[1].id;
  remoteRevision = 41;
  let rebaseSaveAttempts = 0;
  store.__setCloudWorkspaceIOForLogicTests({
    ownerId: "qa-rebase-owner",
    gymId: cloudContext.gymId,
    revision: 40,
    load: async () => ({
      ...cloudContext,
      state: structuredClone(remoteState),
      revision: remoteRevision,
    }),
    save: async (nextState, expectedRevision) => {
      rebaseSaveAttempts += 1;
      if (expectedRevision !== remoteRevision) throw new Error("WORKSPACE_CONFLICT");
      remoteState = structuredClone(nextState);
      return ++remoteRevision;
    },
  });
  const rebaseConsoleError = console.error;
  console.error = () => {};
  try {
    assert.equal(store.savePlan({
      name: "Local tab plan",
      price: 120,
      durationDays: 30,
      description: "",
      active: true,
    }), true);
    assert.equal(
      store.updateMember(locallyEditedMemberId, { name: "Local tab member edit" }),
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 750));
  } finally {
    console.error = rebaseConsoleError;
  }
  assert.equal(rebaseSaveAttempts, 2, "the stale write is rebased and retried exactly once");
  assert(remoteState.plans.some((plan) => plan.name === "Local tab plan"));
  assert.equal(remoteState.settings.tagline, "Saved from the other tab");
  assert.equal(remoteState.members.find((member) => member.id === remotelyEditedMemberId)?.name, "Remote tab member edit");
  assert.equal(remoteState.members.find((member) => member.id === locallyEditedMemberId)?.name, "Local tab member edit");
  assert.equal(store.getCloudSyncStatus().pending, false);

  // If two tabs change the same field differently, keep each side intact and
  // explain the conflict instead of applying last-write-wins.
  const overlapBase = buildSeed(10);
  store.__setStateForLogicTests(overlapBase);
  remoteState = structuredClone(overlapBase);
  remoteState.settings.tagline = "Remote concurrent edit";
  remoteRevision = 52;
  store.__setCloudWorkspaceIOForLogicTests({
    ownerId: "qa-overlap-owner",
    gymId: cloudContext.gymId,
    revision: 51,
    load: async () => ({
      ...cloudContext,
      state: structuredClone(remoteState),
      revision: remoteRevision,
    }),
    save: async (_nextState, expectedRevision) => {
      assert.equal(expectedRevision, 51);
      throw new Error("WORKSPACE_CONFLICT");
    },
  });
  store.updateSettings({ tagline: "Local concurrent edit" });
  const overlapConsoleError = console.error;
  console.error = () => {};
  try {
    await new Promise((resolve) => setTimeout(resolve, 700));
  } finally {
    console.error = overlapConsoleError;
  }
  assert.equal(store.getState().settings.tagline, "Local concurrent edit");
  assert.equal(remoteState.settings.tagline, "Remote concurrent edit");
  assert.equal(store.getCloudSyncStatus().pending, true);
  assert.match(store.getCloudSyncStatus().message ?? "", /overlapping data.*settings\.tagline/i);

  store.__setStateForLogicTests(buildSeed(10));
  remoteState = newWorkspace("cloud-owner@example.com", "Cloud Owner", "Latest Cloud Gym");
  remoteState.products = [
    {
      id: "existing-product",
      name: "Existing cloud product",
      category: "Supplements",
      sku: "EXISTING-1",
      cost: 10,
      price: 20,
      stock: 1,
      lowStockAt: 0,
      createdAt: new Date().toISOString(),
    },
  ];
  remoteRevision = 20;
  store.__setCloudWorkspaceIOForLogicTests({
    ownerId: "test-owner",
    gymId: cloudContext.gymId,
    revision: remoteRevision,
    load: async () => ({
      ...cloudContext,
      state: structuredClone(remoteState),
      revision: remoteRevision,
    }),
    save: async () => {
      remoteState = structuredClone(remoteState);
      remoteState.products[0].name = "Newer product from another tab";
      remoteRevision += 1;
      throw new Error("WORKSPACE_CONFLICT");
    },
  });
  const failedLogoutConsoleError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(store.setupTemplateData(), /Template data could not be saved/);
  } finally {
    console.error = failedLogoutConsoleError;
  }
  assert.equal(
    store.getState().products[0].name,
    "Newer product from another tab",
    "a conflicting template save restores the latest cloud data instead of leaving a blank workspace",
  );

  store.__setStateForLogicTests(buildSeed(10));
  remoteState = newWorkspace("cloud-owner@example.com", "Cloud Owner", "Latest Cloud Gym");
  remoteRevision = 30;
  store.__setCloudWorkspaceIOForLogicTests({
    ownerId: "test-owner",
    gymId: cloudContext.gymId,
    revision: remoteRevision,
    load: async () => ({
      ...cloudContext,
      state: structuredClone(remoteState),
      revision: remoteRevision,
    }),
    save: async (nextState, expectedRevision) => {
      assert.equal(expectedRevision, remoteRevision);
      remoteState = structuredClone(nextState);
      remoteRevision += 1;
      throw new Error("response lost after database commit");
    },
  });
  const lostResponseConsoleError = console.error;
  console.error = () => {};
  try {
    assert.equal(
      await store.setupTemplateData(),
      true,
      "a committed template remains successful if only its network acknowledgement is lost",
    );
  } finally {
    console.error = lostResponseConsoleError;
  }
  assert.equal(remoteState.members.length, 10);
  assert.deepEqual(
    store.getState().members.map((member) => member.id),
    remoteState.members.map((member) => member.id),
    "the client adopts the server-confirmed template after an ambiguous save response",
  );
  assert.equal(
    store.getCloudSyncStatus().pending,
    false,
    "a server-confirmed template is not left marked as pending sync",
  );

  // A save already in flight for account A must not overwrite the revision
  // cursor after a new session has loaded account B.
  let finishAccountASave;
  let notifyAccountASaveStarted;
  const accountASaveStarted = new Promise((resolve) => {
    notifyAccountASaveStarted = resolve;
  });
  store.__setStateForLogicTests(buildSeed(10), {
    email: "qa-owner-a@example.test",
    role: "admin",
    name: "QA Owner A",
    cloudUserId: "qa-owner-a",
    gymId: "qa-gym-a",
    accountStatus: "active",
    subscriptionExpired: false,
    offlineMode: false,
  });
  store.__setCloudWorkspaceIOForLogicTests({
    ownerId: "qa-owner-a",
    gymId: "qa-gym-a",
    revision: 10,
    load: async () => null,
    save: async (_nextState, expectedRevision) => {
      assert.equal(expectedRevision, 10);
      notifyAccountASaveStarted();
      return await new Promise((resolve) => {
        finishAccountASave = resolve;
      });
    },
  });
  assert.equal(store.savePlan({
    name: "Account A pending save",
    price: 1,
    durationDays: 30,
    description: "",
    active: true,
  }), true);
  await accountASaveStarted;

  store.__setStateForLogicTests(buildSeed(10), {
    email: "qa-owner-b@example.test",
    role: "admin",
    name: "QA Owner B",
    cloudUserId: "qa-owner-b",
    gymId: "qa-gym-b",
    accountStatus: "active",
    subscriptionExpired: false,
    offlineMode: false,
  });
  let accountBExpectedRevision;
  let notifyAccountBSaveStarted;
  const accountBSaveStarted = new Promise((resolve) => {
    notifyAccountBSaveStarted = resolve;
  });
  store.__setCloudWorkspaceIOForLogicTests({
    ownerId: "qa-owner-b",
    gymId: "qa-gym-b",
    revision: 20,
    load: async () => null,
    save: async (_nextState, expectedRevision) => {
      accountBExpectedRevision = expectedRevision;
      notifyAccountBSaveStarted();
      return expectedRevision + 1;
    },
  });
  finishAccountASave(11);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.savePlan({
    name: "Account B pending save",
    price: 1,
    durationDays: 30,
    description: "",
    active: true,
  }), true);
  await accountBSaveStarted;
  assert.equal(
    accountBExpectedRevision,
    20,
    "a stale response from another account cannot replace the current cloud revision",
  );

  // Route revalidation must wait for a same-account save that's already
  // in flight before loading the server snapshot. This reproduces the
  // navigation race behind template/member data appearing to disappear.
  store.__setStateForLogicTests(buildSeed(10), {
    email: "qa-login-owner@example.test",
    role: "admin",
    name: "QA Login Owner",
    cloudUserId: "qa-login-owner",
    gymId: cloudContext.gymId,
    accountStatus: "active",
    subscriptionExpired: false,
    offlineMode: false,
  });
  remoteState = newWorkspace("qa-login-owner@example.test", "QA Login Owner", "Latest Cloud Gym");
  remoteRevision = 40;
  let loadCallsBeforePendingSave = 0;
  let finishPendingRouteSave;
  let notifyPendingRouteSaveStarted;
  const pendingRouteSaveStarted = new Promise((resolve) => {
    notifyPendingRouteSaveStarted = resolve;
  });
  store.__setCloudWorkspaceIOForLogicTests({
    ownerId: "qa-login-owner",
    gymId: cloudContext.gymId,
    revision: remoteRevision,
    load: async () => {
      loadCallsBeforePendingSave += 1;
      return {
        ...cloudContext,
        state: structuredClone(remoteState),
        revision: remoteRevision,
      };
    },
    save: async (nextState, expectedRevision) => {
      assert.equal(expectedRevision, 40);
      notifyPendingRouteSaveStarted();
      return await new Promise((resolve) => {
        finishPendingRouteSave = () => {
          remoteState = structuredClone(nextState);
          remoteRevision += 1;
          resolve(remoteRevision);
        };
      });
    },
  });
  store.__setCloudSessionIOForLogicTests({
    getIdentity: async () => ({
      id: "qa-login-owner",
      email: "qa-login-owner@example.test",
      name: "QA Login Owner",
      gymName: "Latest Cloud Gym",
    }),
    getContext: async () => cloudContext,
    ensureOwnerGym: async () => cloudContext,
    loadWorkspace: async () => ({
      ...cloudContext,
      state: structuredClone(remoteState),
      revision: remoteRevision,
    }),
    recordAuditEvent: async () => undefined,
  });
  assert.equal(
    store.savePlan({
      name: "Pending route save",
      price: 1,
      durationDays: 30,
      description: "",
      active: true,
    }),
    true,
  );
  const routeLogin = store.completeCloudLogin();
  await pendingRouteSaveStarted;
  assert.equal(
    loadCallsBeforePendingSave,
    0,
    "route validation does not read an older workspace while a save is in flight",
  );
  finishPendingRouteSave();
  assert.equal(await routeLogin, true);
  assert(
    store.getState().plans.some((plan) => plan.name === "Pending route save"),
    "route validation retains the confirmed pending edit",
  );

  // If the write cannot be confirmed, route validation must preserve the
  // local workspace instead of replacing it with an older server snapshot.
  store.__setStateForLogicTests(buildSeed(10), {
    email: "qa-login-owner@example.test",
    role: "admin",
    name: "QA Login Owner",
    cloudUserId: "qa-login-owner",
    gymId: cloudContext.gymId,
    accountStatus: "active",
    subscriptionExpired: false,
    offlineMode: false,
  });
  let staleLoadCalls = 0;
  store.__setCloudWorkspaceIOForLogicTests({
    ownerId: "qa-login-owner",
    gymId: cloudContext.gymId,
    revision: 50,
    load: async () => {
      staleLoadCalls += 1;
      return { ...cloudContext, state: structuredClone(remoteState), revision: 50 };
    },
    save: async () => {
      throw new Error("network unavailable");
    },
  });
  store.__setCloudSessionIOForLogicTests({
    getIdentity: async () => ({
      id: "qa-login-owner",
      email: "qa-login-owner@example.test",
      name: "QA Login Owner",
      gymName: "Latest Cloud Gym",
    }),
    getContext: async () => cloudContext,
    ensureOwnerGym: async () => cloudContext,
    loadWorkspace: async () => {
      staleLoadCalls += 1;
      return { ...cloudContext, state: structuredClone(remoteState), revision: 50 };
    },
    recordAuditEvent: async () => undefined,
  });
  store.savePlan({
    name: "Unsynced route save",
    price: 1,
    durationDays: 30,
    description: "",
    active: true,
  });
  const failedRouteSaveConsoleError = console.error;
  console.error = () => {};
  try {
    assert.equal(await store.completeCloudLogin(), true);
  } finally {
    console.error = failedRouteSaveConsoleError;
  }
  assert.equal(staleLoadCalls, 1, "a failed pending save performs only a read-only commit check");
  assert(
    store.getState().plans.some((plan) => plan.name === "Unsynced route save"),
    "a failed pending save stays available locally for retry",
  );
  assert.equal(store.getCloudSyncStatus().pending, true);
  const beforeUnloadEvent = {
    defaultPrevented: false,
    returnValue: "",
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  assert.equal(
    store.guardPendingCloudChangesBeforeUnload(beforeUnloadEvent),
    true,
    "the app warns before closing while cloud changes are pending",
  );
  assert.equal(beforeUnloadEvent.defaultPrevented, true);
  assert.equal(beforeUnloadEvent.returnValue, "");

  // A pending edit from a prior tenant must not be sent with a newly
  // authenticated account's token when the user switches accounts.
  store.__setStateForLogicTests(buildSeed(10), {
    email: "qa-previous-owner@example.test",
    role: "admin",
    name: "Previous Owner",
    cloudUserId: "qa-previous-owner",
    gymId: "qa-previous-gym",
    accountStatus: "active",
    subscriptionExpired: false,
    offlineMode: false,
  });
  let crossTenantSaveCalls = 0;
  let crossTenantLoadCalls = 0;
  store.__setCloudWorkspaceIOForLogicTests({
    ownerId: "qa-previous-owner",
    gymId: "qa-previous-gym",
    revision: 60,
    load: async () => {
      crossTenantLoadCalls += 1;
      return null;
    },
    save: async (_nextState, expectedRevision) => {
      crossTenantSaveCalls += 1;
      return expectedRevision + 1;
    },
  });
  store.__setCloudSessionIOForLogicTests({
    getIdentity: async () => ({
      id: "qa-new-owner",
      email: "qa-new-owner@example.test",
      name: "New Owner",
      gymName: "New Gym",
    }),
    getContext: async () => ({
      ...cloudContext,
      gymId: "qa-new-gym",
      email: "qa-new-owner@example.test",
      displayName: "New Owner",
      gymName: "New Gym",
    }),
    ensureOwnerGym: async () => {
      throw new Error("unexpected gym creation");
    },
    loadWorkspace: async () => {
      crossTenantLoadCalls += 1;
      return null;
    },
    recordAuditEvent: async () => undefined,
  });
  store.savePlan({
    name: "Previous tenant pending plan",
    price: 1,
    durationDays: 30,
    description: "",
    active: true,
  });
  await assert.rejects(store.completeCloudLogin(), /previous gym still has unsynchronized changes/);
  assert.equal(crossTenantSaveCalls, 0, "unsynced data is never posted to another tenant");
  assert.equal(crossTenantLoadCalls, 0, "another tenant workspace is not loaded over pending edits");
  assert(
    store.getState().plans.some((plan) => plan.name === "Previous tenant pending plan"),
    "the previous tenant's local edit remains recoverable in the open session",
  );

  store.__setStateForLogicTests(demoState);
  state = store.getState();
  store.updateSettings({ calendarSystem: "bikram_sambat" });
  assert.equal(selectors.shortDate(new Date(2026, 8, 2)), "17 Bhadra 2083");
  assert.equal(calendar.localDateInput(calendar.fromNepaliDate(2083, 4, 17)), "2026-09-02");
  store.updateSettings({ calendarSystem: "gregorian" });
  assert.equal(phone.phoneForCountry("+91 98765 43210", "nepal"), "+977 98765 43210");
  assert.equal(phone.phoneForCountry("98765 43210", "usa"), "+1 98765 43210");
  assert.equal(phone.phoneForCountry("+977", "nepal"), "");
  assert.equal(phone.phoneInputValue("", "nepal"), "+977 ");
  assert.equal(phone.phoneInputValue("9876543210123", "nepal"), "+977 9876543210");
  assert.equal(phone.localPhoneDigits("+977 9876543210"), "9876543210");

  const initialPlanCount = state.plans.length;
  assert.equal(
    store.savePlan({
      name: "Overflow plan",
      price: 90_000_000_000_000,
      joiningFee: 90_000_000_000_000,
      durationDays: 30,
      description: "",
      active: true,
    }),
    false,
    "plans whose price plus joining fee exceed safe currency precision must be rejected",
  );
  assert.equal(
    store.savePlan({
      name: "Fractional plan",
      price: 1000,
      joiningFee: 0,
      durationDays: 1.5,
      description: "",
      active: true,
    }),
    false,
    "membership durations must be whole days rather than silently floored",
  );
  assert.equal(store.getState().plans.length, initialPlanCount);

  const blockedMemberCount = state.members.length;
  assert.equal(
    store.addMember({
      name: "Blocked Free Member",
      email: "blocked-free@example.com",
      phone: "+91 90000 11111",
      gender: "other",
      dob: "1995-01-01T00:00:00.000Z",
      address: "Test address",
      emergencyContact: "+91 91111 11111",
    }),
    false,
    "free workspaces above the 10-member allowance must reject additional members",
  );
  assert.equal(store.getState().members.length, blockedMemberCount);

  // Bring the seeded demo down to nine active gym members so normal add-member
  // checks can exercise the final free slot.
  state.members
    .filter((member) => !member.deletedAt && member.type !== "walk_in")
    .slice(0, 7)
    .forEach((member) => store.trashMember(member.id, "Logic test"));
  state = store.getState();
  assert.equal(
    state.members.filter((member) => !member.deletedAt && member.type !== "walk_in").length,
    9,
  );

  const memberCount = state.members.length;
  assert.equal(
    store.addMember({
      name: "Logic Test Member",
      email: "logic@example.com",
      phone: "+91 90000 00000",
      gender: "other",
      dob: "1995-01-01T00:00:00.000Z",
      address: "Test address",
      emergencyContact: "+91 91111 11111",
      planId: "plan_monthly",
      startDate: "2030-01-10T00:00:00.000Z",
      joiningFee: 750,
      discount: 100,
      paidNow: 500,
      paymentMethod: "upi",
    }),
    true,
  );
  state = store.getState();
  assert.equal(state.members.length, memberCount + 1);
  const testMember = state.members.find((item) => item.email === "logic@example.com");
  assert(testMember);
  assert.equal(selectors.dueFor(state, testMember.id), 1650);

  const membership = selectors.currentMembership(state, testMember.id);
  assert(membership);
  assert.equal(membership.startDate.slice(0, 10), "2030-01-10");
  assert.equal(
    Math.round(
      (new Date(membership.endDate).getTime() - new Date(membership.startDate).getTime()) /
        selectors.DAY,
    ),
    state.plans.find((plan) => plan.id === membership.planId).durationDays,
  );
  assert.equal(
    state.payments.find((payment) => payment.membershipId === membership.id)?.method,
    "upi",
  );
  const paymentCountBeforeInvalidAmount = state.payments.length;
  assert.equal(
    store.addPayment({
      memberId: testMember.id,
      membershipId: membership.id,
      amount: Number.POSITIVE_INFINITY,
      method: "cash",
    }),
    false,
    "invalid membership payment amounts must be rejected without throwing",
  );
  assert.equal(store.getState().payments.length, paymentCountBeforeInvalidAmount);
  assert.equal(
    store.addPayment({
      memberId: testMember.id,
      membershipId: membership.id,
      amount: 0.001,
      method: "cash",
    }),
    false,
    "payments that round to zero minor units must not be recorded",
  );
  const trashedSeedMember = state.members.find(
    (item) => item.deletedAt && item.type !== "walk_in" && item.id !== testMember.id,
  );
  assert(trashedSeedMember);
  assert.equal(
    store.restoreMember(trashedSeedMember.id),
    false,
    "restoring a regular member must not bypass the free 10-member limit",
  );
  assert.equal(billing.isLocalBillingMode(), true);
  billing.activateLocalPro(30);
  assert.equal(billing.getSubscriptionSnapshot().active, true);
  assert.equal(billing.getSubscriptionSnapshot().source, "local");
  assert(billing.localSubscriptionDaysRemaining() >= 29);
  assert.equal(
    store.restoreMember(trashedSeedMember.id),
    true,
    "local Pro must unlock roster growth for pre-deployment subscription testing",
  );
  assert.equal(
    store.getState().members.filter((member) => !member.deletedAt && member.type !== "walk_in")
      .length,
    11,
  );

  const paymentsBeforeProfileOnly = store.getState().payments.length;
  assert.equal(
    store.addMember({
      name: "Profile Only Test Member",
      email: "profile-only@example.test",
      phone: "9000012347",
      gender: "other",
      dob: "",
      address: "Test address",
      emergencyContact: "",
    }),
    true,
    "a valid member profile can be saved without requiring a membership plan or date of birth",
  );
  state = store.getState();
  const profileOnlyMember = state.members.find(
    (item) => item.email === "profile-only@example.test",
  );
  assert(profileOnlyMember);
  assert.equal(selectors.membershipHistory(state, profileOnlyMember.id).length, 0);
  assert.equal(store.getState().payments.length, paymentsBeforeProfileOnly);
  assert.equal(
    store.renewMembership(profileOnlyMember.id, "plan_monthly", 0, 0, "cash", "2026-02-30"),
    false,
    "invalid calendar dates must not create membership terms",
  );
  assert.equal(
    store.renewMembership(testMember.id, "plan_monthly", 0, 0, "cash", "2026-10-01"),
    false,
    "a member with prior membership history cannot use initial-assignment date override",
  );
  assert.equal(
    store.renewMembership(profileOnlyMember.id, "plan_monthly", 0, 0, "cash", "2026-10-01"),
    true,
    "a profile-only member can receive a plan later using its actual start date",
  );
  state = store.getState();
  const assignedTerm = selectors.currentMembership(state, profileOnlyMember.id);
  assert(assignedTerm);
  assert.equal(calendar.localDateInput(new Date(assignedTerm.startDate)), "2026-10-01");
  assert.equal(selectors.membershipHistory(state, profileOnlyMember.id).length, 1);
  assert.equal(store.getState().payments.length, paymentsBeforeProfileOnly);
  assert.equal(
    store.getState().activities[0].title,
    "Membership assigned",
    "initial plan assignment should be distinguishable from a renewal in the activity log",
  );
  assert.equal(store.trashMember(profileOnlyMember.id, "Logic test cleanup"), true);

  assert.equal(
    store.savePlan({
      name: "High-value test plan",
      price: 90_000_000_000_000,
      joiningFee: 0,
      durationDays: 30,
      description: "Synthetic boundary test",
      active: true,
    }),
    true,
    "a plan with a representable individual price remains valid",
  );
  const highValuePlan = store.getState().plans.find((plan) => plan.name === "High-value test plan");
  assert(highValuePlan);
  const memberCountBeforeUnsafeCharge = store.getState().members.length;
  assert.equal(
    store.addMember({
      name: "Rejected Currency Member",
      email: "unsafe-charge@example.test",
      phone: "9000012345",
      gender: "other",
      dob: "1995-01-01",
      address: "Test",
      emergencyContact: "",
      planId: highValuePlan.id,
      joiningFee: 100_000_000_000,
      paidNow: 0,
    }),
    false,
    "member creation must reject a price-plus-joining-fee total beyond safe precision",
  );
  assert.equal(store.getState().members.length, memberCountBeforeUnsafeCharge);
  assert.equal(
    store.addMember({
      name: "Rejected Plan Member",
      email: "missing-plan@example.test",
      phone: "9000012346",
      gender: "other",
      dob: "1995-01-01",
      address: "Test",
      emergencyContact: "",
      planId: "missing-plan-id",
    }),
    false,
    "member creation must reject an unknown plan rather than silently omit its membership",
  );
  assert.equal(store.getState().members.length, memberCountBeforeUnsafeCharge);
  assert.equal(
    store.deletePlanPermanently(highValuePlan.id),
    false,
    "an active plan must not be permanently deleted outside Trash",
  );
  assert.equal(store.trashPlan(highValuePlan.id), true);
  assert.equal(store.deletePlanPermanently(highValuePlan.id), true);
  billing.expireLocalProNow();
  assert.equal(billing.getSubscriptionSnapshot().status, "expired");
  const anotherTrashedMember = store
    .getState()
    .members.find(
      (item) => item.deletedAt && item.type !== "walk_in" && item.id !== trashedSeedMember.id,
    );
  assert(anotherTrashedMember);
  assert.equal(
    store.restoreMember(anotherTrashedMember.id),
    false,
    "expired local Pro must immediately restore the free roster-growth restriction",
  );
  store.trashMember(trashedSeedMember.id, "Logic test cleanup");
  billing.resetLocalPro();
  assert.equal(billing.getSubscriptionSnapshot().status, "free");
  store.addPayment({
    memberId: testMember.id,
    membershipId: membership.id,
    amount: 1650,
    method: "cash",
  });
  assert.equal(selectors.dueFor(store.getState(), testMember.id), 0);

  const expenseCountBeforeInvalidAmount = store.getState().expenses.length;
  assert.equal(
    store.addExpense({
      title: "Invalid test expense",
      category: "Rent",
      amount: Number.POSITIVE_INFINITY,
      date: "2030-01-10T12:00:00.000Z",
      method: "cash",
    }),
    false,
    "invalid expense amounts must be rejected without throwing",
  );
  assert.equal(store.getState().expenses.length, expenseCountBeforeInvalidAmount);
  assert.equal(
    store.addExpense({
      title: "Rounded-to-zero test expense",
      category: "Rent",
      amount: 0.001,
      date: "2030-01-10T12:00:00.000Z",
      method: "cash",
    }),
    false,
    "expenses that round to zero minor units must not be stored",
  );

  const existingPlan = store.getState().plans.find((item) => item.id === "plan_monthly");
  assert(existingPlan);
  const planCountBeforeUnsafeDelete = store.getState().plans.length;
  assert.equal(
    store.deletePlanPermanently(existingPlan.id),
    false,
    "permanent plan deletion must require the plan to be in Trash",
  );
  assert.equal(store.getState().plans.length, planCountBeforeUnsafeDelete);
  const stateBeforeLockedDeleteChecks = structuredClone(store.getState());
  store.__setStateForLogicTests({
    ...stateBeforeLockedDeleteChecks,
    plans: [
      ...stateBeforeLockedDeleteChecks.plans,
      { ...existingPlan, id: "qa-locked-trashed-plan", locked: true, deletedAt: new Date().toISOString() },
    ],
    products: [
      ...stateBeforeLockedDeleteChecks.products,
      {
        id: "qa-locked-trashed-product",
        name: "Locked QA product",
        category: "Accessories",
        sku: "QA-LOCKED",
        cost: 1,
        price: 2,
        stock: 0,
        lowStockAt: 0,
        createdAt: new Date().toISOString(),
        locked: true,
        deletedAt: new Date().toISOString(),
      },
    ],
  });
  assert.equal(
    store.deletePlanPermanently("qa-locked-trashed-plan"),
    false,
    "locked plans must be retained even if a stale or malformed state puts them in Trash",
  );
  assert.equal(
    store.deleteProductPermanently("qa-locked-trashed-product"),
    false,
    "locked products must be retained even if a stale or malformed state puts them in Trash",
  );
  store.__setStateForLogicTests(stateBeforeLockedDeleteChecks);
  state = store.getState();
  const existingPlanSnapshot = JSON.stringify(existingPlan);
  assert.equal(
    store.savePlan({ ...existingPlan, price: Number.POSITIVE_INFINITY }),
    false,
    "non-finite plan prices must be rejected without throwing",
  );
  assert.equal(
    store.savePlan({ ...existingPlan, joiningFee: -1 }),
    false,
    "negative plan joining fees must be rejected",
  );
  assert.equal(
    store.savePlan({ ...existingPlan, price: 0.001 }),
    false,
    "plan prices that round to zero minor units must be rejected",
  );
  assert.equal(
    JSON.stringify(store.getState().plans.find((item) => item.id === existingPlan.id)),
    existingPlanSnapshot,
    "rejected plan edits must leave the saved plan unchanged",
  );
  assert.equal(
    store.savePlan({
      name: "Life Time",
      price: 100000,
      joiningFee: 1000,
      durationDays: 36_500,
      description: "Non-expiring test plan",
      active: true,
      locked: false,
      deletedAt: null,
    }),
    true,
  );
  state = store.getState();
  const lifetimePlan = state.plans.find((item) => item.name === "Life Time");
  assert(lifetimePlan);
  const activeSeedMember = state.members.find(
    (item) => !item.deletedAt && item.type !== "walk_in" && item.id !== testMember.id,
  );
  assert(activeSeedMember);
  store.trashMember(activeSeedMember.id, "Logic test");
  assert.equal(
    store.addMember({
      name: "Lifetime Test Member",
      email: "lifetime@example.com",
      phone: "+91 92222 22222",
      gender: "other",
      dob: "1990-01-01T00:00:00.000Z",
      address: "Test address",
      emergencyContact: "",
      planId: lifetimePlan.id,
      startDate: "2030-01-10T00:00:00.000Z",
      joiningFee: 1000,
      paidNow: 0,
      paymentMethod: "upi",
    }),
    true,
  );
  state = store.getState();
  const lifetimeMember = state.members.find((item) => item.email === "lifetime@example.com");
  assert(lifetimeMember);
  const lifetimeMembership = state.memberships.find(
    (item) => item.memberId === lifetimeMember.id && item.planId === lifetimePlan.id,
  );
  assert(lifetimeMembership);
  assert.equal(lifetimeMembership.endDate.startsWith("9999-12-31"), true);
  assert.equal(selectors.shortDate(lifetimeMembership.endDate), "Lifetime");

  assert.equal(
    store.addPayment({
      memberId: testMember.id,
      membershipId: membership.id,
      amount: 1,
      method: "cash",
    }),
    false,
    "overpayments must be rejected",
  );

  store.renewMembership(testMember.id, "plan_quarterly", 1000, 200);
  assert.equal(selectors.membershipHistory(store.getState(), testMember.id).length, 2);
  assert.equal(
    store.trashPlan("plan_quarterly"),
    true,
    "a plan with membership history can be moved to Trash without deleting its history",
  );
  assert.equal(
    store.deletePlanPermanently("plan_quarterly"),
    false,
    "plans referenced by membership history must be retained",
  );

  state = store.getState();
  const frozenMembership = selectors.currentMembership(state, testMember.id);
  assert.equal(
    store.toggleFreeze("membership-that-does-not-exist"),
    false,
    "a profile without a persisted membership term must not be reported as frozen",
  );
  assert.equal(
    selectors.membershipDaysLeft({
      endDate: "2026-10-10",
      frozen: true,
      frozenAt: "2026-10-01T12:00:00.000Z",
    }),
    9,
    "the membership table must show the remaining term as paused instead of aging past its saved end date",
  );
  const oldEnd = new Date(frozenMembership.endDate).getTime();
  const modified = structuredClone(state);
  const target = modified.memberships.find((item) => item.id === frozenMembership.id);
  target.frozen = true;
  target.frozenAt = new Date(Date.now() - 2 * selectors.DAY).toISOString();
  store.restoreBackup(JSON.stringify(modified));
  store.toggleFreeze(frozenMembership.id);
  const extended = selectors.currentMembership(store.getState(), testMember.id);
  assert.equal(extended.frozen, false);
  assert(new Date(extended.endDate).getTime() >= oldEnd + 2 * selectors.DAY - 5_000);

  state = store.getState();
  const product = selectors.liveProducts(state).find((item) => item.stock >= 2);
  assert(product);
  const productSnapshot = JSON.stringify(product);
  assert.equal(
    store.saveProduct({ ...product, cost: -1 }),
    false,
    "negative product cost must be rejected before changing inventory",
  );
  assert.equal(
    store.saveProduct({ ...product, price: Number.POSITIVE_INFINITY }),
    false,
    "non-finite product prices must be rejected without throwing",
  );
  assert.equal(
    store.saveProduct({ ...product, price: 0.001 }),
    false,
    "product prices that round to zero minor units must be rejected",
  );
  assert.equal(
    store.saveProduct({ ...product, stock: 1.5 }),
    false,
    "fractional inventory counts must be rejected rather than silently truncated",
  );
  assert.equal(
    JSON.stringify(store.getState().products.find((item) => item.id === product.id)),
    productSnapshot,
    "rejected product edits must leave the stored product unchanged",
  );
  assert.equal(
    store.saveProduct({ ...product, price: 90_000_000_000_000, stock: 2 }),
    true,
    "a valid high-value product should remain editable when its individual price is representable",
  );
  assert.equal(store.adjustStock(product.id, 1), true);
  assert.equal(store.getState().products.find((item) => item.id === product.id).stock, 3);
  for (const invalidDelta of [1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
    assert.equal(
      store.adjustStock(product.id, invalidDelta),
      false,
      "invalid stock deltas must be rejected without corrupting inventory",
    );
  }
  assert.equal(store.getState().products.find((item) => item.id === product.id).stock, 3);
  assert.equal(store.adjustStock(product.id, -4), true);
  assert.equal(store.getState().products.find((item) => item.id === product.id).stock, 0);
  assert.equal(
    store.adjustStock("missing-product", 1),
    false,
    "stock adjustment must report a missing product rather than a successful no-op",
  );
  assert.equal(store.saveProduct(product), true, "restore the original synthetic product stock");
  assert.equal(
    store.saveProduct({ ...product, price: 90_000_000_000_000, stock: 2 }),
    true,
    "prepare a high-value synthetic product for the extended-total overflow check",
  );
  const saleCountBeforeOverflow = store.getState().sales.length;
  const paymentCountBeforeOverflow = store.getState().payments.length;
  assert.equal(
    store.sellProduct(product.id, 2, testMember.name, testMember.id, { amountPaid: 0 }),
    false,
    "a sale whose extended total exceeds safe currency precision must fail without throwing",
  );
  assert.equal(store.getState().sales.length, saleCountBeforeOverflow);
  assert.equal(store.getState().payments.length, paymentCountBeforeOverflow);
  assert.equal(store.getState().products.find((item) => item.id === product.id).stock, 2);
  assert.equal(store.saveProduct(product), true, "restore the original synthetic product for sale tests");
  const stockBefore = product.stock;
  assert.equal(
    store.sellProduct(product.id, 2, testMember.name, testMember.id, {
      discount: 50,
      amountPaid: 100,
      paymentMethod: "card",
    }),
    true,
  );
  state = store.getState();
  assert.equal(state.products.find((item) => item.id === product.id).stock, stockBefore - 2);
  const sale = state.sales[0];
  assert.equal(state.payments.find((payment) => payment.saleId === sale.id)?.method, "card");
  assert.equal(selectors.saleDue(state, sale), sale.total - 100);
  assert.equal(
    selectors.profitOfSales({ ...state, sales: [sale] }),
    sale.total - sale.unitCost * sale.qty,
  );
  const remainingSaleBalance = selectors.saleDue(state, sale);
  const paymentsBeforeInvalidSaleAmount = state.payments.length;
  assert.equal(
    store.addSalePayment(sale.id, Number.POSITIVE_INFINITY, "cash"),
    false,
    "invalid sale payment amounts must be rejected without throwing",
  );
  assert.equal(store.getState().payments.length, paymentsBeforeInvalidSaleAmount);
  assert.equal(
    store.addSalePayment(sale.id, 0.001, "cash"),
    false,
    "sale payments that round to zero minor units must not be recorded",
  );
  assert.equal(store.addSalePayment(sale.id, remainingSaleBalance, "card"), true);
  assert.equal(selectors.saleDue(store.getState(), sale), 0);
  assert.equal(store.addSalePayment(sale.id, 1, "cash"), false);
  store.updateMember(testMember.id, {
    phone: "+91 98888 77665",
    address: "Updated regular member address",
  });
  state = store.getState();
  assert.equal(state.members.find((item) => item.id === testMember.id).phone, "+91 98888 77665");
  assert.equal(
    state.members.find((item) => item.id === testMember.id).address,
    "Updated regular member address",
  );
  assert.equal(state.sales.find((item) => item.id === sale.id).buyerPhone, "+91 98888 77665");
  assert.equal(
    state.sales.find((item) => item.id === sale.id).buyerAddress,
    "Updated regular member address",
  );

  state = store.getState();
  const walkInProduct = selectors.liveProducts(state).find((item) => item.stock >= 2);
  assert(walkInProduct);
  const peopleBeforeWalkIn = selectors.activeMembers(state).length;
  store.sellProduct(walkInProduct.id, 1, "Manoj", null, {
    buyerPhone: "+91 99578 53542",
    buyerEmail: "manoj@example.com",
    amountPaid: 100,
  });
  state = store.getState();
  const walkIn = state.members.find((item) => item.phone === "+91 99578 53542");
  assert(walkIn);
  assert.equal(walkIn.type, "walk_in");
  assert.equal(selectors.activeMembers(state).length, peopleBeforeWalkIn + 1);
  assert.equal(
    selectors.gymMembers(state).some((item) => item.id === walkIn.id),
    false,
  );
  const firstWalkInSale = state.sales[0];
  assert.equal(firstWalkInSale.memberId, walkIn.id);
  assert.equal(selectors.outstandingFor(state, walkIn.id), firstWalkInSale.total - 100);

  store.sellProduct(walkInProduct.id, 1, "Manoj Kumar", null, {
    buyerPhone: "9957853542",
    buyerAddress: "Updated address",
  });
  state = store.getState();
  assert.equal(
    state.members.filter(
      (item) =>
        item.type === "walk_in" && item.phone.replace(/\D/g, "").slice(-10) === "9957853542",
    ).length,
    1,
    "normalized mobile numbers must reuse the same walk-in profile",
  );
  assert.equal(state.members.find((item) => item.id === walkIn.id).name, "Manoj Kumar");
  assert.equal(selectors.salesFor(state, walkIn.id).length, 2);
  assert(selectors.outstandingFor(state, walkIn.id) > 0);
  store.updateMember(walkIn.id, {
    name: "Manoj Updated",
    phone: "+91 90000 12345",
    email: "updated@example.com",
    address: "Updated customer address",
  });
  state = store.getState();
  const updatedWalkIn = state.members.find((item) => item.id === walkIn.id);
  assert.equal(updatedWalkIn.phone, "+91 90000 12345");
  assert.equal(updatedWalkIn.address, "Updated customer address");
  selectors.salesFor(state, walkIn.id).forEach((linkedSale) => {
    assert.equal(linkedSale.buyer, "Manoj Updated");
    assert.equal(linkedSale.buyerPhone, "+91 90000 12345");
    assert.equal(linkedSale.buyerEmail, "updated@example.com");
    assert.equal(linkedSale.buyerAddress, "Updated customer address");
  });

  const memberCountBeforeCustomerPayment = state.members.length;
  const paymentCountBeforeCustomerPayment = state.payments.length;
  const revenueBeforeCustomerPayment = selectors.totalRevenue(state);
  assert.equal(
    store.addCustomerPayment({ payerName: "A Walk-in", amount: 0, method: "cash" }),
    false,
    "standalone customer payments must reject invalid amounts",
  );
  assert.equal(
    store.addCustomerPayment({ payerName: "A Walk-in", payerEmail: "bad-email", amount: 25, method: "cash" }),
    false,
    "standalone customer payments must reject malformed email addresses",
  );
  assert.equal(
    store.addCustomerPayment({
      payerName: "Walk-in Customer",
      payerPhone: "+91 98765 43210",
      payerEmail: "walkin@example.com",
      amount: 250,
      method: "upi",
      note: "Day pass",
    }),
    true,
    "a non-member can make a standalone manual payment",
  );
  state = store.getState();
  const customerPayment = state.payments[0];
  assert.equal(customerPayment.kind, "other");
  assert.equal(customerPayment.memberId, undefined);
  assert.equal(customerPayment.membershipId, undefined);
  assert.equal(customerPayment.payerName, "Walk-in Customer");
  assert.equal(customerPayment.payerPhone, "+91 98765 43210");
  assert.equal(customerPayment.payerEmail, "walkin@example.com");
  assert.equal(customerPayment.note, "Day pass");
  assert.equal(state.members.length, memberCountBeforeCustomerPayment);
  assert.equal(state.payments.length, paymentCountBeforeCustomerPayment + 1);
  assert.equal(
    selectors.paymentsWithNames(state).find((payment) => payment.id === customerPayment.id)?.who,
    "Walk-in Customer",
  );
  assert.equal(selectors.totalRevenue(state), revenueBeforeCustomerPayment + 250);
  const todayRevenue = selectors.revenueSeries(state, "daily").at(-1);
  assert.equal(todayRevenue.other, 250);
  assert.equal(todayRevenue.total, todayRevenue.membership + todayRevenue.product + 250);

  store.addExpense({
    title: "Logic test expense",
    category: "Other",
    amount: 250,
    date: new Date().toISOString(),
    method: "cash",
  });
  state = store.getState();
  const expense = state.expenses.find((item) => item.title === "Logic test expense");
  assert(expense);
  assert.equal(expense.locked, true);
  store.updateExpense(expense.id, { amount: 300 });
  assert.equal(store.getState().expenses.find((item) => item.id === expense.id).amount, 300);
  assert.equal(store.trashExpense(expense.id), false);
  assert.equal(store.getState().expenses.find((item) => item.id === expense.id).deletedAt, null);
  store.updateExpense(expense.id, { locked: false });
  assert.equal(store.trashExpense(expense.id), true);
  assert(store.getState().expenses.find((item) => item.id === expense.id).deletedAt);
  store.restoreExpense(expense.id);
  assert.equal(store.getState().expenses.find((item) => item.id === expense.id).deletedAt, null);

  const inquiryCount = state.inquiries.length;
  store.addInquiry({
    name: "Logic Test Lead",
    phone: "9812345678",
    email: "lead@example.com",
    source: "referral",
    interest: "Monthly Strength",
    status: "new",
    priority: "hot",
    nextFollowUp: new Date().toISOString(),
    notes: "Asked for an evening tour.",
  });
  state = store.getState();
  assert.equal(state.inquiries.length, inquiryCount + 1);
  const inquiry = state.inquiries.find((item) => item.email === "lead@example.com");
  assert(inquiry);
  store.updateInquiry(inquiry.id, { status: "contacted", priority: "warm" });
  assert.equal(
    store.getState().inquiries.find((item) => item.id === inquiry.id).status,
    "contacted",
  );
  store.deleteInquiry(inquiry.id);
  assert.equal(
    store.getState().inquiries.some((item) => item.id === inquiry.id),
    false,
  );

  const backup = store.exportBackup();
  const invalidExpenseBackup = JSON.parse(backup);
  invalidExpenseBackup.expenses = [{ ...invalidExpenseBackup.expenses[0], amount: -1 }];
  assert.throws(() => store.restoreBackup(JSON.stringify(invalidExpenseBackup)));
  const settingsBeforeReset = structuredClone(store.getState().settings);
  store.resetData();
  state = store.getState();
  assert.deepEqual(state.settings, settingsBeforeReset);
  for (const key of [
    "members",
    "plans",
    "memberships",
    "payments",
    "products",
    "sales",
    "activities",
    "expenses",
    "inquiries",
    "readNotifications",
  ]) {
    assert.equal(state[key].length, 0, `${key} must be empty after reset`);
  }
  assert.equal(state.invoiceSeq, 0);
  assert.equal(
    await store.setupTemplateData(),
    true,
    "free workspace can set up starter data after reset",
  );
  state = store.getState();
  assert.deepEqual(state.settings, settingsBeforeReset);
  assert.equal(state.members.length, 10);
  assertIntegrity(state);
  store.restoreBackup(backup);
  assert.equal(
    store.getState().members.some((item) => item.id === testMember.id),
    true,
  );

  state = store.getState();
  const activeMemberSnapshot = JSON.stringify(state.members.find((item) => item.id === testMember.id));
  assert.equal(
    store.deleteMemberPermanently(testMember.id),
    false,
    "permanent member deletion must require the member to be in Trash",
  );
  assert.equal(
    JSON.stringify(store.getState().members.find((item) => item.id === testMember.id)),
    activeMemberSnapshot,
    "rejecting permanent deletion of an active member preserves the profile",
  );
  assert.equal(store.trashMember(testMember.id, "Logic test"), true);
  state = store.getState();
  const linkedMembershipIds = new Set(
    state.memberships.filter((item) => item.memberId === testMember.id).map((item) => item.id),
  );
  const linkedSaleIds = new Set(
    state.sales.filter((item) => item.memberId === testMember.id).map((item) => item.id),
  );
  assert.equal(store.deleteMemberPermanently(testMember.id), true);
  state = store.getState();
  assert.equal(
    state.members.some((item) => item.id === testMember.id),
    false,
  );
  assert.equal(
    state.memberships.some((item) => item.memberId === testMember.id),
    false,
  );
  assert.equal(
    state.payments.some(
      (item) =>
        item.memberId === testMember.id ||
        linkedMembershipIds.has(item.membershipId) ||
        linkedSaleIds.has(item.saleId),
    ),
    false,
  );
  assert.equal(
    state.sales.some((item) => item.memberId === testMember.id),
    false,
  );
  assertIntegrity(state);

  // Signing out must preserve the loaded workspace if its last change cannot
  // be synced. The fake adapter ensures this regression test never contacts Supabase.
  store.__setStateForLogicTests(buildSeed(10));
  store.__setCloudWorkspaceIOForLogicTests({
    ownerId: "logout-test-owner",
    gymId: "logout-test-gym",
    revision: 1,
    load: async () => null,
    save: async () => {
      throw new Error("NETWORK_ERROR");
    },
  });
  store.updateSettings({ gymName: "Unsynced logout test" });
  const stateBeforeFailedLogout = structuredClone(store.getState());
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      store.logoutSecurely(),
      /could not be saved/i,
      "logout must not succeed when a pending workspace change cannot be synced",
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(
    store.getState(),
    stateBeforeFailedLogout,
    "failed logout must keep the workspace available for retry",
  );

  const readOnlyWorkspace = buildSeed(10);
  const inquiryForReadOnly = readOnlyWorkspace.inquiries[0];
  const productForReadOnly = readOnlyWorkspace.products[0];
  const expenseForReadOnly = readOnlyWorkspace.expenses[0];
  readOnlyWorkspace.products.push({
    ...productForReadOnly,
    id: "qa_deleted_product",
    deletedAt: new Date().toISOString(),
    locked: false,
  });
  readOnlyWorkspace.expenses.push({
    ...expenseForReadOnly,
    id: "qa_deleted_expense",
    deletedAt: new Date().toISOString(),
    locked: false,
  });
  readOnlyWorkspace.sales.push({
    ...readOnlyWorkspace.sales[0],
    id: "qa_unpaid_sale",
    invoiceNo: "QA-UNPAID",
    total: 1000,
    paid: 0,
    qty: 1,
  });
  store.__setStateForLogicTests(readOnlyWorkspace, {
    email: "suspended-owner@example.test",
    name: "Suspended Owner",
    role: "admin",
    accountStatus: "suspended",
  });
  const readOnlySnapshot = JSON.stringify(store.getState());
  const readOnlyMember = readOnlyWorkspace.members[0];
  const readOnlyMembership = readOnlyWorkspace.memberships.find(
    (membership) => membership.memberId === readOnlyMember.id,
  );
  assert(readOnlyMembership);
  assert.equal(
    store.updateMember(readOnlyMember.id, { name: "Should not save" }),
    false,
    "read-only sessions must report member updates as rejected",
  );
  assert.equal(
    store.trashMember(readOnlyMember.id, "QA"),
    false,
    "read-only sessions must not trash member records",
  );
  assert.equal(
    store.savePlan({
      name: "Read-only write test",
      price: 1000,
      joiningFee: 0,
      durationDays: 30,
      description: "",
      active: true,
    }),
    false,
    "read-only sessions must not report a plan as saved",
  );
  assert.equal(store.toggleFreeze(readOnlyMembership.id), false);
  assert.equal(
    store.renewMembership(readOnlyMember.id, readOnlyMembership.planId, 0),
    false,
    "read-only sessions must not report a renewal as successful",
  );
  assert.equal(store.resetData(), false);
  assert.equal(
    store.restoreBackup(JSON.stringify(readOnlyWorkspace)),
    false,
    "read-only sessions must not report a backup restore as successful",
  );
  assert.equal(
    store.addPayment({
      memberId: readOnlyMember.id,
      membershipId: readOnlyMembership.id,
      amount: 1,
      method: "cash",
    }),
    false,
    "read-only sessions must not report a membership payment as recorded",
  );
  assert.equal(
    store.addSalePayment("qa_unpaid_sale", 1, "cash"),
    false,
    "read-only sessions must not report a sale payment as recorded",
  );
  assert.equal(
    store.saveProduct({
      name: "Read-only product",
      category: "Accessories",
      sku: "QA-RO",
      cost: 1,
      price: 2,
      stock: 1,
      lowStockAt: 0,
    }),
    false,
    "read-only sessions must not report products as saved",
  );
  assert.equal(store.trashProduct(productForReadOnly.id), false);
  assert.equal(store.restoreProduct("qa_deleted_product"), false);
  assert.equal(store.deleteProductPermanently("qa_deleted_product"), false);
  assert.equal(store.adjustStock(productForReadOnly.id, 1), false);
  assert.equal(
    store.addExpense({
      title: "QA read-only expense",
      category: "Supplies",
      amount: 1,
      date: new Date().toISOString(),
      method: "cash",
    }),
    false,
    "read-only sessions must not report expenses as recorded",
  );
  assert.equal(store.updateExpense(expenseForReadOnly.id, { title: "Changed" }), false);
  assert.equal(store.trashExpense(expenseForReadOnly.id), false);
  assert.equal(store.restoreExpense("qa_deleted_expense"), false);
  assert.equal(store.deleteExpensePermanently("qa_deleted_expense"), false);
  assert.equal(
    store.addInquiry({
      name: "QA Lead",
      phone: "9800000000",
      source: "referral",
      interest: "Monthly Strength",
      status: "new",
      priority: "warm",
    }),
    false,
    "read-only sessions must not report inquiries as added",
  );
  assert.equal(store.updateInquiry(inquiryForReadOnly.id, { status: "contacted" }), false);
  assert.equal(store.deleteInquiry(inquiryForReadOnly.id), false);
  assert.equal(store.updateSettings({ gymName: "Read-only mutation" }), false);
  assert.equal(store.addNote(readOnlyMember.id, "Read-only", "Should not save"), false);
  assert.equal(
    store.updateNote(readOnlyMember.id, readOnlyMember.notes[0].id, {
      title: "Read-only",
      note: "Should not save",
    }),
    false,
  );
  assert.equal(store.deleteNote(readOnlyMember.id, readOnlyMember.notes[0].id), false);
  assert.equal(
    store.addMeasurement(readOnlyMember.id, { weightKg: 70 }),
    false,
  );
  assert.equal(
    store.updateMeasurement(readOnlyMember.id, readOnlyMember.measurements[0].id, { weightKg: 70 }),
    false,
  );
  assert.equal(
    store.deleteMeasurement(readOnlyMember.id, readOnlyMember.measurements[0].id),
    false,
  );
  assert.equal(store.markNotificationsRead(["qa-notification"]), false);
  await assert.rejects(
    store.setupTemplateData(),
    /suspended.*read-only/i,
    "template setup must respect the same read-only policy as ordinary writes",
  );
  assert.equal(
    JSON.stringify(store.getState()),
    readOnlySnapshot,
    "rejected read-only operations must preserve the full member workspace",
  );

  console.log("Business logic verification passed.");
} finally {
  await vite.close();
}
