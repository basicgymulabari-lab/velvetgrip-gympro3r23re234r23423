const MINOR_SCALE = 100;

/**
 * Convert a major-unit currency number to integer minor units (paise/cents).
 * All persisted monetary inputs are normalized through this boundary so
 * arithmetic never accumulates binary floating-point fractions.
 */
export function toMinor(value: number) {
  if (!Number.isFinite(value)) throw new Error("Invalid monetary value");
  const minor = Math.round(value * MINOR_SCALE);
  if (!Number.isSafeInteger(minor)) throw new Error("Monetary value is too large");
  return minor;
}

export const fromMinor = (minor: number) => minor / MINOR_SCALE;

export const normalizeMoney = (value: number) => fromMinor(toMinor(value));

export function sumMoney<T>(items: readonly T[], pick: (item: T) => number) {
  return fromMinor(items.reduce((sum, item) => sum + toMinor(pick(item)), 0));
}

export function addMoney(...values: number[]) {
  return fromMinor(values.reduce((sum, value) => sum + toMinor(value), 0));
}

export function subtractMoney(left: number, right: number) {
  return fromMinor(toMinor(left) - toMinor(right));
}

export function multiplyMoney(unitAmount: number, quantity: number) {
  if (!Number.isSafeInteger(quantity)) throw new Error("Invalid quantity");
  const result = toMinor(unitAmount) * quantity;
  if (!Number.isSafeInteger(result)) throw new Error("Monetary value is too large");
  return fromMinor(result);
}
