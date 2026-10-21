// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CivilizationNav } from "@/components/shell/nav";

vi.mock("next/link", () => ({
  default: (props: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={props.href} className={props.className}>
      {props.children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

afterEach(() => {
  cleanup();
});

describe("civilization nav", () => {
  it("keeps working destinations, links Economy, and omits Businesses", () => {
    render(<CivilizationNav />);
    expect(screen.getByRole("link", { name: "World" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("link", { name: "Citizens" }).getAttribute("href")).toBe("/citizens");
    expect(screen.getByRole("link", { name: "History" }).getAttribute("href")).toBe("/activity");
    expect(screen.getByRole("link", { name: "Verify" }).getAttribute("href")).toBe("/verify");
    expect(screen.getByRole("link", { name: "Treasury" }).getAttribute("href")).toBe("/treasury");
    expect(screen.getByRole("link", { name: "Economy" }).getAttribute("href")).toBe("/economy");
    expect(screen.getByRole("link", { name: "Enroll" }).getAttribute("href")).toBe("/enroll");
    expect(screen.queryByRole("link", { name: "Businesses" })).toBeNull();
    const nav = screen.getByRole("navigation");
    expect(nav.className).toContain("flex-nowrap");
    expect(nav.className).toContain("overflow-x-auto");
    const enroll = screen.getByRole("link", { name: "Enroll" });
    expect(enroll.textContent).toBe("Enroll");
    expect(enroll.className).toContain("text-xs");
    expect(enroll.className).toContain("sm:text-sm");
  });
});
