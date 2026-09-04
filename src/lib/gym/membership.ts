import type { Plan } from "./types";

const LIFETIME_END = new Date(9999, 11, 31, 23, 59, 59, 999);

export function isLifetimePlan(plan: Pick<Plan, "name" | "durationDays">) {
  const normalizedName = plan.name.toLowerCase().replace(/[\s_-]+/g, "");
  return (
    normalizedName.includes("lifetime") ||
    !Number.isFinite(plan.durationDays) ||
    plan.durationDays >= 36_500
  );
}

export function membershipEndDate(start: Date, plan: Pick<Plan, "name" | "durationDays">) {
  if (isLifetimePlan(plan)) return new Date(LIFETIME_END);
  const end = new Date(start);
  end.setDate(end.getDate() + Math.max(1, Math.floor(plan.durationDays)));
  return Number.isNaN(end.getTime()) ? new Date(LIFETIME_END) : end;
}

export function isLifetimeDate(value: string | Date) {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.getFullYear() >= 9999;
}
