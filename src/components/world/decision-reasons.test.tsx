// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DecisionReasons } from "@/components/world/decision-reasons";
import type { CitizenMindView } from "@/lib/ai/mind-view";

const TX = `0x${"ab".repeat(32)}`;

function decision(overrides: Partial<CitizenMindView["decisions"][number]> = {}): CitizenMindView["decisions"][number] {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    status: "executed",
    purpose: "treasury_allocation",
    summary: null,
    rationale: "Production signing is disabled. This record is not a signature and not a payment.",
    provider: null,
    model: null,
    validationResult: null,
    intentId: null,
    outcomeEventId: null,
    confirmedTxHash: null,
    createdAt: "2026-10-24T11:51:53.000Z",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("decision reasons", () => {
  it("shows the policy sentence when no verified receipt is stored", () => {
    render(<DecisionReasons decisions={[decision()]} />);
    expect(screen.getByText(/Sending funds · executed/)).toBeTruthy();
    expect(screen.getByText(/Production signing is disabled/)).toBeTruthy();
    expect(screen.queryByText("View payout receipt")).toBeNull();
  });

  it("shows the verified receipt instead of the policy sentence", () => {
    render(
      <DecisionReasons
        decisions={[
          decision({
            rationale: "Citizen aims to meet neighbours at the square and requires funds for social engagement.",
            confirmedTxHash: TX,
          }),
        ]}
      />,
    );
    expect(screen.getByText("ChogBank payout · confirmed")).toBeTruthy();
    expect(screen.getByText(/requires funds for social engagement/)).toBeTruthy();
    expect(screen.queryByText(/Production signing is disabled/)).toBeNull();
    const link = screen.getByRole("link", { name: "View payout receipt" });
    expect(link.getAttribute("href")).toBe(`https://monadscan.com/tx/${TX}`);
  });
});
