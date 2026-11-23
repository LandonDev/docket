// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CodeSettings } from "@server/shared/contract-code";
import { CodeUpdatesRow } from "./CodeUpdates";

/** Settings → Hosts → This Mac's Code updates row: Off or one admin host, no row where code cannot come, main's line as its state. */

const box = { id: "env_box", name: "The box" };
const studio = { id: "env_studio", name: "Studio" };
const settings = (over: Partial<CodeSettings> = {}): CodeSettings => ({ host: box.id, hosts: [box, studio], cannot: null, ...over });

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

const choose = async (name: string): Promise<void> => {
  fireEvent.click(await screen.findByLabelText("Take code updates from"));
  await flush();
  const option = await screen.findByRole("option", { name });
  await flush();
  fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 });
  fireEvent.pointerUp(option, { pointerType: "mouse", button: 0 });
  fireEvent.mouseUp(option, { button: 0 });
  fireEvent.click(option);
  await flush();
};

afterEach(cleanup);

describe("CodeUpdatesRow", () => {
  it("draws no row before the settings answer, on a build that cannot take code, or with no admin host", () => {
    for (const s of [null, settings({ cannot: "a dev build" }), settings({ host: null, hosts: [] })]) {
      expect(render(<CodeUpdatesRow settings={s} onSet={async () => null} />).container.innerHTML).toBe("");
      cleanup();
    }
  });

  it("shows the chosen host, or Off, with main's notice as its state line", async () => {
    render(
      <CodeUpdatesRow settings={settings()} notice="Code update 3f9c2ab needs a full release: node_modules changed." onSet={async () => null} />,
    );
    expect(screen.getByText("Code updates")).toBeTruthy();
    expect((await screen.findByLabelText("Take code updates from")).textContent).toContain("The box");
    const line = screen.getByText("Code update 3f9c2ab needs a full release: node_modules changed.");
    expect(line.closest("[class*=text-destructive]")).toBeNull();
    cleanup();
    render(<CodeUpdatesRow settings={settings({ host: null })} onSet={async () => null} />);
    expect((await screen.findByLabelText("Take code updates from")).textContent).toContain("Off");
  });

  it("sends the host chosen, null for Off, and keeps a refusal on the row", async () => {
    const set: (string | null)[] = [];
    render(<CodeUpdatesRow settings={settings()} onSet={async (host) => (set.push(host), host ? null : "refused: loopback only")} />);
    await choose("Studio");
    expect(set).toEqual(["env_studio"]);
    await choose("Off");
    expect(set).toEqual(["env_studio", null]);
    expect(await screen.findByText("refused: loopback only")).toBeTruthy();
  });
});
