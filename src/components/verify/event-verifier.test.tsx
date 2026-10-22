// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventVerifier } from "@/components/verify/event-verifier";
import { ProvenancePanel } from "@/components/verify/provenance-panel";
import { hashEvent } from "@/lib/verify/canonical";
import { buildEventTree, proofForHash, TREE_FORMAT } from "@/lib/verify/merkle";
import { OFFCHAIN_ROOT_SENTENCE } from "@/lib/verify/anchor";
import type { VerifyBundle } from "@/lib/verify/types";

vi.mock("next/link", () => ({
  default: (props: { href: string; children: React.ReactNode }) => <a href={props.href}>{props.children}</a>,
}));

const event = {
  id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  seq: 3,
  kind: "citizen.acted",
  category: "ai",
  source: "ai",
  summary: "The AI mind recorded a plan.",
  occurredAt: "2026-10-19T00:00:00.000Z",
  createdAt: "2026-10-19T00:00:00.000Z",
  chainStatus: "offchain",
  payload: {},
  stateTransition: {},
  prevEventHash: null,
};

function bundle(patch: Partial<VerifyBundle> = {}): VerifyBundle {
  const storedHash = hashEvent(event);
  return {
    schema: "chogos-verify-export-v2",
    event,
    storedHash,
    serverRecomputedHash: storedHash,
    integrityClass: "historical",
    previous: null,
    next: null,
    proof: null,
    batch: null,
    anchor: null,
    anchorObservation: null,
    anchorRead: { attempted: false, reason: "No onchain anchor is recorded." },
    anchorIssue: null,
    explorerTxUrl: null,
    explorerContractUrl: null,
    explorerBlockUrl: null,
    transfer: null,
    transferLog: null,
    onchain: null,
    mind: null,
    provenance: {
      repository: "https://github.com/jericddd/chogOS",
      revision: { sha: null, label: "Build revision unavailable" },
      commitUrl: null,
      sources: [{ path: "src/lib/verify/canonical.ts", url: null }],
    },
    artifacts: [
      {
        id: "v2-factory",
        label: "CitizenAccountFactory V2 creation code",
        hash: `0x${"ab".repeat(32)}`,
        hashKind: "creation-code keccak256",
        address: "0x8a74ea74eb0674ef4dc178263e4583fb502b77ad",
        chainId: 143,
        explorerUrl: "https://monadscan.com/address/0x8a74ea74eb0674ef4dc178263e4583fb502b77ad",
        deployment: "predicted_not_deployed",
        note: "Predicted and not broadcast.",
        codeBytes: 0,
        codeLabel: "Predicted and undeployed. No bytecode was found at this address.",
      },
    ],
    eventPath: `/verify/events/${event.id}`,
    reviewerChecks: ["Recompute the SHA-256 of the canonical document."],
    notes: ["This export is data."],
    ...patch,
  };
}

afterEach(() => {
  cleanup();
});

