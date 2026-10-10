"use client";

import { useState } from "react";

type OwnedToken = { tokenId: string; owner: string };
type RejectedToken = { tokenId: string; reason: string };

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

export function EnrollPanel({
  chainId,
  persistenceReady,
}: {
  chainId: number;
  persistenceReady: boolean;
}) {
  const [address, setAddress] = useState<string | null>(null);
  const [walletChain, setWalletChain] = useState<number | null>(null);
  const [owned, setOwned] = useState<OwnedToken[]>([]);
  const [rejected, setRejected] = useState<RejectedToken[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [manual, setManual] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  async function discover(manualIds: string[] | null) {
    if (!address) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch("/api/enroll/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, tokenIds: manualIds ?? undefined }),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        error?: string;
        manualTokenIdsRequired?: boolean;
        owned?: OwnedToken[];
        rejected?: RejectedToken[];
      };
      if (!body.ok) {
        setOwned([]);
        setRejected([]);
        setStatus(body.error ?? "Discovery failed.");
        return;
      }
      setOwned(body.owned ?? []);
      setRejected(body.rejected ?? []);
      setSelected((body.owned ?? []).map((token) => token.tokenId));
      if ((body.owned ?? []).length === 0) {
        setStatus("No Chog Genesis NFTs for this wallet passed ownerOf.");
      }
    } catch {
      setStatus("Discovery could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function enroll() {
    if (!address || selected.length === 0) {
      setStatus("Select at least one verified token.");
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
        body: JSON.stringify({ address, tokenIds: selected }),
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
      const unchanged = confirmed.unchanged?.length ?? 0;
      setStatus(
        enrolled.length > 0
          ? `Enrolled token ${enrolled.join(", ")} in chogOS.`
          : `${unchanged} token${unchanged === 1 ? "" : "s"} already enrolled for this owner.`,
      );
    } catch {
      setStatus("The wallet did not sign, or the server could not finish enrollment.");
    } finally {
      setBusy(false);
    }
  }

  const onChain = walletChain === chainId;

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
      ) : null}
      {!persistenceReady ? (
        <p className="text-sm leading-6 text-warning">
          The database is not configured, so enrollment cannot be stored. Discovery can still check ownerOf.
        </p>
      ) : null}
      {address ? (
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void discover(null)}
            className="rounded-full border border-line px-4 py-2 text-sm"
          >
            Discover owned Chogs
          </button>
          <button
            type="button"
            disabled={busy || manual.trim().length === 0}
            onClick={() => void discover(manual.split(/[\s,]+/).filter(Boolean))}
            className="rounded-full border border-line px-4 py-2 text-sm"
          >
            Check token ids
          </button>
        </div>
      ) : null}
      <label className="block text-sm text-muted">
        Manual token ids
        <input
          value={manual}
          onChange={(event) => setManual(event.target.value)}
          placeholder="7, 52, 86"
          className="mt-2 w-full rounded-xl border border-line bg-background px-3 py-2 text-foreground"
        />
      </label>
      {owned.length > 0 ? (
        <fieldset>
          <legend className="text-sm text-muted">Verified by ownerOf</legend>
          <ul className="mt-3 space-y-2">
            {owned.map((token) => (
              <li key={token.tokenId}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.includes(token.tokenId)}
                    onChange={(event) => {
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, token.tokenId]
                          : current.filter((id) => id !== token.tokenId),
                      );
                    }}
                  />
                  Chog #{token.tokenId}
                </label>
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={busy || selected.length === 0}
            onClick={() => void enroll()}
            className="mt-4 rounded-full bg-accent px-4 py-2 text-sm font-medium text-[#062117] disabled:opacity-60"
          >
            Sign and enroll
          </button>
        </fieldset>
      ) : null}
      {rejected.length > 0 ? (
        <ul className="text-sm leading-6 text-warning">
          {rejected.map((token) => (
            <li key={token.tokenId}>
              Token {token.tokenId}: {token.reason}
            </li>
          ))}
        </ul>
      ) : null}
      {status ? <p className="text-sm leading-6 text-muted">{status}</p> : null}
    </div>
  );
}
