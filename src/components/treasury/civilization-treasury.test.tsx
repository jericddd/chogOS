// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CivilizationTreasuryPanel } from "@/components/treasury/civilization-treasury";
import { addresses } from "@/lib/blockchain/addresses";
import { presentCivilizationTreasury } from "@/lib/wallets/present";

describe("civilization treasury panel", () => {
  it("shows an unconfigured treasury and keeps the ChogTreasury address separate", () => {
    const view = presentCivilizationTreasury({
      chainId: 143,
      chogTreasury: addresses.chogTreasury,
      persistence: "migration_pending",
      treasury: null,
      native: { state: "unconfigured" },
      chog: { state: "unconfigured" },
      funding: [],
    });
    render(<CivilizationTreasuryPanel view={view} />);
    expect(screen.getByRole("heading", { name: "Civilization Treasury" })).toBeTruthy();
    expect(screen.getAllByText("Treasury not configured").length).toBeGreaterThan(0);
    expect(screen.getByText(addresses.chogTreasury)).toBeTruthy();
    expect(screen.getByText(/different wallet/i)).toBeTruthy();
    expect(screen.queryByText(/^0$/)).toBeNull();
  });
});
