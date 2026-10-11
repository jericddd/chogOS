// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CitizenPortrait } from "@/components/citizens/portrait";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("citizen portrait", () => {
  it("keeps local artwork when metadata has no image", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({ status: "unavailable" }),
      }),
    );
    render(<CitizenPortrait tokenId="701" />);
    expect(screen.getByTestId("citizen-fallback")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole("img", { name: /CHOG/ })).toBeNull();
    });
  });

  it("replaces a broken remote image with local artwork", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({
          status: "fetched",
          name: "CHOG #702",
          imageUrl: "https://gateway.pinata.cloud/ipfs/example",
        }),
      }),
    );
    render(<CitizenPortrait tokenId="702" />);
    const image = await screen.findByRole("img", { name: "CHOG #702" });
    fireEvent.error(image);
    expect(screen.getByTestId("citizen-fallback")).toBeTruthy();
  });
});
