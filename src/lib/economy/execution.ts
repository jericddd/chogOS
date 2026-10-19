import { gateRelayerOp } from "@/lib/chogbank/relayer-gate";
import { productionBankRuntime } from "@/lib/chogbank/runtime";
import { loadProtectedSigner } from "@/lib/chogbank/signer";
import { readAppConfig } from "@/lib/config/env";

export type ProductionExecution = {
  enabled: false;
  signerKind: "none";
  relayerEnabled: false;
  executeSessionAccepted: false;
  /** What the current relayer gate returned. Production still reports execution disabled. */
  gateAccepted: boolean;
  transactionsRoute: "closed";
  reason: string;
  detail: string;
};

/**
 * Production spending stays off. No environment flag is read as permission
 * to sign, sponsor, or call account.executeSession.
 */
export function productionExecutionStatus(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): ProductionExecution {
  const signer = loadProtectedSigner(env);
  const session = gateRelayerOp({
    op: "account.executeSession",
    chainId: 143,
    signer,
    mode: "production",
    reservationHeld: true,
    treasuryConfigured: true,
    preflightOk: true,
  });
  const runtime = productionBankRuntime(readAppConfig(env as NodeJS.ProcessEnv));
  return {
    enabled: false,
    signerKind: "none",
    relayerEnabled: false,
    executeSessionAccepted: false,
    gateAccepted: session.accepted,
    transactionsRoute: "closed",
    reason: "Production signing, the relayer, and account.executeSession stay disabled.",
    detail: runtime.relayerEnabled
      ? "The bank runtime flag was ignored. Production execution stays disabled."
      : session.accepted
        ? signer.reason
        : session.reason,
  };
}
