import { gatewayUrl, metadataFetchUrl, presentMetadata } from "@/lib/civilization/metadata";

export type LoadedMetadata = {
  status: "fetched" | "unavailable";
  name: string | null;
  description: string | null;
  imagePath: string | null;
  imageUrl: string | null;
  attributes: Array<{ traitType: string; value: string }>;
};

const empty: LoadedMetadata = {
  status: "unavailable",
  name: null,
  description: null,
  imagePath: null,
  imageUrl: null,
  attributes: [],
};

export async function resolveTokenMetadata(input: {
  tokenUri: string | null;
  gateway: string;
  fetchImpl?: typeof fetch;
}): Promise<LoadedMetadata> {
  if (!input.tokenUri) {
    return empty;
  }
  const url = metadataFetchUrl(input.tokenUri, input.gateway);
  if (!url) {
    return empty;
  }

  try {
    const response = await (input.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) {
      return empty;
    }
    const presented = presentMetadata(await response.json());
    if (presented.status === "unavailable") {
      return empty;
    }
    return {
      status: "fetched",
      name: presented.name,
      description: presented.description,
      imagePath: presented.imagePath,
      imageUrl: presented.imagePath ? gatewayUrl(presented.imagePath, input.gateway) : null,
      attributes: presented.attributes,
    };
  } catch {
    return empty;
  }
}
