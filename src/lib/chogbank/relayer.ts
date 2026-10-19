import type { Hex } from "viem";
import { loadProtectedSigner } from "@/lib/chogbank/signer";
import { RELAYER_OPS, type RelayerOp, type SponsoredJob } from "@/lib/chogbank/types";

export type RelayerSend = {
  op: RelayerOp;
  job: Pick<SponsoredJob, "idempotencyKey" | "target" | "selector" | "valueWei">;
};

export type RelayerOutcome =
  | { ok: true; txHash: Hex; gasUsedWei: bigint }
  | { ok: false; kind: "disabled" | "rpc" | "reverted" | "rejected"; reason: string };

export type Relayer = {
  enabled: boolean;
  send(input: RelayerSend): Promise<RelayerOutcome>;
};

export const RELAYER_DISABLED_REASON = "relayer is disabled; the bank will not broadcast";

export function createDisabledRelayer(reason = RELAYER_DISABLED_REASON): Relayer {
  return {
    enabled: false,
    async send() {
      return { ok: false, kind: "disabled", reason };
    },
  };
}

/** Test double. Never connected to an RPC or a key. */
export function createScriptedRelayer(script: RelayerOutcome[]): Relayer {
  let index = 0;
  return {
    enabled: true,
    async send(input) {
      if (!RELAYER_OPS.includes(input.op)) {
        return { ok: false, kind: "rejected", reason: "relayer op is not allowed" };
      }
      const next = script[index];
      index += 1;
      if (!next) {
        return { ok: false, kind: "rpc", reason: "scripted relayer has no further outcomes" };
      }
      return next;
    },
  };
}

export function loadProductionRelayer(env: NodeJS.ProcessEnv = process.env): Relayer {
  const signer = loadProtectedSigner(env);
  if (env.CHOG_BANK_RELAYER_ENABLED === "true") {
    return createDisabledRelayer(`${signer.reason}; CHOG_BANK_RELAYER_ENABLED cannot broadcast without a signer backend`);
  }
  return createDisabledRelayer();
}

export function relayerAllows(op: string): op is RelayerOp {
  return (RELAYER_OPS as readonly string[]).includes(op);
}
