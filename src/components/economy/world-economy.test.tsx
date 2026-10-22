// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorldEconomyPanel } from "@/components/economy/world-economy";

vi.mock("next/link", () => ({
  default: (props: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={props.href} className={props.className}>
      {props.children}
    </a>
  ),
}));

describe("world economy panel", () => {
  it("shows simulated storehouse counts and the town need", () => {
    render(
      <WorldEconomyPanel
        stock={{ food: 80, wood: 60, stone: 40, tools: 0 }}
        townNeeds={[]}
        townNeedsReady
        unavailable={null}
      />,
    );
    expect(screen.getByRole("heading", { name: "World economy" })).toBeTruthy();
    expect(screen.getByText("Food").parentElement?.textContent).toContain("80");
    expect(screen.getByText("Tools").parentElement?.textContent).toContain("0");
    expect(screen.getByText("No critical shortage is currently detected")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the world" }).getAttribute("href")).toBe("/");
    expect(screen.queryByRole("heading", { name: "Civilization Treasury" })).toBeNull();
  });

  it("shows a missing world read without inventing stock", () => {
    render(
      <WorldEconomyPanel
        stock={null}
        townNeeds={[]}
        townNeedsReady={false}
        unavailable="The world could not be read."
      />,
    );
    expect(screen.getByText("The world could not be read.")).toBeTruthy();
    expect(screen.getByText("The storehouse has no stock in this reading.")).toBeTruthy();
  });
});
