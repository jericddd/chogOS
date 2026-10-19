import { getChain, type SupportedChainId } from "@/lib/blockchain/chains";

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^[0-9]+$/;

export function isChainSupported(chainId: number): chainId is SupportedChainId {
  return chainId === 143 || chainId === 10143;
}

/** HTTPS origin from the configured explorer. Never a caller-supplied host. */
export function explorerOrigin(chainId: number): string | null {
  if (!isChainSupported(chainId)) {
    return null;
  }
  const raw = getChain(chainId).blockExplorers?.default.url;
  if (!raw) {
    return null;
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function explorerUrl(chainId: number, path: string): string | null {
  const origin = explorerOrigin(chainId);
  if (!origin) {
    return null;
  }
  const url = new URL(path.replace(/^\/+/, ""), `${origin}/`);
  if (url.origin !== origin) {
    return null;
  }
  return url.toString();
}

export function explorerTxUrl(chainId: number | null | undefined, txHash: string | null | undefined): string | null {
  if (chainId == null || !txHash || !TX_HASH.test(txHash.trim())) {
    return null;
  }
  return explorerUrl(chainId, `tx/${txHash.trim().toLowerCase()}`);
}

export function explorerAddressUrl(chainId: number | null | undefined, address: string | null | undefined): string | null {
  if (chainId == null || !address || !ADDRESS.test(address.trim())) {
    return null;
  }
  return explorerUrl(chainId, `address/${address.trim().toLowerCase()}`);
}

export function explorerBlockUrl(chainId: number | null | undefined, blockNumber: string | number | null | undefined): string | null {
  if (chainId == null || blockNumber == null) {
    return null;
  }
  const text = String(blockNumber).trim();
  if (!DECIMAL.test(text) || text.length > 20) {
    return null;
  }
  return explorerUrl(chainId, `block/${text}`);
}

/** Monadscan NFT item page: /nft/<contract>/<tokenId>. */
export function explorerNftUrl(
  chainId: number | null | undefined,
  contract: string | null | undefined,
  tokenId: string | number | null | undefined,
): string | null {
  if (chainId == null || !contract || tokenId == null || !ADDRESS.test(contract.trim())) {
    return null;
  }
  const id = String(tokenId).trim();
  if (!DECIMAL.test(id) || id.length > 78) {
    return null;
  }
  return explorerUrl(chainId, `nft/${contract.trim().toLowerCase()}/${id}`);
}
