import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Clock3, LoaderCircle, RefreshCw, Search, UserCheck } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app/AppShell";
import { AppDatePicker } from "@/components/app/AppDatePicker";
import { EmptyState, PageHeader, Panel } from "@/components/app/Panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isSupabaseConfigured, supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { formatShortDate, localDateInput } from "@/lib/gym/calendar";
import { gymMembers } from "@/lib/gym/selectors";
import { useGym } from "@/lib/gym/store";
import type { Member } from "@/lib/gym/types";

export const Route = createFileRoute("/attendance")({
  head: () => ({
    meta: [
      { title: "Attendance — IRONVAULT Gym Management" },
      {
        name: "description",
        content: "Quickly record member check-ins and review attendance by date.",
      },
    ],
  }),
  component: () => (
    <AppShell>
      <AttendancePage />
    </AppShell>
  ),
});

type AttendanceRow = Database["public"]["Tables"]["gym_member_attendance"]["Row"];
type CheckInResult = {
  status?: "checked_in" | "already_checked_in";
  id?: string;
  gym_id?: string;
  member_id?: string;
  attendance_date?: string;
  checked_in_at?: string;
  checked_in_by?: string | null;
};

const ATTENDANCE_PAGE_SIZE = 50;

function AttendancePage() {
  const state = useGym();
  const today = useMemo(() => localDateInput(new Date()), []);
  const [selectedDate, setSelectedDate] = useState(today);
  const [search, setSearch] = useState("");
  const [records, setRecords] = useState<AttendanceRow[]>([]);
  const [todayMemberIds, setTodayMemberIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingMemberId, setSavingMemberId] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const loadRecords = useCallback(
    async (date: string, offset = 0, append = false) => {
      const requestId = ++requestSequence.current;
      if (!isSupabaseConfigured()) {
        setLoading(false);
        setLoadingMore(false);
        setLoadError("Attendance needs an online connection to your gym workspace.");
        return;
      }
      if (!navigator.onLine) {
        setLoading(false);
        setLoadingMore(false);
        setLoadError("Reconnect to the internet to load attendance records.");
        return;
      }

      if (append) setLoadingMore(true);
      else setLoading(true);
      setLoadError(null);

      const { data, error } = await supabase
        .from("gym_member_attendance")
        .select("id,gym_id,member_id,attendance_date,checked_in_at,checked_in_by")
        .eq("attendance_date", date)
        .order("checked_in_at", { ascending: false })
        .range(offset, offset + ATTENDANCE_PAGE_SIZE - 1);

      if (requestId !== requestSequence.current) return;
      setLoading(false);
      setLoadingMore(false);
      if (error) {
        setLoadError("Attendance could not be loaded. Check your connection and try again.");
        return;
      }

      const page = data ?? [];
      setRecords((current) => {
        const keepLocalTodayRows = !append && date === today ? current : [];
        const byId = new Map([...page, ...keepLocalTodayRows].map((record) => [record.id, record]));
        return [...byId.values()].sort(
          (left, right) =>
            new Date(right.checked_in_at).getTime() - new Date(left.checked_in_at).getTime(),
        );
      });
      setHasMore(page.length === ATTENDANCE_PAGE_SIZE);
      if (date === today && !append) {
        setTodayMemberIds((current) => [
          ...new Set([...current, ...page.map((record) => record.member_id)]),
        ]);
      }
    },
    [today],
  );

  useEffect(() => {
    setRecords([]);
    setHasMore(false);
    void loadRecords(selectedDate);
  }, [loadRecords, selectedDate]);

  const members = useMemo(() => (state ? gymMembers(state) : []), [state]);
  const matches = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return [];
    return members
      .filter((member) =>
        `${member.name} ${member.phone} ${member.email}`.toLocaleLowerCase().includes(query),
      )
      .slice(0, 8);
  }, [members, search]);

  const checkIn = async (member: Member) => {
    if (savingMemberId) return;
    if (!navigator.onLine) {
      toast.error("Reconnect to the internet before recording attendance.");
      return;
    }

    setSavingMemberId(member.id);
    try {
      const { data, error } = await supabase.rpc("record_current_member_attendance", {
        p_member_id: member.id,
        p_attendance_date: today,
      });

      if (error) {
        const message = error.message ?? "";
        if (message.includes("ATTENDANCE_MEMBER_NOT_FOUND")) {
          toast.error(
            "This member is no longer in the active roster. Refresh the page and try again.",
          );
        } else if (message.includes("ATTENDANCE_FORBIDDEN")) {
          toast.error("Your account does not have permission to record attendance.");
        } else {
          toast.error("Attendance was not saved. Check your connection and try again.");
        }
        return;
      }

      const result = data as unknown as CheckInResult | null;
      if (
        !result ||
        (result.status !== "checked_in" && result.status !== "already_checked_in") ||
        !result.id ||
        !result.gym_id ||
        !result.attendance_date ||
        !result.checked_in_at
      ) {
        toast.error(
          "The server returned an incomplete check-in. Refresh attendance before continuing.",
        );
        return;
      }

      const alreadyCheckedIn = result.status === "already_checked_in";
      const row: AttendanceRow = {
        id: result.id,
        gym_id: result.gym_id,
        member_id: result.member_id ?? member.id,
        attendance_date: result.attendance_date,
        checked_in_at: result.checked_in_at,
        checked_in_by: result.checked_in_by ?? null,
      };
      setTodayMemberIds((current) =>
        current.includes(member.id) ? current : [...current, member.id],
      );
      if (selectedDate === today) {
        setRecords((current) =>
          current.some((record) => record.member_id === member.id)
            ? current
            : [row, ...current].sort(
                (left, right) =>
                  new Date(right.checked_in_at).getTime() - new Date(left.checked_in_at).getTime(),
              ),
        );
      }
      if (alreadyCheckedIn) toast.info(`${member.name} is already checked in today.`);
      else toast.success(`${member.name} checked in.`);
    } catch {
      toast.error("Attendance was not saved. Check your connection and try again.");
    } finally {
      setSavingMemberId(null);
    }
  };

  if (!state) return null;
  const memberById = new Map(state.members.map((member) => [member.id, member]));
  const selectedDateIsToday = selectedDate === today;

  return (
    <>
      <PageHeader
        title="Attendance"
        subtitle="Search a member and mark today’s attendance with one click. Attendance saves online and doesn’t change membership status."
      />

      <div className="space-y-5">
        <Panel
          title="Quick check-in"
          description="Current roster only · one check-in per member each day"
        >
          <div className="relative max-w-2xl">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search current members"
              autoComplete="off"
              className="pl-9"
              maxLength={80}
              placeholder="Search by member name, phone or email"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>

          {search.trim() ? (
            matches.length ? (
              <div className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border">
                {matches.map((member) => {
                  const checkedIn = todayMemberIds.includes(member.id);
                  const saving = savingMemberId === member.id;
                  return (
                    <div
                      key={member.id}
                      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium">{member.name}</p>
                        <p className="text-sm text-muted-foreground">
                          {member.phone || member.email || "No contact details"}
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        disabled={saving || savingMemberId !== null || checkedIn}
                        onClick={() => void checkIn(member)}
                      >
                        {saving ? (
                          <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                        ) : checkedIn ? (
                          <Check className="mr-2 h-4 w-4" />
                        ) : (
                          <UserCheck className="mr-2 h-4 w-4" />
                        )}
                        {saving ? "Saving…" : checkedIn ? "Checked in" : "Check in"}
                      </Button>
                    </div>
                  );
                })}
                {members.filter((member) =>
                  `${member.name} ${member.phone} ${member.email}`
                    .toLocaleLowerCase()
                    .includes(search.trim().toLocaleLowerCase()),
                ).length > matches.length && (
                  <p className="px-4 py-2 text-xs text-muted-foreground">
                    Keep typing to narrow these results.
                  </p>
                )}
              </div>
            ) : (
              <p className="mt-3 rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                No active gym member matches that search.
              </p>
            )
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              Start typing a member’s name or phone number.
            </p>
          )}
        </Panel>

        <Panel
          title="Attendance history"
          description={`${records.length}${hasMore ? "+" : ""} check-in${records.length === 1 ? "" : "s"} · ${formatShortDate(selectedDate)}`}
          actions={
            <div className="w-full sm:w-56">
              <AppDatePicker
                value={selectedDate}
                onChange={setSelectedDate}
                max={new Date()}
                placeholder="Choose attendance date"
              />
            </div>
          }
        >
          {loadError ? (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm"
            >
              <span>{loadError}</span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void loadRecords(selectedDate)}
              >
                <RefreshCw className="mr-2 h-4 w-4" /> Retry
              </Button>
            </div>
          ) : loading ? (
            <div
              className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"
              role="status"
            >
              <LoaderCircle className="h-4 w-4 animate-spin" /> Loading attendance…
            </div>
          ) : records.length === 0 ? (
            <EmptyState
              title="No attendance recorded"
              hint={
                selectedDateIsToday
                  ? "Search for a member above to record today’s first check-in."
                  : "No members were checked in on this date."
              }
            />
          ) : (
            <>
              <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
                {records.map((record) => {
                  const member = memberById.get(record.member_id);
                  return (
                    <div
                      key={record.id}
                      className="flex items-center justify-between gap-4 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium">
                          {member?.name ?? "Member record unavailable"}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {member?.phone || member?.email || ""}
                        </p>
                      </div>
                      <span className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground">
                        <Clock3 className="h-4 w-4" />
                        {new Date(record.checked_in_at).toLocaleTimeString(undefined, {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                  );
                })}
              </div>
              {hasMore && (
                <div className="mt-4 flex justify-center">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={loadingMore}
                    onClick={() => void loadRecords(selectedDate, records.length, true)}
                  >
                    {loadingMore ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
                    {loadingMore ? "Loading…" : "Load more"}
                  </Button>
                </div>
              )}
            </>
          )}
        </Panel>
      </div>
    </>
  );
}
