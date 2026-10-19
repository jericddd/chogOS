import { randomUUID } from "node:crypto";
import { getAddress, toFunctionSelector, type Address, type Hex } from "viem";
import { evaluateSessionExecution } from "@/lib/chogbank/authorization";
import { identityKey } from "@/lib/chogbank/factory";
import { bucketForReservation, heldWei, reconcileReservation } from "@/lib/chogbank/ledger";
import { canRequestAgain, evaluateActivation, evaluateSponsorship, nextStateAfterBank } from "@/lib/chogbank/policy";
import type { Relayer } from "@/lib/chogbank/relayer";
import type { BankRuntime } from "@/lib/chogbank/runtime";
import type { ChogBankStore } from "@/lib/chogbank/store";
import type {
  ActivationRequest,
  RelayerOp,
  Reservation,
  SessionPolicy,
  SponsoredJob,
  TransferLog,
} from "@/lib/chogbank/types";
import type { NftIdentity } from "@/lib/wallets/nft-bound";

export type SessionGuard = {
  ready(): { ok: true } | { ok: false; reason: string };
  transfersAfter(tokenId: string, openedBlock: bigint): TransferLog[];
};

export type BankEngine = {
  store: ChogBankStore;
  runtime: BankRuntime;
  relayer: Relayer;
  /** When set, sponsored executeSession fails closed unless the watcher is caught up. */
  guard?: SessionGuard;
  predictAccount?: (identity: NftIdentity) => Address | null;
  now?: () => string;
  id?: () => string;
};

/** Process-local. Two sponsor calls in one process cannot both pass the balance check. */
const sponsorshipTail = new WeakMap<BankEngine, Promise<void>>();

