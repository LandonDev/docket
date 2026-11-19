// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { OfficeAddinKey } from "@shared/contract-work-office";
import type { Link } from "../../lib/connection/link";
import { AddinRow, addinLine } from "./AddinRow";

afterEach(cleanup);

const KEY: OfficeAddinKey = { id: "k1", name: "Excel on the web", app: "excel", createdAt: 1, seenAt: 1, live: true };

/** A link that answers from a list the test changes, and records every call. */
function fakeLink(keys: OfficeAddinKey[]) {
  const calls: { method: string; params: unknown }[] = [];
  const link = {
    connected: true,
    onOpen: () => () => {},
    request: (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "work.office.addin.list") return Promise.resolve({ keys: [...keys] });
      if (method === "work.office.addin.pair") return Promise.resolve({ code: "K7M2Q9XP", expiresAt: Date.now() + 5 * 60_000 });
      if (method === "work.office.addin.remove") {
        keys.splice(keys.findIndex((k) => k.id === (params as { id: string }).id), 1);
        return Promise.resolve({ removed: true });
      }
      return Promise.reject(new Error(`unexpected ${method}`));
    },
  } as unknown as Link;
  return { link, calls };
}

describe("addinLine", () => {
  it("says whether it is connected, else when it last was", () => {
    expect(addinLine({ live: true, seenAt: 1 })).toBe("Connected");
    expect(addinLine({ live: false, seenAt: null })).toBe("Not connected yet");
    expect(addinLine({ live: false, seenAt: Date.now() - 3 * 3600_000 })).toBe("Last connected 3h ago");
  });
});

describe("AddinRow", () => {
  it("says it is not paired, and Pair… shows the code with its time left", async () => {
    const { link, calls } = fakeLink([]);
    await act(async () => void render(<AddinRow link={link} title="Office add-in" />));
    expect(screen.getByText("Not paired")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Pair…" })));
    expect(await screen.findByText("K7M2Q9XP")).toBeTruthy();
    expect(screen.getByText(/^[45]:\d\d$/)).toBeTruthy();
    expect(calls.map((c) => c.method)).toEqual(["work.office.addin.list", "work.office.addin.pair"]);
  });

  it("lists each paired add-in with Remove, which forgets it", async () => {
    const { link, calls } = fakeLink([KEY]);
    await act(async () => void render(<AddinRow link={link} title="Office add-in" />));
    expect(screen.queryByText("Not paired")).toBeNull();
    expect(screen.getByText("Excel on the web")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove" })));
    expect(calls.find((c) => c.method === "work.office.addin.remove")?.params).toEqual({ id: "k1" });
    expect(await screen.findByText("Not paired")).toBeTruthy();
  });
});
