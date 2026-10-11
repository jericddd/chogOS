import "server-only";

/**
 * Phase 0 has no signer. Calling this is the supported way to refuse a send.
 */
export class TransactionExecutionDisabledError extends Error {
  constructor() {
    super(
      "Blockchain transaction execution is disabled. Phase 0 has no signer and does not broadcast transactions.",
    );
    this.name = "TransactionExecutionDisabledError";
  }
}

export function assertExecutionDisabled(): never {
  throw new TransactionExecutionDisabledError();
}
