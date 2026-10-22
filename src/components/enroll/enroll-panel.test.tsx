// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnrollPanel } from "@/components/enroll/enroll-panel";

const replace = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
}));

vi.mock("@/components/citizens/portrait", () => ({
  CitizenPortrait: ({ tokenId }: { tokenId: string }) => <div>portrait {tokenId}</div>,
  MetadataName: ({ fallback }: { fallback: string }) => <span>{fallback}</span>,
}));

const wallet = "0x3D38FeE3E1a4c43d8fcF715aA6C9ff025074E7E0";

afterEach(() => {
  cleanup();
  replace.mockClear();
  refresh.mockClear();
  vi.unstubAllGlobals();
});

describe("enroll panel", () => {
  it("lists wallet NFTs and lets one unjoined Chog be chosen", async () => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_accounts") {
        return [];
      }
      if (method === "eth_requestAccounts") {
        return [wallet];
      }
      if (method === "eth_chainId") {
        return "0x8f";
      }
      return null;
    });
    vi.stubGlobal("ethereum", { request });
    Object.assign(window, { ethereum: { request } });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({
          ok: true,
          owned: [
            {
              tokenId: "20",
              owner: wallet,
              heldByTreasury: false,
              enrolledAt: "2026-10-01T00:00:00.000Z",
              enrollmentStatus: "active",
              origin: "community",
              citizenId: "citizen-20",
            },
            {
              tokenId: "100",
              owner: wallet,
              heldByTreasury: false,
              enrolledAt: null,
              enrollmentStatus: null,
              origin: null,
              citizenId: null,
            },
          ],
        }),
      }),
    );

    render(<EnrollPanel chainId={143} persistenceReady focusedTokenId={null} />);
    expect(screen.queryByText(/manual token/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/7, 52/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));

    await waitFor(() => {
      expect(screen.getAllByTestId("owned-chog")).toHaveLength(2);
    });
    expect(screen.getByText("Joined 2026-10-01 00:00:00 UTC")).toBeTruthy();
    expect(screen.getByText("Not joined yet.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Token 100/ }));
    expect(screen.getByTestId("join-chog").textContent).toBe("Join Chog #100");

    fireEvent.click(screen.getByRole("button", { name: /Token 20/ }));
    expect(replace).toHaveBeenCalledWith("/enroll?token=20", { scroll: false });
    expect(screen.queryByTestId("join-chog")).toBeNull();
  });

  it("opens the profile after the chosen Chog joins", async () => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_accounts") {
        return [wallet];
      }
      if (method === "eth_chainId") {
        return "0x8f";
      }
      if (method === "personal_sign") {
        return "0xsig";
      }
      return null;
    });
    vi.stubGlobal("ethereum", { request });
    Object.assign(window, { ethereum: { request } });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          owned: [
            {
              tokenId: "100",
              owner: wallet,
              heldByTreasury: false,
              enrolledAt: null,
              enrollmentStatus: null,
              origin: null,
              citizenId: null,
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ ok: true, message: "enroll 100", nonce: "abc" }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ ok: true, enrolled: ["100"], unchanged: [] }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          owned: [
            {
              tokenId: "100",
              owner: wallet,
              heldByTreasury: false,
              enrolledAt: "2026-10-23T02:00:00.000Z",
              enrollmentStatus: "active",
              origin: "community",
              citizenId: "citizen-100",
            },
          ],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<EnrollPanel chainId={143} persistenceReady focusedTokenId={null} />);
    await waitFor(() => {
      expect(screen.getByTestId("join-chog").textContent).toBe("Join Chog #100");
    });
    fireEvent.click(screen.getByTestId("join-chog"));
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/enroll?token=100", { scroll: false });
    });
    expect(refresh).toHaveBeenCalled();
    const confirm = fetchMock.mock.calls[2]?.[1] as { body?: string };
    expect(JSON.parse(confirm.body ?? "{}")).toMatchObject({ address: wallet, nonce: "abc", signature: "0xsig" });
  });
});
