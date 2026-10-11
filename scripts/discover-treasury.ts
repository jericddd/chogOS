import { createGenesisReaderForConfig } from "../src/lib/blockchain/genesis-reader";
import { compareTokenIds, selectVerifiedHoldings } from "../src/lib/blockchain/holdings";
import { describeCountDiscrepancy } from "../src/lib/civilization/plan";
import { readAppConfig } from "../src/lib/config/env";

async function main(): Promise<void> {
  const config = readAppConfig();
  const reader = createGenesisReaderForConfig(config);
  const inventory = await reader.readOwnedInventory(config.chogTreasuryAddress);

  if (!inventory.tokensOfOwner) {
    console.error(inventory.tokensOfOwnerError ?? "tokensOfOwner did not return.");
    process.exit(1);
  }

  const observations = await reader.readOwners(inventory.tokensOfOwner);
  const selected = selectVerifiedHoldings(observations, config.chogTreasuryAddress);
  const discrepancy = describeCountDiscrepancy(
    selected.verified.length,
    config.expectedFoundingCount,
    inventory.balanceOf,
  );

  console.log(
    JSON.stringify(
      {
        chainId: config.chainId,
        blockNumber: inventory.blockNumber,
        treasury: config.chogTreasuryAddress,
        nft: config.chogNftAddress,
        balanceOf: inventory.balanceOf,
        balanceError: inventory.balanceError,
        verifiedCount: selected.verified.length,
        expectedFoundingCount: config.expectedFoundingCount,
        discrepancy,
        rejected: selected.rejected,
        tokenIds: selected.verified.map((holding) => holding.tokenId).sort(compareTokenIds),
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
