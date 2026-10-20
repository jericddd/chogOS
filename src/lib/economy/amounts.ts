/** Base-unit integers only. Callers must not pass JavaScript numbers for token amounts. */
export function parseRawAmount(value: unknown): bigint | null {
  if (typeof value === "bigint") {
    return value >= 0n ? value : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  if (!/^[0-9]+$/.test(text)) {
    return null;
  }
  return BigInt(text);
}

export function raw(value: bigint): string {
  return value.toString(10);
}

/** Subtract a reservation from an observed balance. Null stays null so a missing read is not zero. */
export function remaining(observed: bigint | null, held: bigint): bigint | null {
  if (observed === null || held < 0n) {
    return null;
  }
  return observed > held ? observed - held : 0n;
}

export function sum(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}