describe("event verifier", () => {
  it("copies the full stored hash and does not call an AI event a chain transaction", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const stored = hashEvent(event);
    render(<EventVerifier bundle={bundle()} />);
    expect(screen.getByText("Recorded world event")).toBeTruthy();
    expect(screen.queryByText("Real chain activity")).toBeNull();
    expect(screen.getByText("event_hash_verified")).toBeTruthy();
    expect(screen.queryByText("onchain_anchor_verified")).toBeNull();
    const values = [...document.querySelectorAll("[data-full-value]")].map((node) => node.getAttribute("data-full-value"));
    expect(values).toContain(stored);
    fireEvent.click(screen.getByRole("button", { name: "Copy Stored event hash" }));
    expect(writeText).toHaveBeenCalledWith(stored);
    expect(screen.queryByText("Predicted and undeployed. No bytecode was found at this address.")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Deployment artifacts" })).toBeNull();
    expect(screen.getByText("Build revision unavailable")).toBeTruthy();
  });

  it("shows the offchain-root sentence when a Merkle proof has no anchor", () => {
    const stored = hashEvent(event);
    const tree = buildEventTree([stored]);
    const proof = proofForHash(tree, stored);
    render(
      <EventVerifier
        bundle={bundle({
          proof: { format: TREE_FORMAT, leafEncoding: ["bytes32"], root: tree.root, proof: proof.proof },
          batch: {
            id: "batch-1",
            kind: "historical_snapshot",
            treeFormat: TREE_FORMAT,
            fromSeq: 3,
            toSeq: 3,
            eventCount: 1,
            merkleRoot: tree.root,
            snapshotCommittedAt: null,
            anchorStatus: "unanchored",
          },
        })}
      />,
    );
    expect(screen.getByText("merkle_proof_verified")).toBeTruthy();
    expect(screen.getByText(OFFCHAIN_ROOT_SENTENCE)).toBeTruthy();
    expect(screen.queryByText("onchain_anchor_verified")).toBeNull();
  });

  it("links a canonical transfer and shows a failed check", () => {
    const hash = `0x${"ab".repeat(32)}`;
    const contract = "0xc96d31f8626c6d03fae5dcd3d61e3fb9f4a73763";
    render(
      <EventVerifier
        bundle={bundle({
          event: { ...event, source: "onchain", category: "onchain", kind: "nft.transferred", chainStatus: "confirmed", chainId: 143, txHash: hash },
          storedHash: "0x" + "11".repeat(32),
          transfer: {
            kind: "nft.transferred",
            canonical: true,
            consistent: true,
            canonicalState: "canonical",
            chainStatus: "confirmed",
            issues: [],
            chainId: 143,
            txHash: hash,
            payloadTxHash: null,
            blockNumber: "11",
            blockHash: `0x${"cd".repeat(32)}`,
            txIndex: null,
            logIndex: "4",
            contract,
            tokenId: "104",
            from: "0x1111111111111111111111111111111111111111",
            to: "0x2222222222222222222222222222222222222222",
            links: {
              transaction: `https://monadscan.com/tx/${hash}`,
              block: "https://monadscan.com/block/11",
              contract: `https://monadscan.com/address/${contract}`,
              from: "https://monadscan.com/address/0x1111111111111111111111111111111111111111",
              to: "https://monadscan.com/address/0x2222222222222222222222222222222222222222",
              token: `https://monadscan.com/nft/${contract}/104`,
            },
          },
        })}
      />,
    );
    expect(screen.getByText("Recorded Chog Genesis mainnet transfer")).toBeTruthy();
    expect(screen.getByText(/has not independently verified this transaction/)).toBeTruthy();
    expect(screen.getByText("not read")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Transaction" }).getAttribute("href")).toBe(`https://monadscan.com/tx/${hash}`);
    expect(screen.getByText("not recorded on this activity")).toBeTruthy();
    expect(screen.getByText("verification_failed")).toBeTruthy();
    expect(screen.getByText(/Recomputed event hash does not match/)).toBeTruthy();
  });

  it("does not label a wrong contract or a matched flag without a read as verified mainnet activity", () => {
    const hash = `0x${"ab".repeat(32)}`;
    const wrong = "0x1111111111111111111111111111111111111111";
    const { unmount } = render(
      <EventVerifier
        bundle={bundle({
          transfer: {
            kind: "nft.transferred",
            canonical: true,
            consistent: true,
            canonicalState: "canonical",
            chainStatus: "confirmed",
            issues: [],
            chainId: 143,
            txHash: hash,
            payloadTxHash: null,
            blockNumber: "11",
            blockHash: `0x${"cd".repeat(32)}`,
            txIndex: null,
            logIndex: "4",
            contract: wrong,
            tokenId: "104",
            from: "0x1111111111111111111111111111111111111111",
            to: "0x2222222222222222222222222222222222222222",
            links: {
              transaction: `https://monadscan.com/tx/${hash}`,
              block: "https://monadscan.com/block/11",
              contract: `https://monadscan.com/address/${wrong}`,
              from: "https://monadscan.com/address/0x1111111111111111111111111111111111111111",
              to: "https://monadscan.com/address/0x2222222222222222222222222222222222222222",
              token: `https://monadscan.com/nft/${wrong}/104`,
            },
          },
          transferLog: { attempted: true, matched: true, summary: "A read-only receipt check matched the stored Chog Genesis transfer log." },
        })}
      />,
    );
    expect(screen.getByText("Not Chog Genesis mainnet activity")).toBeTruthy();
    expect(screen.getByText(/not the Chog Genesis contract/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Transaction" })).toBeNull();
    expect(screen.queryByText("Recorded Chog Genesis mainnet transfer")).toBeNull();
    expect(screen.queryByText(/read-only receipt check matched/)).toBeNull();
    expect(screen.getByText("not read")).toBeTruthy();
    unmount();

    const contract = "0xc96d31f8626c6d03fae5dcd3d61e3fb9f4a73763";
    const { unmount: unmountMismatch } = render(
      <EventVerifier
        bundle={bundle({
          transfer: {
            kind: "nft.transferred",
            canonical: true,
            consistent: true,
            canonicalState: "canonical",
            chainStatus: "confirmed",
            issues: [],
            chainId: 143,
            txHash: hash,
            payloadTxHash: null,
            blockNumber: "11",
            blockHash: `0x${"cd".repeat(32)}`,
            txIndex: null,
            logIndex: "4",
            contract,
            tokenId: "104",
            from: "0x1111111111111111111111111111111111111111",
            to: "0x2222222222222222222222222222222222222222",
            links: {
              transaction: `https://monadscan.com/tx/${hash}`,
              block: "https://monadscan.com/block/11",
              contract: `https://monadscan.com/address/${contract}`,
              from: "https://monadscan.com/address/0x1111111111111111111111111111111111111111",
              to: "https://monadscan.com/address/0x2222222222222222222222222222222222222222",
              token: `https://monadscan.com/nft/${contract}/104`,
            },
          },
          transferLog: {
            attempted: true,
            matched: false,
            summary: "The transaction receipt was not found.",
          },
        })}
      />,
    );
    expect(screen.getByText("Stored transfer did not match the chain")).toBeTruthy();
    expect(screen.getByText("not matched")).toBeTruthy();
    expect(screen.getByText("The transaction receipt was not found.")).toBeTruthy();
    expect(screen.queryByText(/independently verified this transaction/)).toBeNull();
    expect(screen.getByRole("link", { name: "Transaction" }).getAttribute("href")).toBe(`https://monadscan.com/tx/${hash}`);
    unmountMismatch();

    render(
      <EventVerifier
        bundle={bundle({
          transferLog: {
            attempted: true,
            matched: true,
            summary: "A read-only receipt check matched the stored Chog Genesis transfer log.",
          },
        })}
      />,
    );
    expect(screen.getByText("Recorded world event")).toBeTruthy();
    expect(screen.queryByText("A read-only receipt check matched the stored Chog Genesis transfer log.")).toBeNull();
  });

  it("shows the mind's reason and the Monad links for a created wallet", () => {
    const tx = `0x${"ab".repeat(32)}`;
    const wallet = "0x238797c75Ad0423516F84D917B7A9d765831bf02";
    const factory = "0xE1236D88f64206555c7E9FCfC3c742B2BAa2fc6A";
    render(
      <EventVerifier
        bundle={bundle({
          event: { ...event, kind: "wallet.created", summary: "The AI mind created the permanent wallet for Chog #104 on Monad." },
          mind: { summary: null, rationale: "Every enrolled citizen gets one permanent wallet." },
          onchain: {
            title: "Monad wallet creation",
            note: "Open the transaction, block, citizen wallet, factory, and Genesis token on Monadscan.",
            links: [
              { label: "Transaction", href: `https://monadscan.com/tx/${tx}`, value: tx },
              { label: "Block", href: "https://monadscan.com/block/115600416", value: "115600416" },
              { label: "Citizen wallet", href: `https://monadscan.com/address/${wallet.toLowerCase()}`, value: wallet },
              { label: "Wallet factory", href: `https://monadscan.com/address/${factory.toLowerCase()}`, value: factory },
              { label: "Genesis token", href: "https://monadscan.com/nft/0xc96d31f8626c6d03fae5dcd3d61e3fb9f4a73763/104", value: "104" },
            ],
          },
        })}
      />,
    );
    expect(screen.getByText("Monad wallet creation")).toBeTruthy();
    expect(screen.getByText("Every enrolled citizen gets one permanent wallet.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Transaction" }).getAttribute("href")).toBe(`https://monadscan.com/tx/${tx}`);
    expect(screen.getByRole("link", { name: "Block" }).getAttribute("href")).toBe("https://monadscan.com/block/115600416");
    expect(screen.getByRole("link", { name: "Citizen wallet" }).getAttribute("href")).toContain("/address/");
    expect(screen.getByRole("link", { name: "Wallet factory" }).getAttribute("href")).toContain(factory.toLowerCase());
    expect(screen.getByRole("link", { name: "Genesis token" }).getAttribute("href")).toContain("/nft/");
  });
});

describe("provenance panel", () => {
  it("says the build revision is unavailable instead of guessing a commit", () => {
    render(
      <ProvenancePanel
        provenance={{
          repository: "https://github.com/jericddd/chogOS",
          revision: { sha: null, label: "Build revision unavailable" },
          commitUrl: null,
          sources: [{ path: "contracts/src/EventAnchor.sol", url: null }],
        }}
        anchorAddress={null}
        anchorChainId={null}
        anchorExplorerUrl={null}
      />,
    );
    expect(screen.getByText("Build revision unavailable")).toBeTruthy();
    expect(screen.getByText(/Merkle proof verified offchain; no onchain root commitment has been verified\./)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /commit/i })).toBeNull();
  });
});
