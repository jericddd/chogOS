/** Gemini 3.8 Flash is reserved for consequential decisions. Routine work stays on Lite. */
export const GEMINI_FLASH_MODEL = "gemini-3.8-flash";
export const GEMINI_LITE_MODEL = "gemini-3.5-flash-lite";

/** Free-tier caps from the AI Studio dashboard for this project. */
export const FLASH_DAILY_CAP = 20;
export const FLASH_RPM = 5;
/** Twenty Flash requests spread across a quota day. */
export const FLASH_GAP_MS = 72 * 60 * 1000;
export const LITE_DAILY_CAP = 500;
export const LITE_RPM = 15;

/** One model call cannot consume the whole AI Mind invocation. */
export const FLASH_CALL_TIMEOUT_MS = 25_000;
export const LITE_CALL_TIMEOUT_MS = 20_000;

const LITE_PURPOSES = new Set([
  "citizen_turn",
  "wallet_issuance",
  "citizen_trade",
  "citizen_return",
  "smoke",
]);

export function geminiModelForRequest(configured: string, purpose: string): string {
  if (purpose === "treasury_allocation") return GEMINI_FLASH_MODEL;
  if (LITE_PURPOSES.has(purpose)) return GEMINI_LITE_MODEL;
  const model = configured.trim();
  return model.length > 0 ? model : GEMINI_LITE_MODEL;
}

export function modelTier(model: string): "flash" | "lite" {
  return model.includes("gemini-3.8-flash") ? "flash" : "lite";
}

export function modelCallTimeoutMs(model: string, slotMs: number): number {
  const cap = modelTier(model) === "flash" ? FLASH_CALL_TIMEOUT_MS : LITE_CALL_TIMEOUT_MS;
  return Math.max(1, Math.min(slotMs, cap));
}

export function purposeCallTimeoutMs(purpose: string, slotMs: number): number {
  const cap = purpose === "treasury_allocation" ? FLASH_CALL_TIMEOUT_MS : LITE_CALL_TIMEOUT_MS;
  return Math.max(1, Math.min(slotMs, cap));
}
