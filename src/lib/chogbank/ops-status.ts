import type { SponsoredJob } from "@/lib/chogbank/types";
import type { TxStage } from "@/lib/chogbank/relayer-gate";
import { stageOfJob } from "@/lib/chogbank/relayer-gate";
import type { WatcherHealth } from "@/lib/watcher/types";

export type ChogBankOpsStatus = {
  watcher: WatcherHealth | { status: "uninitialized"; executionAllowed: false };
  relayer: "disabled";
  signer: "none";
  stages: Record<TxStage, number>;
  pendingInvalidations: number;
  confirmedInvalidations: number;
  note: string;
};

export function chogBankOpsStatus(input: {
  watcher: WatcherHealth | null;
  jobs: SponsoredJob[];
  pendingInvalidations: number;
  confirmedInvalidations: number;
  simulated?: boolean;
}): ChogBankOpsStatus {
  const stages: Record<TxStage, number> = {
    monitoring: 0,
    simulated: 0,
    prepared: 0,
    submitted: 0,
    confirmed: 0,
    reverted: 0,
  };
  for (const job of input.jobs) {
    stages[stageOfJob({ state: job.state, simulated: input.simulated === true })] += 1;
  }
  return {
    watcher: input.watcher ?? { status: "uninitialized", executionAllowed: false },
    relayer: "disabled",
    signer: "none",
    stages,
    pendingInvalidations: input.pendingInvalidations,
    confirmedInvalidations: input.confirmedInvalidations,
    note: "Production signing is disabled. A queued invalidation is not a completed invalidateSession.",
  };
}
