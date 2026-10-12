const MINOR_SCALE = 100;
const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

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

/** True when a currency value can be represented exactly within our minor-unit model. */
export function isSafeMoneyAmount(value: number) {
  return Number.isFinite(value) && Number.isSafeInteger(Math.round(value * MINOR_SCALE));
}

export function isPositiveMoneyAmount(value: number) {
  return isSafeMoneyAmount(value) && Math.round(value * MINOR_SCALE) > 0;
}

export const fromMinor = (minor: number) => minor / MINOR_SCALE;

function fromCheckedMinor(minor: bigint) {
  if (minor > MAX_SAFE_MINOR || minor < -MAX_SAFE_MINOR) {
    throw new Error("Monetary value is too large");
  }
  return fromMinor(Number(minor));
}

export const normalizeMoney = (value: number) => fromMinor(toMinor(value));

export function sumMoney<T>(items: readonly T[], pick: (item: T) => number) {
  const total = items.reduce((sum, item) => sum + BigInt(toMinor(pick(item))), 0n);
  return fromCheckedMinor(total);
}

export function addMoney(...values: number[]) {
  const total = values.reduce((sum, value) => sum + BigInt(toMinor(value)), 0n);
  return fromCheckedMinor(total);
}

export function isSafeMoneySum(...values: number[]) {
  try {
    addMoney(...values);
    return true;
  } catch {
    return false;
  }
}

export function subtractMoney(left: number, right: number) {
  return fromCheckedMinor(BigInt(toMinor(left)) - BigInt(toMinor(right)));
}

export function multiplyMoney(unitAmount: number, quantity: number) {
  if (!Number.isSafeInteger(quantity)) throw new Error("Invalid quantity");
  return fromCheckedMinor(BigInt(toMinor(unitAmount)) * BigInt(quantity));
}
