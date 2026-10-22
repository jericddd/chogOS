"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CitizenPortrait, MetadataName } from "@/components/citizens/portrait";
import { formatUtc } from "@/lib/civilization/labels";

type OwnedToken = {
  tokenId: string;
  owner: string;
  heldByTreasury: boolean;
  enrolledAt: string | null;
  enrollmentStatus: string | null;
  origin: "founding_treasury" | "community" | null;
  citizenId: string | null;
};

const chains: Record<number, { name: string; rpc: string; explorer: string }> = {
  143: {
    name: "Monad Mainnet",
    rpc: "https://rpc.monad.xyz",
    explorer: "https://monadscan.com",
  },
  10143: {
    name: "Monad Testnet",
    rpc: "https://testnet-rpc.monad.xyz",
    explorer: "https://testnet.monadscan.com",
  },
};

function provider(): { request(args: { method: string; params?: unknown[] }): Promise<unknown> } | null {
  if (typeof window === "undefined") {
    return null;
  }
  const candidate = (
    window as Window & {
      ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
    }
  ).ethereum;
  return candidate ?? null;
}

function hexChain(chainId: number): string {
  return `0x${chainId.toString(16)}`;
}

function hexMessage(message: string): string {
  const bytes = new TextEncoder().encode(message);
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function joined(token: OwnedToken): boolean {
  return token.enrollmentStatus === "active" && Boolean(token.citizenId);
}

export function EnrollPanel({
  chainId,
  persistenceReady,
  focusedTokenId,
}: {
  chainId: number;
  persistenceReady: boolean;
  focusedTokenId: string | null;
}) {
  const router = useRouter();
  const [address, setAddress] = useState<string | null>(null);
  const [walletChain, setWalletChain] = useState<number | null>(null);
  const [owned, setOwned] = useState<OwnedToken[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(focusedTokenId);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ethereum = provider();
    if (!ethereum) {
      return;
    }
    let cancelled = false;
    void ethereum
      .request({ method: "eth_accounts" })
      .then(async (accounts) => {
        const list = accounts as string[];
        const chainHex = (await ethereum.request({ method: "eth_chainId" })) as string;
        if (cancelled) {
          return;
        }
        setAddress(list[0] ?? null);
        setWalletChain(Number(chainHex));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!address) {
      return;
    }
    void discover(address);
    // discover is recreated each render; the wallet address is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  async function connect() {
    const ethereum = provider();
    if (!ethereum) {
      setStatus("No injected EVM wallet was found in this browser.");
      return;
    }
    setBusy(true);
    try {
      const accounts = (await ethereum.request({ method: "eth_requestAccounts" })) as string[];
      const chainHex = (await ethereum.request({ method: "eth_chainId" })) as string;
      setAddress(accounts[0] ?? null);
      setWalletChain(Number(chainHex));
      setStatus(null);
    } catch {
      setStatus("The wallet did not connect.");
    } finally {
      setBusy(false);
    }
  }

  async function switchChain() {
    const ethereum = provider();
    if (!ethereum) {
      return;
    }
    const chain = chains[chainId];
    try {
      await ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: hexChain(chainId) }],
      });
    } catch {
      if (!chain) {
        setStatus(`Switch the wallet to chain ${chainId}.`);
        return;
      }
      try {
        await ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: hexChain(chainId),
              chainName: chain.name,
              nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
              rpcUrls: [chain.rpc],
              blockExplorerUrls: [chain.explorer],
            },
          ],
        });
      } catch {
        setStatus(`Switch the wallet to ${chain.name} (chain ${chainId}).`);
        return;
      }
    }
    const chainHex = (await ethereum.request({ method: "eth_chainId" })) as string;
    setWalletChain(Number(chainHex));
  }

  async function discover(wallet: string, prefer?: string) {
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch("/api/enroll/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: wallet }),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        error?: string;
        owned?: OwnedToken[];
      };
      if (!body.ok) {
        setOwned([]);
        setStatus(body.error ?? "Discovery failed.");
        return;
      }
      const tokens = body.owned ?? [];
      setOwned(tokens);
      const preferred = [prefer, focusedTokenId].find((id) => id && tokens.some((token) => token.tokenId === id));
      setSelectedId((current) => {
        if (preferred) {
          return preferred;
        }
        if (current && tokens.some((token) => token.tokenId === current)) {
          return current;
        }
        return tokens[0]?.tokenId ?? null;
      });
      if (tokens.length === 0) {
        setStatus("This wallet does not hold a Chog Genesis NFT.");
        if (focusedTokenId) {
          router.replace("/enroll", { scroll: false });
        }
        return;
      }
      const focusedOwned = Boolean(focusedTokenId && tokens.some((token) => token.tokenId === focusedTokenId));
      const onlyJoined = tokens.length === 1 && joined(tokens[0]) ? tokens[0] : null;
      if (onlyJoined && focusedTokenId !== onlyJoined.tokenId) {
        router.replace(`/enroll?token=${onlyJoined.tokenId}`, { scroll: false });
      } else if (focusedTokenId && !focusedOwned) {
        router.replace("/enroll", { scroll: false });
      }
    } catch {
      setStatus("Discovery could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  function choose(token: OwnedToken) {
    setSelectedId(token.tokenId);
    if (joined(token)) {
      if (focusedTokenId !== token.tokenId) {
        router.replace(`/enroll?token=${token.tokenId}`, { scroll: false });
      }
      return;
    }
    if (focusedTokenId) {
      router.replace("/enroll", { scroll: false });
    }
  }

  async function enroll() {
    const selected = owned.find((token) => token.tokenId === selectedId) ?? null;
    if (!address || !selected) {
      setStatus("Choose a Chog from this wallet.");
      return;
    }
    if (selected.heldByTreasury) {
      setStatus("ChogTreasury already holds this NFT. It stays a founding citizen.");
      return;
    }
    if (joined(selected)) {
      setStatus(`Chog #${selected.tokenId} joined ${formatUtc(selected.enrolledAt)}.`);
      return;
    }
    if (!persistenceReady) {
      setStatus("Enrollment cannot be saved until Supabase is configured on the server.");
      return;
    }
    if (walletChain !== chainId) {
      setStatus(`Switch the wallet to chain ${chainId} before signing.`);
      return;
    }
    const ethereum = provider();
    if (!ethereum) {
      return;
    }
    setBusy(true);
    try {
      const challengeResponse = await fetch("/api/enroll/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, tokenIds: [selected.tokenId] }),
      });
      const challenge = (await challengeResponse.json()) as {
        ok?: boolean;
        error?: string;
        message?: string;
        nonce?: string;
      };
      if (!challenge.ok || !challenge.message || !challenge.nonce) {
        setStatus(challenge.error ?? "The server did not issue a challenge.");
        return;
      }
      const signature = (await ethereum.request({
        method: "personal_sign",
        params: [hexMessage(challenge.message), address],
      })) as string;
      const confirmResponse = await fetch("/api/enroll/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, nonce: challenge.nonce, signature }),
      });
      const confirmed = (await confirmResponse.json()) as {
        ok?: boolean;
        error?: string;
        enrolled?: string[];
        unchanged?: string[];
      };
      if (!confirmed.ok) {
        setStatus(confirmed.error ?? "Enrollment was rejected.");
        return;
      }
      const enrolled = confirmed.enrolled ?? [];
      const unchanged = confirmed.unchanged ?? [];
      const tokenId = enrolled[0] ?? unchanged[0] ?? selected.tokenId;
      setStatus(
        enrolled.length > 0
          ? `Chog #${tokenId} joined chogOS.`
          : `Chog #${tokenId} is already enrolled for this owner.`,
      );
      router.replace(`/enroll?token=${tokenId}`, { scroll: false });
      router.refresh();
      await discover(address, tokenId);
    } catch {
      setStatus("The wallet did not sign, or the server could not finish enrollment.");
    } finally {
      setBusy(false);
    }
  }

  const onChain = walletChain === chainId;
  const selected = owned.find((token) => token.tokenId === selectedId) ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => void connect()}
          disabled={busy}
          className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-[#062117] disabled:opacity-60"
        >
          {address ? "Wallet connected" : "Connect wallet"}
        </button>
        {address && !onChain ? (
          <button type="button" onClick={() => void switchChain()} className="rounded-full border border-line px-4 py-2 text-sm">
            Switch to chain {chainId}
          </button>
        ) : null}
      </div>
      {address ? <p className="font-mono text-xs break-all text-muted">{address}</p> : null}
      {address ? (
        <p className="text-sm text-muted">
          Wallet network {walletChain ?? "unknown"}. chogOS expects chain {chainId}.
          {onChain ? " Network matches." : " Switch before signing."}
        </p>
      ) : (
        <p className="text-sm leading-6 text-muted">
          Connect the wallet that holds the NFT. Its Chogs appear here, and you choose which one joins.
        </p>
      )}
      {!persistenceReady ? (
        <p className="text-sm leading-6 text-warning">
          The database is not configured, so enrollment cannot be stored. The wallet can still show the NFTs it holds.
        </p>
      ) : null}
      {owned.length > 0 ? (
        <fieldset>
          <legend className="text-sm text-muted">Chogs in this wallet</legend>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {owned.map((token) => {
              const active = selectedId === token.tokenId;
              return (
                <li key={token.tokenId}>
                  <button
                    type="button"
                    data-testid="owned-chog"
                    aria-pressed={active}
                    onClick={() => choose(token)}
                    className={`w-full rounded-2xl border p-3 text-left ${active ? "border-accent" : "border-line"}`}
                  >
                    <div className="portrait-frame aspect-square overflow-hidden rounded-xl border border-line">
                      <CitizenPortrait tokenId={token.tokenId} />
                    </div>
                    <p className="mt-3 font-serif text-xl">
                      <MetadataName tokenId={token.tokenId} fallback={`Chog #${token.tokenId}`} />
                    </p>
                    <p className="mt-1 text-sm text-muted">Token {token.tokenId}</p>
                    <p className="mt-1 text-sm text-muted">
                      {token.heldByTreasury
                        ? "Held by ChogTreasury. Founding citizen."
                        : joined(token)
                          ? `Joined ${formatUtc(token.enrolledAt)}`
                          : "Not joined yet."}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
          {selected && !selected.heldByTreasury && !joined(selected) ? (
            <button
              type="button"
              data-testid="join-chog"
              disabled={busy}
              onClick={() => void enroll()}
              className="mt-4 rounded-full bg-accent px-4 py-2 text-sm font-medium text-[#062117] disabled:opacity-60"
            >
              Join Chog #{selected.tokenId}
            </button>
          ) : null}
          {selected && joined(selected) && focusedTokenId === selected.tokenId ? (
            <p className="mt-4 text-sm text-muted">
              Joined {formatUtc(selected.enrolledAt)}. The profile below is the same record as the citizen page.
            </p>
          ) : null}
        </fieldset>
      ) : null}
      {status ? <p className="text-sm leading-6 text-muted">{status}</p> : null}
    </div>
  );
}