function withSponsorshipLock<T>(engine: BankEngine, work: () => Promise<T>): Promise<T> {
  const previous = sponsorshipTail.get(engine) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(work);
  sponsorshipTail.set(
    engine,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function nowIso(engine: BankEngine): string {
  return engine.now ? engine.now() : new Date().toISOString();
}

function newId(engine: BankEngine): string {
  return engine.id ? engine.id() : randomUUID();
}

function identityOf(request: ActivationRequest): NftIdentity {
  return {
    chainId: request.chainId,
    nftContract: request.nftContract,
    tokenId: BigInt(request.tokenId),
  };
}

export async function submitActivationRequest(
  engine: BankEngine,
  draft: Omit<ActivationRequest, "state" | "predictedAddress" | "accountAddress" | "reservationId" | "rejectReason"> &
    Partial<Pick<ActivationRequest, "id" | "state">>,
): Promise<ActivationRequest> {
  const existing = await engine.store.getByNft(draft.chainId, draft.nftContract, draft.tokenId);
  if (existing && !canRequestAgain(existing.state)) {
    return existing;
  }
  const row: ActivationRequest = {
    ...draft,
    id: draft.id ?? newId(engine),
    nftContract: getAddress(draft.nftContract),
    state: "activation_requested",
    predictedAddress: null,
    accountAddress: null,
    reservationId: null,
    rejectReason: null,
  };
  return engine.store.saveRequest(row);
}

export async function reviewActivation(
  engine: BankEngine,
  requestId: string,
): Promise<{ request: ActivationRequest; decision: ReturnType<typeof evaluateActivation> }> {
  const request = await engine.store.getRequest(requestId);
  if (!request) {
    throw new Error("activation request not found");
  }
  const awaiting: ActivationRequest = { ...request, state: "awaiting_bank_approval" };
  await engine.store.saveRequest(awaiting);
  const existing = await engine.store.getByNft(request.chainId, request.nftContract, request.tokenId);
  const inFlight = existing && existing.id !== request.id && !canRequestAgain(existing.state) ? existing : null;
  const held = await engine.store.listHeldReservations();
  const daily = await engine.store.dailyGasSpentWei(nowIso(engine));
  const decision = evaluateActivation({
    request: awaiting,
    treasury: {
      ...engine.runtime.treasury,
      reservedWei: heldWei(held),
    },
    limits: engine.runtime.limits,
    openReservations: held,
    dailyGasSpentWei: daily,
    factoryDeployed: engine.runtime.factoryDeployed,
    relayerEnabled: engine.runtime.relayerEnabled && engine.relayer.enabled,
    existing: inFlight,
  });
  let next: ActivationRequest = {
    ...awaiting,
    state: nextStateAfterBank(decision, engine.runtime.factoryDeployed),
    rejectReason: decision.action === "approve" ? null : decision.reason,
  };
  if (decision.action === "approve") {
    const predicted = engine.predictAccount?.(identityOf(request)) ?? null;
    const deployment = await engine.store.saveReservation({
      id: newId(engine),
      requestId: request.id,
      bucket: "deployment",
      amountWei: decision.reserveDeploymentWei,
      state: "held",
    });
    await engine.store.saveReservation({
      id: newId(engine),
      requestId: request.id,
      bucket: "gas",
      amountWei: decision.reserveGasWei,
      state: "held",
    });
    next = {
      ...next,
      state: "predicted",
      predictedAddress: predicted,
      reservationId: deployment.id,
    };
  }
  return { request: await engine.store.saveRequest(next), decision };
}

export async function queueDeployment(engine: BankEngine, requestId: string): Promise<SponsoredJob> {
  const request = await engine.store.getRequest(requestId);
  if (!request) {
    throw new Error("activation request not found");
  }
  const key = `deploy:${identityKey(identityOf(request))}`;
  const duplicate = await engine.store.getJobByKey(key);
  if (duplicate && (duplicate.state === "queued" || duplicate.state === "submitted" || duplicate.state === "confirmed")) {
    return duplicate;
  }
  if (request.state !== "predicted" && request.state !== "deployment_pending") {
    const failed: SponsoredJob = {
      id: newId(engine),
      requestId,
      idempotencyKey: `invalid-deploy:${request.id}:${request.state}`,
      op: "factory.create",
      target: engine.runtime.factoryAddress ?? "0x0000000000000000000000000000000000000000",
      selector: toFunctionSelector("create(uint256,address,uint256)"),
      valueWei: 0n,
      estimatedGasWei: request.estimatedDeploymentWei,
      state: "failed",
      txHash: null,
      gasUsedWei: null,
      failureReason: `cannot deploy from state ${request.state}`,
    };
    return engine.store.saveJob(failed);
  }
  await engine.store.saveRequest({ ...request, state: "deployment_pending" });
  if (duplicate && (duplicate.state === "failed" || duplicate.state === "reverted")) {
    return engine.store.saveJob({
      ...duplicate,
      state: "queued",
      txHash: null,
      gasUsedWei: null,
      failureReason: null,
    });
  }
  const job: SponsoredJob = {
    id: duplicate?.id ?? newId(engine),
    requestId,
    idempotencyKey: key,
    op: "factory.create",
    target: engine.runtime.factoryAddress ?? "0x0000000000000000000000000000000000000000",
    selector: toFunctionSelector("create(uint256,address,uint256)"),
    valueWei: 0n,
    estimatedGasWei: request.estimatedDeploymentWei,
    state: "queued",
    txHash: null,
    gasUsedWei: null,
    failureReason: null,
  };
  return engine.store.saveJob(job);
}

export async function executeJob(engine: BankEngine, jobId: string): Promise<SponsoredJob> {
  const job = await engine.store.getJob(jobId);
  if (!job) {
    throw new Error("sponsored job not found");
  }
  if (job.state === "submitted" || job.state === "confirmed") {
    return job;
  }
  const sent = await engine.relayer.send({
    op: job.op,
    job: {
      idempotencyKey: job.idempotencyKey,
      target: job.target,
      selector: job.selector,
      valueWei: job.valueWei,
    },
  });
  if (!sent.ok) {
    const failed: SponsoredJob = {
      ...job,
      state: sent.kind === "reverted" ? "reverted" : "failed",
      failureReason: sent.reason,
    };
    await engine.store.saveJob(failed);
    if (job.op === "factory.create") {
      const request = await engine.store.getRequest(job.requestId);
      if (request) {
        await engine.store.saveRequest({ ...request, state: "error", rejectReason: sent.reason });
      }
      await releaseRequestReservations(engine, job.requestId, false, 0n);
    }
    return failed;
  }
  const submitted: SponsoredJob = {
    ...job,
    state: "submitted",
    txHash: sent.txHash,
    gasUsedWei: sent.gasUsedWei,
    failureReason: null,
  };
  return engine.store.saveJob(submitted);
}

export async function confirmDeployment(
  engine: BankEngine,
  requestId: string,
  evidence: { codePresent: boolean; accountAddress: Address | null },
): Promise<ActivationRequest> {
  const request = await engine.store.getRequest(requestId);
  if (!request) {
    throw new Error("activation request not found");
  }
  if (!evidence.codePresent || !evidence.accountAddress) {
    const failed = await engine.store.saveRequest({
      ...request,
      state: "error",
      rejectReason: "account bytecode was not observed",
    });
    await releaseRequestReservations(engine, requestId, false, 0n);
    return failed;
  }
  const deployed = await engine.store.saveRequest({
    ...request,
    state: "deployed",
    accountAddress: getAddress(evidence.accountAddress),
    predictedAddress: request.predictedAddress ?? getAddress(evidence.accountAddress),
  });
  const key = `deploy:${identityKey(identityOf(request))}`;
  const job = await engine.store.getJobByKey(key);
  const spent = job?.gasUsedWei ?? 0n;
  if (job && job.state === "submitted") {
    await engine.store.saveJob({ ...job, state: "confirmed" });
  }
  await releaseRequestReservations(engine, requestId, true, spent);
  return deployed;
}

export async function confirmAuthorization(
  engine: BankEngine,
  requestId: string,
  session: SessionPolicy,
): Promise<ActivationRequest> {
  const request = await engine.store.getRequest(requestId);
  if (!request) {
    throw new Error("activation request not found");
  }
  if (request.state !== "authorization_pending" && request.state !== "deployed") {
    return request;
  }
  if (session.dead || session.paused || session.executor === "0x0000000000000000000000000000000000000000") {
    return engine.store.saveRequest({
      ...request,
      state: "authorization_pending",
      rejectReason: "executor session is not live",
    });
  }
  await engine.store.saveSession(requestId, session);
  return engine.store.saveRequest({ ...request, state: "active", rejectReason: null });
}

type PreparedSponsorship =
  | { kind: "skipped"; reason: string }
  | { kind: "job"; job: SponsoredJob }
  | { kind: "invalidate"; request: ActivationRequest }
  | { kind: "hold"; job: SponsoredJob; reservation: Reservation };

export async function sponsorSessionCall(
  engine: BankEngine,
  input: {
    requestId: string;
    target: Address;
    selector: Hex;
    valueWei: bigint;
    estimatedGasWei: bigint;
    expectedNonce: bigint;
    executor: Address;
    currentOwner: Address;
    now: number;
    transfersAfterOpen: TransferLog[];
  },
): Promise<SponsoredJob | { skipped: true; reason: string }> {
  const prepared = await withSponsorshipLock(engine, () => prepareSessionSponsorship(engine, input));
  if (prepared.kind === "skipped") {
    return { skipped: true, reason: prepared.reason };
  }
  if (prepared.kind === "job") {
    return prepared.job;
  }
  if (prepared.kind === "invalidate") {
    return queueInvalidate(engine, prepared.request, "account.invalidateSession");
  }
  const executed = await executeJob(engine, prepared.job.id);
  if (executed.state === "submitted" || executed.state === "confirmed") {
    await settleReservation(engine, prepared.reservation, true, executed.gasUsedWei ?? 0n);
    if (executed.state === "submitted") {
      await engine.store.saveJob({ ...executed, state: "confirmed" });
    }
  } else {
    await settleReservation(engine, prepared.reservation, false, 0n);
  }
  return (await engine.store.getJob(executed.id))!;
}

async function prepareSessionSponsorship(
  engine: BankEngine,
  input: {
    requestId: string;
    target: Address;
    selector: Hex;
    valueWei: bigint;
    estimatedGasWei: bigint;
    expectedNonce: bigint;
    executor: Address;
    currentOwner: Address;
    now: number;
    transfersAfterOpen: TransferLog[];
  },
): Promise<PreparedSponsorship> {
  const request = await engine.store.getRequest(input.requestId);
  const session = await engine.store.getSession(input.requestId);
  if (!request || request.state !== "active" || !session) {
    return { kind: "skipped", reason: "citizen account is not active" };
  }
  if (engine.guard) {
    const ready = engine.guard.ready();
    if (!ready.ok) {
      return { kind: "skipped", reason: ready.reason };
    }
  }
  const transfersAfterOpen = [
    ...input.transfersAfterOpen,
    ...(engine.guard?.transfersAfter(request.tokenId, session.openedBlock) ?? []),
  ];
  const check = evaluateSessionExecution({
    session,
    currentOwner: input.currentOwner,
    executor: input.executor,
    target: input.target,
    selector: input.selector,
    valueWei: input.valueWei,
    expectedNonce: input.expectedNonce,
    now: input.now,
    transfersAfterOpen,
  });
  if (!check.ok && check.mustInvalidate) {
    return { kind: "invalidate", request };
  }
  if (!check.ok) {
    return { kind: "skipped", reason: check.reason };
  }
  const key = `session:${request.id}:${input.expectedNonce.toString()}:${input.selector}`;
  const duplicate = await engine.store.getJobByKey(key);
  const draft: Omit<SponsoredJob, "id" | "state" | "txHash" | "gasUsedWei" | "failureReason"> = {
    requestId: request.id,
    idempotencyKey: key,
    op: "account.executeSession",
    target: input.target,
    selector: input.selector,
    valueWei: input.valueWei,
    estimatedGasWei: input.estimatedGasWei,
  };
  const held = await engine.store.listHeldReservations();
  const decision = evaluateSponsorship({
    job: draft,
    sessionAlive: true,
    sessionSelector: session.selector,
    sessionTarget: session.target,
    treasury: { ...engine.runtime.treasury, reservedWei: heldWei(held) },
    limits: engine.runtime.limits,
    dailyGasSpentWei: await engine.store.dailyGasSpentWei(nowIso(engine)),
    duplicate,
    relayerEnabled: engine.runtime.relayerEnabled && engine.relayer.enabled,
  });
  if (decision.action === "skip") {
    return duplicate ? { kind: "job", job: duplicate } : { kind: "skipped", reason: decision.reason };
  }
  if (decision.action !== "approve") {
    return { kind: "skipped", reason: decision.reason };
  }
  const reservation = await engine.store.saveReservation({
    id: newId(engine),
    requestId: request.id,
    bucket: "gas",
    amountWei: decision.reserveGasWei,
    state: "held",
  });
  const job = await engine.store.saveJob({
    ...draft,
    id: newId(engine),
    state: "queued",
    txHash: null,
    gasUsedWei: null,
    failureReason: null,
  });
  return { kind: "hold", job, reservation };
}

async function queueInvalidate(
  engine: BankEngine,
  request: ActivationRequest,
  op: RelayerOp,
): Promise<SponsoredJob> {
  const key = `invalidate:${request.id}`;
  const duplicate = await engine.store.getJobByKey(key);
  if (duplicate) {
    return duplicate;
  }
  const job = await engine.store.saveJob({
    id: newId(engine),
    requestId: request.id,
    idempotencyKey: key,
    op,
    target: request.accountAddress ?? "0x0000000000000000000000000000000000000000",
    selector: toFunctionSelector("invalidateSession()"),
    valueWei: 0n,
    estimatedGasWei: 0n,
    state: "queued",
    txHash: null,
    gasUsedWei: null,
    failureReason: null,
  });
  const session = await engine.store.getSession(request.id);
  if (session) {
    await engine.store.saveSession(request.id, { ...session, dead: true });
  }
  return executeJob(engine, job.id);
}

async function releaseRequestReservations(
  engine: BankEngine,
  requestId: string,
  success: boolean,
  actualWei: bigint,
): Promise<void> {
  const held = (await engine.store.listHeldReservations()).filter((row) => row.requestId === requestId);
  let remaining = actualWei;
  for (const row of held) {
    const use = row.bucket === "deployment" || row.bucket === "gas" ? remaining : 0n;
    const applied = use < row.amountWei ? use : row.amountWei;
    remaining = remaining > applied ? remaining - applied : 0n;
    await settleReservation(engine, row, success, applied);
  }
}

async function settleReservation(
  engine: BankEngine,
  reservation: Reservation,
  success: boolean,
  actualWei: bigint,
): Promise<void> {
  const result = reconcileReservation({ held: reservation, actualWei, success });
  await engine.store.saveReservation(result.reservation);
  if (result.spentWei > 0n) {
    await engine.store.appendLedger({
      id: newId(engine),
      bucket: bucketForReservation(reservation.bucket),
      deltaWei: result.spentWei,
      ref: reservation.id,
      at: nowIso(engine),
    });
  }
}

export async function recoverActivation(engine: BankEngine, requestId: string): Promise<ActivationRequest> {
  const request = await engine.store.getRequest(requestId);
  if (!request) {
    throw new Error("activation request not found");
  }
  if (request.state !== "error" && request.state !== "deployment_pending") {
    return request;
  }
  const key = `deploy:${identityKey(identityOf(request))}`;
  const job = await engine.store.getJobByKey(key);
  if (job && (job.state === "submitted" || job.state === "confirmed")) {
    return request;
  }
  if (job && (job.state === "failed" || job.state === "reverted")) {
    await engine.store.saveJob({
      ...job,
      state: "queued",
      txHash: null,
      gasUsedWei: null,
      failureReason: null,
    });
    return engine.store.saveRequest({
      ...request,
      state: "predicted",
      rejectReason: job.failureReason,
    });
  }
  return request;
}

export function sameIdentity(a: ActivationRequest, b: ActivationRequest): boolean {
  return identityKey(identityOf(a)) === identityKey(identityOf(b));
}
