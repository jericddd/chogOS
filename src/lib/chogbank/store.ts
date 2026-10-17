import type {
  ActivationRequest,
  LedgerEntry,
  Reservation,
  SessionPolicy,
  SponsoredJob,
} from "@/lib/chogbank/types";

export type ChogBankStore = {
  getByIdentity(citizenId: string, tokenId: string): Promise<ActivationRequest | null>;
  getByNft(chainId: number, nftContract: string, tokenId: string): Promise<ActivationRequest | null>;
  getRequest(id: string): Promise<ActivationRequest | null>;
  saveRequest(row: ActivationRequest): Promise<ActivationRequest>;
  listHeldReservations(): Promise<Reservation[]>;
  saveReservation(row: Reservation): Promise<Reservation>;
  getReservation(id: string): Promise<Reservation | null>;
  getJobByKey(idempotencyKey: string): Promise<SponsoredJob | null>;
  getJob(id: string): Promise<SponsoredJob | null>;
  saveJob(row: SponsoredJob): Promise<SponsoredJob>;
  dailyGasSpentWei(now: string): Promise<bigint>;
  appendLedger(row: LedgerEntry): Promise<LedgerEntry>;
  ledger(): Promise<LedgerEntry[]>;
  saveSession(requestId: string, session: SessionPolicy): Promise<void>;
  getSession(requestId: string): Promise<SessionPolicy | null>;
};

export type BankStoreResult<T> = { ok: true; value: T } | { ok: false; reason: string };
