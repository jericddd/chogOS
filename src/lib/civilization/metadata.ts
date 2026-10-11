export type PresentedMetadata =
  | {
      status: "fetched";
      name: string;
      description: string | null;
      imagePath: string | null;
      attributes: Array<{ traitType: string; value: string }>;
    }
  | { status: "unavailable" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

/** Keep the IPFS path. The gateway is applied at display time. */
export function ipfsPath(uri: string): string | null {
  if (!uri.startsWith("ipfs://")) {
    return null;
  }
  const path = uri.slice("ipfs://".length).replace(/^ipfs\//, "");
  if (!path || path.includes("..") || path.startsWith("/")) {
    return null;
  }
  return path;
}

export function gatewayUrl(path: string, gateway: string): string {
  return `${gateway.replace(/\/$/, "")}/${path}`;
}

export function presentMetadata(raw: unknown): PresentedMetadata {
  if (!isRecord(raw) || typeof raw.name !== "string" || raw.name.trim().length === 0) {
    return { status: "unavailable" };
  }

  const imagePath = typeof raw.image === "string" ? ipfsPath(raw.image) : null;
  const attributes = Array.isArray(raw.attributes)
    ? raw.attributes.flatMap((attribute) => {
        if (!isRecord(attribute) || typeof attribute.trait_type !== "string" || typeof attribute.value !== "string") {
          return [];
        }
        return [{ traitType: attribute.trait_type, value: attribute.value }];
      })
    : [];

  return {
    status: "fetched",
    name: raw.name.trim(),
    description: typeof raw.description === "string" ? raw.description : null,
    imagePath,
    attributes,
  };
}

export function metadataFetchUrl(tokenUri: string, gateway: string): string | null {
  const path = ipfsPath(tokenUri);
  if (!path) {
    return null;
  }
  let gatewayHost: string;
  try {
    gatewayHost = new URL(gateway).host;
  } catch {
    return null;
  }
  const url = new URL(gatewayUrl(path, gateway));
  if (url.host !== gatewayHost || url.protocol !== "https:") {
    return null;
  }
  return url.toString();
}
