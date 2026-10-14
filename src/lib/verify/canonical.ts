import { sha256, stringToBytes, type Hex } from "viem";

/** Integrity schema hashed into every sealed event. */
export const EVENT_INTEGRITY_SCHEMA = "chogos-event-v1";
export const EVENT_HASH_ALG = "sha256";

/**
 * Fields in the canonical document, in this exact order. Missing scalars are
 * empty. JSON objects (payload, stateTransition) are RFC-8785-style: sorted
 * keys, no whitespace, safe integers, JSON string escaping.
 *
 * Timestamps are UTC with millisecond precision and a trailing Z.
 * UUIDs are lowercase. Transaction hashes are lowercase 0x + 64 hex.
 * Addresses are not rewritten inside payload JSON; only txHash is normalized.
 */
export const CANONICAL_FIELDS = [
  "schema",
  "id",
  "seq",
  "kind",
  "category",
  "source",
  "summary",
  "occurredAt",
  "createdAt",
  "worldS",
  "tickSeq",
  "actorCitizenId",
  "relatedCitizenId",
  "buildingId",
  "chainStatus",
  "chainId",
  "txHash",
  "dedupeKey",
  "intentId",
  "decisionId",
  "payload",
  "stateTransition",
  "prevEventHash",
] as const;

export type CanonicalEventInput = {
  id: string;
  seq: number | string;
  kind: string;
  category: string;
  source: string;
  summary: string;
  occurredAt: string;
  createdAt: string;
  worldS?: number | string | null;
  tickSeq?: number | string | null;
  actorCitizenId?: string | null;
  relatedCitizenId?: string | null;
  buildingId?: string | null;
  chainStatus: string;
  chainId?: number | string | null;
  txHash?: string | null;
  dedupeKey?: string | null;
  intentId?: string | null;
  decisionId?: string | null;
  payload?: unknown;
  stateTransition?: unknown;
  prevEventHash?: string | null;
};

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) {
    return value === null ? "null" : "";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new Error("Canonical JSON numbers must be finite safe integers.");
    }
    return String(value);
  }
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as object).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error("Canonical JSON cannot encode this value.");
}

export function utcMsZ(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid timestamp for canonical encoding.");
  }
  return date.toISOString().replace(/\.(\d{3})\d+Z$/, ".$1Z");
}

function uuid(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  return value.trim().toLowerCase();
}

function intText(value: number | string | bigint | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new Error("Canonical integers must be finite safe integers.");
    }
    return String(value);
  }
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error("Canonical integers must be decimal digits.");
  }
  return trimmed.replace(/^(-?)0+(?=\d)/, "$1");
}

function txHash(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  const lower = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(lower)) {
    throw new Error("txHash must be 0x followed by 64 hex characters.");
  }
  return lower;
}

function hashHex(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  const lower = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(lower)) {
    throw new Error("Event hash must be 0x followed by 64 hex characters.");
  }
  return lower;
}

/** Deterministic UTF-8 document. The same inputs always produce the same bytes. */
export function canonicalEventDocument(event: CanonicalEventInput): string {
  const payload = event.payload === undefined ? {} : event.payload;
  const transition = event.stateTransition === undefined ? {} : event.stateTransition;
  const lines = [
    EVENT_INTEGRITY_SCHEMA,
    `id:${uuid(event.id)}`,
    `seq:${intText(event.seq)}`,
    `kind:${event.kind}`,
    `category:${event.category}`,
    `source:${event.source}`,
    `summary:${event.summary.replace(/\r\n/g, " ").replace(/[\r\n]/g, " ")}`,
    `occurredAt:${utcMsZ(event.occurredAt)}`,
    `createdAt:${utcMsZ(event.createdAt)}`,
    `worldS:${intText(event.worldS)}`,
    `tickSeq:${intText(event.tickSeq)}`,
    `actorCitizenId:${uuid(event.actorCitizenId)}`,
    `relatedCitizenId:${uuid(event.relatedCitizenId)}`,
    `buildingId:${event.buildingId ?? ""}`,
    `chainStatus:${event.chainStatus}`,
    `chainId:${intText(event.chainId)}`,
    `txHash:${txHash(event.txHash)}`,
    `dedupeKey:${event.dedupeKey ?? ""}`,
    `intentId:${uuid(event.intentId)}`,
    `decisionId:${uuid(event.decisionId)}`,
    `payload:${canonicalJson(payload)}`,
    `stateTransition:${canonicalJson(transition)}`,
    `prevEventHash:${hashHex(event.prevEventHash)}`,
  ];
  return `${lines.join("\n")}\n`;
}

export function hashEvent(event: CanonicalEventInput): Hex {
  return sha256(stringToBytes(canonicalEventDocument(event)));
}

export function hashesMatch(stored: string | null | undefined, computed: string): boolean {
  return Boolean(stored && stored.toLowerCase() === computed.toLowerCase());
}
