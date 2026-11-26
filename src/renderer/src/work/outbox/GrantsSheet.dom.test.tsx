// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GrantsSheet } from "./GrantsSheet";

/** Round 1's carry: the sheet said "No grants" whenever its list was empty, before the read landed too. */

afterEach(cleanup);
const sheet = (read: boolean) => render(<GrantsSheet open onOpenChange={() => undefined} grants={[]} read={read} nameOf={() => "Purdue"} sectorOf={() => null} />);

describe("the Grants sheet", () => {
  it("draws bones while the grants are read, never the empty line", () => {
    sheet(false);
    expect(screen.getByRole("status", { name: "Loading the grants" })).toBeTruthy();
    expect(screen.queryByText(/No grants/)).toBeNull();
  });
  it("says there are none once they are read", () => {
    sheet(true);
    expect(screen.getByText("No grants. Everything waits for your press.")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading the grants" })).toBeNull();
  });
});
