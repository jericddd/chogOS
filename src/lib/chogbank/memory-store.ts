import { getAddress } from "viem";
import type { ChogBankStore } from "@/lib/chogbank/store";
import type {
  ActivationRequest,
  LedgerEntry,
  Reservation,
  SessionPolicy,
  SponsoredJob,
} from "@/lib/chogbank/types";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryChogBankStore implements ChogBankStore {
  requests: ActivationRequest[] = [];
  reservations: Reservation[] = [];
  jobs: SponsoredJob[] = [];
  entries: LedgerEntry[] = [];
  sessions = new Map<string, SessionPolicy>();

  async getByIdentity(citizenId: string, tokenId: string) {
    const rows = this.requests.filter((row) => row.citizenId === citizenId && row.tokenId === tokenId);
    return rows.length ? clone(rows[rows.length - 1]!) : null;
  }

  async getByNft(chainId: number, nftContract: string, tokenId: string) {
    const nft = getAddress(nftContract).toLowerCase();
    const rows = this.requests.filter(
      (row) => row.chainId === chainId && row.nftContract.toLowerCase() === nft && row.tokenId === tokenId,
    );
    return rows.length ? clone(rows[rows.length - 1]!) : null;
  }

  async getRequest(id: string) {
    const found = this.requests.find((row) => row.id === id);
    return found ? clone(found) : null;
  }

  async saveRequest(row: ActivationRequest) {
    const index = this.requests.findIndex((item) => item.id === row.id);
    if (index >= 0) {
      this.requests[index] = clone(row);
    } else {
      this.requests.push(clone(row));
    }
    return clone(row);
  }

  async listHeldReservations() {
    return this.reservations.filter((row) => row.state === "held").map(clone);
  }

  async saveReservation(row: Reservation) {
    const index = this.reservations.findIndex((item) => item.id === row.id);
    if (index >= 0) {
      this.reservations[index] = clone(row);
    } else {
      this.reservations.push(clone(row));
    }
    return clone(row);
  }

  async getReservation(id: string) {
    const found = this.reservations.find((row) => row.id === id);
    return found ? clone(found) : null;
  }

  async getJobByKey(idempotencyKey: string) {
    const found = this.jobs.find((row) => row.idempotencyKey === idempotencyKey);
    return found ? clone(found) : null;
  }

  async getJob(id: string) {
    const found = this.jobs.find((row) => row.id === id);
    return found ? clone(found) : null;
  }

  async saveJob(row: SponsoredJob) {
    const index = this.jobs.findIndex((item) => item.id === row.id);
    if (index >= 0) {
      this.jobs[index] = clone(row);
    } else {
      this.jobs.push(clone(row));
    }
    return clone(row);
  }

  async dailyGasSpentWei(now: string) {
    const day = now.slice(0, 10);
    return this.entries
      .filter((row) => row.bucket === "sponsored_gas_spent" && row.at.slice(0, 10) === day && row.deltaWei > 0n)
      .reduce((sum, row) => sum + row.deltaWei, 0n);
  }

  async appendLedger(row: LedgerEntry) {
    this.entries.push(clone(row));
    return clone(row);
  }

  async ledger() {
    return this.entries.map(clone);
  }

  async saveSession(requestId: string, session: SessionPolicy) {
    this.sessions.set(requestId, clone(session));
  }

  async getSession(requestId: string) {
    const found = this.sessions.get(requestId);
    return found ? clone(found) : null;
  }
}
