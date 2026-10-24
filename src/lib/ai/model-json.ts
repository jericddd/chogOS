export type ModelJsonRead = { ok: true; value: unknown } | { ok: false; shape: string };

/**
 * Reads one JSON value from a model reply.
 * A fence, surrounding prose, one layer of string-encoding, or a trailing comma
 * can be removed. Anything else stays unreadable. This does not invent fields.
 */
export function readModelJson(text: string): ModelJsonRead {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, shape: modelJsonShape(text) };
  const candidates = [trimmed, ...fenceBodies(trimmed)];
  const expanded: string[] = [];
  for (const candidate of candidates) {
    expanded.push(candidate);
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) expanded.push(candidate.slice(start, end + 1));
  }
  for (const candidate of expanded) {
    const parsed = parseLoose(candidate);
    if (parsed !== undefined) return { ok: true, value: parsed };
  }
  return { ok: false, shape: modelJsonShape(trimmed) };
}

/** A short description safe to store and log. Addresses and URLs are removed. */
export function modelJsonShape(text: string): string {
  const trimmed = text.trim();
  const prefix = !trimmed
    ? "empty"
    : trimmed.startsWith("```")
      ? "fence"
      : trimmed.startsWith("{")
        ? "object"
        : trimmed.startsWith("[")
          ? "array"
          : "prose";
  const excerpt = trimmed
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/0x[0-9a-fA-F]{8,}/g, "[hex]")
    .replace(/\s+/g, " ")
    .slice(0, 80);
  return `chars=${trimmed.length} prefix=${prefix} excerpt=${JSON.stringify(excerpt)}`;
}

function fenceBodies(text: string): string[] {
  const bodies: string[] = [];
  const pattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of text.matchAll(pattern)) {
    const body = match[1]?.trim();
    if (body) bodies.push(body);
  }
  return bodies;
}

function parseLoose(text: string): unknown | undefined {
  const direct = tryParse(text);
  if (direct !== undefined) return unwrapString(direct);
  const repaired = withoutTrailingCommas(text);
  if (!repaired) return undefined;
  const parsed = tryParse(repaired);
  return parsed === undefined ? undefined : unwrapString(parsed);
}

function unwrapString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const inner = value.trim();
  if (!inner.startsWith("{") && !inner.startsWith("[")) return value;
  const parsed = tryParse(inner);
  return parsed === undefined ? value : parsed;
}

function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Drops a comma that sits immediately before } or ], and only outside a string. */
function withoutTrailingCommas(text: string): string | null {
  let out = "";
  let inString = false;
  let escaped = false;
  let changed = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next] ?? "")) next += 1;
      const closer = text[next];
      if (closer === "}" || closer === "]") {
        changed = true;
        continue;
      }
    }
    out += char;
  }
  if (inString || !changed) return null;
  return out;
}
