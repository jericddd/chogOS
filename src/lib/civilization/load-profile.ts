import "server-only";
import { createGenesisReaderForConfig } from "@/lib/blockchain/genesis-reader";
import { loadWorldSnapshot } from "@/lib/civilization/load-world";
import { openCivilizationStore } from "@/lib/civilization/open-store";
import type { DisplayCitizen } from "@/lib/civilization/roster";
import { parseTokenId, sameAddress } from "@/lib/civilization/token-id";
import type { CivilizationEvent } from "@/lib/civilization/types";
import { readAppConfig } from "@/lib/config/env";

export type CitizenProfile =
  | { status: "invalid"; reason: string }
  | {
      status: "missing";
      tokenId: string;
      note: string;
    }
  | {
      status: "unenrolled";
      tokenId: string;
      owner: string;
      note: string;
      heldByTreasury: boolean;
    }
  | {
      status: "found";
      citizen: DisplayCitizen;
      chainOwner: string | null;
      ownerNote: string;
      events: CivilizationEvent[];
      heldByTreasury: boolean;
      treasury: string;
      enrolledAt: string | null;
    };

export async function loadCitizenProfile(rawTokenId: string): Promise<CitizenProfile> {
  const parsed = parseTokenId(decodeURIComponent(rawTokenId));
  if (!parsed.ok) {
    return { status: "invalid", reason: parsed.reason };
  }

  const world = await loadWorldSnapshot();
  const known = world.display.find((citizen) => citizen.tokenId === parsed.tokenId) ?? null;
  const events = await eventsForToken(parsed.tokenId, world.events);
  const ownerRead = await readCurrentOwner(parsed.tokenId);

  if (!known && !ownerRead.owner) {
    return {
      status: "missing",
      tokenId: parsed.tokenId,
      note: ownerRead.note,
    };
  }

  if (!known && ownerRead.owner) {
    return {
      status: "unenrolled",
      tokenId: parsed.tokenId,
      owner: ownerRead.owner,
      heldByTreasury: sameAddress(ownerRead.owner, world.treasury),
      note: sameAddress(ownerRead.owner, world.treasury)
        ? "ownerOf says ChogTreasury holds this NFT, but it is not in the latest treasury discovery set. Refresh the roster before treating it as a founding citizen."
        : "This token has an owner on the Chog Genesis contract and is not a citizen record yet.",
    };
  }

  const record = world.citizens.find((citizen) => citizen.tokenId === parsed.tokenId) ?? null;
  return {
    status: "found",
    citizen: known as DisplayCitizen,
    chainOwner: ownerRead.owner,
    ownerNote: ownerRead.note,
    events,
    heldByTreasury: ownerRead.owner ? sameAddress(ownerRead.owner, world.treasury) : false,
    treasury: world.treasury,
    enrolledAt: record?.enrollmentStatus === "active" ? record.enrolledAt : null,
  };
}

async function eventsForToken(tokenId: string, recent: CivilizationEvent[]): Promise<CivilizationEvent[]> {
  const store = openCivilizationStore();
  if (!store) {
    return recent.filter((event) => event.tokenId === tokenId);
  }
  try {
    return await store.listEventsForToken(tokenId, 40);
  } catch {
    return recent.filter((event) => event.tokenId === tokenId);
  }
}

async function readCurrentOwner(tokenId: string): Promise<{ owner: string | null; note: string }> {
  try {
    const reader = createGenesisReaderForConfig(readAppConfig());
    const observation = await reader.readOwner(tokenId);
    if (observation.status === "failed") {
      return { owner: null, note: observation.reason };
    }
    return { owner: observation.owner, note: "Current owner from ownerOf on this request." };
  } catch (error) {
    return {
      owner: null,
      note: error instanceof Error ? error.message.slice(0, 200) : "ownerOf failed.",
    };
  }
}
