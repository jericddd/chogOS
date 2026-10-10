"use client";

import { useEffect, useState } from "react";
import { FallbackMark } from "@/components/citizens/fallback-mark";

type Trait = { traitType: string; value: string };

type MetadataResponse = {
  status: "fetched" | "unavailable";
  name?: string | null;
  imageUrl?: string | null;
  attributes?: Trait[];
};

const cache = new Map<string, MetadataResponse>();
const inflight = new Set<string>();
const listeners = new Map<string, Set<(value: MetadataResponse) => void>>();
const pending: Array<() => Promise<void>> = [];
let active = 0;

function pump(): void {
  while (active < 4 && pending.length > 0) {
    const task = pending.shift();
    if (!task) {
      return;
    }
    active += 1;
    void task().finally(() => {
      active -= 1;
      pump();
    });
  }
}

function publish(tokenId: string, value: MetadataResponse): void {
  cache.set(tokenId, value);
  listeners.get(tokenId)?.forEach((listener) => listener(value));
}

function ensure(tokenId: string): void {
  if (cache.has(tokenId) || inflight.has(tokenId)) {
    return;
  }
  inflight.add(tokenId);
  pending.push(async () => {
    try {
      const response = await fetch(`/api/nft-metadata/${tokenId}`);
      const body = (await response.json()) as MetadataResponse;
      publish(tokenId, body.status === "fetched" ? body : { status: "unavailable" });
    } catch {
      publish(tokenId, { status: "unavailable" });
    } finally {
      inflight.delete(tokenId);
    }
  });
  pump();
}

export function useTokenMetadata(tokenId: string): MetadataResponse | null {
  const [metadata, setMetadata] = useState<{ tokenId: string; value: MetadataResponse } | null>(null);

  useEffect(() => {
    const group = listeners.get(tokenId) ?? new Set<(value: MetadataResponse) => void>();
    const listener = (value: MetadataResponse) => setMetadata({ tokenId, value });
    group.add(listener);
    listeners.set(tokenId, group);
    ensure(tokenId);
    return () => {
      group.delete(listener);
    };
  }, [tokenId]);

  return cache.get(tokenId) ?? (metadata?.tokenId === tokenId ? metadata.value : null);
}

export function MetadataName({ tokenId, fallback }: { tokenId: string; fallback: string }) {
  const metadata = useTokenMetadata(tokenId);
  return <>{metadata?.status === "fetched" && metadata.name ? metadata.name : fallback}</>;
}

export function MetadataFacts({ tokenId }: { tokenId: string }) {
  const metadata = useTokenMetadata(tokenId);
  const attributes = metadata?.status === "fetched" ? metadata.attributes ?? [] : [];
  if (attributes.length === 0) {
    return (
      <p className="text-sm leading-6 text-muted">
        Traits appear when the token metadata can be read. A missing image stays on the local mark.
      </p>
    );
  }
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {attributes.map((attribute) => (
        <li key={`${attribute.traitType}-${attribute.value}`} className="rounded-xl border border-line px-3 py-2 text-sm">
          <span className="text-muted">{attribute.traitType}</span>
          <span className="mt-1 block">{attribute.value}</span>
        </li>
      ))}
    </ul>
  );
}

export function CitizenPortrait({ tokenId, name }: { tokenId: string; name?: string | null }) {
  const metadata = useTokenMetadata(tokenId);
  const [broken, setBroken] = useState(false);
  const imageUrl = metadata?.status === "fetched" ? metadata.imageUrl : null;
  const label = (metadata?.status === "fetched" && metadata.name) || name || `Chog Genesis ${tokenId}`;

  if (!imageUrl || broken) {
    return <FallbackMark tokenId={tokenId} />;
  }

  return (
    // The gateway host is configured at runtime, so next/image remote patterns are not a stable allowlist.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={imageUrl}
      alt={label}
      className="h-full w-full object-cover"
      onError={() => setBroken(true)}
    />
  );
}
