import type { PhoneCountry } from "./types";

export const PHONE_COUNTRIES: Array<{ value: PhoneCountry; label: string; dialCode: string }> = [
  { value: "nepal", label: "Nepal", dialCode: "+977" },
  { value: "india", label: "India", dialCode: "+91" },
  { value: "usa", label: "USA", dialCode: "+1" },
];

export const dialCodeFor = (country?: PhoneCountry) =>
  PHONE_COUNTRIES.find((option) => option.value === (country ?? "india"))?.dialCode ?? "+91";

export function localPhoneDigits(value: string | undefined) {
  const trimmed = value?.trim() ?? "";
  const localNumber = trimmed.startsWith("+")
    ? trimmed.replace(/^\+\s*(?:977|91|1)\s*/, "")
    : trimmed;
  return localNumber.replace(/\D/g, "");
}

export function phoneInputValue(value: string | undefined, country?: PhoneCountry) {
  return `${dialCodeFor(country)} ${localPhoneDigits(value).slice(0, 10)}`;
}

export function phoneForCountry(value: string | undefined, country?: PhoneCountry) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  const localNumber = trimmed.startsWith("+")
    ? trimmed.replace(/^\+\s*(?:977|91|1)\s*/, "").trim()
    : trimmed;
  const localDigits = localPhoneDigits(trimmed);
  if (!localDigits) return "";
  return `${dialCodeFor(country)} ${localNumber}`;
}
