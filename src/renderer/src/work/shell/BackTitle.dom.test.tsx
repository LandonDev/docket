// @vitest-environment jsdom
/** The way back on People's person page and a meeting's page: one shape, where it goes never cut. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackTitle } from "./BackTitle";

afterEach(cleanup);

describe("BackTitle", () => {
  it("keeps where it goes whole and cuts only the name after it, muted", () => {
    const back = vi.fn();
    const { container } = render(<BackTitle back="People" name="Maya Chen" onBack={back} />);
    const [, to, name] = [...container.firstElementChild!.children] as HTMLElement[];
    expect(to!.textContent).toBe("People");
    expect(to!.className).toContain("shrink-0");
    expect(to!.className).not.toContain("truncate");
    expect(name!.textContent).toBe("Maya Chen");
    expect(name!.className).toContain("min-w-0 truncate");
    // Council round 1 (R1-B28): under 26rem of header the name goes whole rather than stand as a stub.
    expect(name!.className).toContain("@max-[26rem]/viewhead:hidden");
    fireEvent.click(screen.getByRole("button", { name: "Back to People" }));
    expect(back).toHaveBeenCalledOnce();
  });

  it("names the arrow for where it goes, and draws no name it was not given", () => {
    const { container } = render(<BackTitle back="Agenda" name={undefined} onBack={() => {}} />);
    expect(screen.getByRole("button", { name: "Back to Agenda" })).toBeTruthy();
    expect(container.firstElementChild!.children).toHaveLength(2);
  });
});
