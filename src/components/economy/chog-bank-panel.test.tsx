// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChogBankPanel } from "@/components/economy/chog-bank-panel";
import { pendingInspection, presentOwnerlessTreasury } from "@/lib/economy/treasury-public";

describe("ChogBank panel", () => {
  it("does not invent a contract link or a balance before deployment", () => {
    const view = presentOwnerlessTreasury({ inspection: pendingInspection(143), decisions: [], decisionsLoaded: true });
    render(<ChogBankPanel view={view} />);
    expect(screen.getByRole("heading", { name: "ChogBank" })).toBeTruthy();
    expect(screen.getByText("Not ready")).toBeTruthy();
    expect(screen.getAllByText("Not read").length).toBeGreaterThan(0);
    expect(screen.getByText("Not recorded")).toBeTruthy();
    expect(screen.getByText(/No contract explorer link/)).toBeTruthy();
    expect(screen.getByText(/No funding address is ready/)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByTestId("ownerless-chogbank").getAttribute("data-funding-ready")).toBe("no");
  });
});
