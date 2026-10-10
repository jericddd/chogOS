// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorldStage } from "@/components/world/world-stage";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe("world stage", () => {
  it("renders the civilization scene responsively with real counts", () => {
    const { container } = render(
      <WorldStage
        foundingCount={59}
        communityCount={0}
        treasuryCount={59}
        networkLabel="Monad Mainnet · chain 143 · block 1"
        syncLabel="Not persisted"
        aiLabel="Awaiting AI activation"
        persistenceLabel="Database not configured"
        discrepancy={null}
        countLabel="59 Chog NFTs verified in ChogTreasury."
      />,
    );

    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 960 640");
    expect(svg?.classList.contains("w-full")).toBe(true);
    const stage = container.querySelector("[data-testid='world-stage']");
    expect(stage?.className).toContain("grid-cols-1");
    expect(stage?.className).toContain("xl:grid-cols-[minmax(0,1fr)_20rem]");
    expect(screen.getByRole("link", { name: "Citizens" }).getAttribute("href")).toBe("/citizens");
    expect(screen.getByRole("link", { name: "Genesis Treasury" }).getAttribute("href")).toBe("/treasury");
    expect(screen.getByRole("link", { name: "Civilization History" }).getAttribute("href")).toBe("/activity");
    expect(screen.getByText("59 founding")).toBeTruthy();
    expect(screen.getByText("Awaiting AI activation")).toBeTruthy();
  });
});
