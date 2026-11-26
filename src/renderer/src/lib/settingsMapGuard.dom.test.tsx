// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@renderer/lib/sounds", async (original) => ({ ...(await original<typeof import("@renderer/lib/sounds")>()), playCue: () => {} }));

import { PageRow, PageSection } from "../components/page";
import { SETTINGS_MAP, hasSetting, settingEntry, type SettingPage } from "./settings/map";
import { SettingRow, SettingSection } from "../surfaces/settings/parts/SettingRow";
import { GUARDED_PAGES, SettingsPagePreview } from "../surfaces/settings/SettingsPages.preview";

afterEach(cleanup);

/**
 * What a drawn page says against the map (docs/agents/settings.md "The map"). Every row is a `SettingRow` on its own
 * page (or one that only shows another page's setting), or a row of a section the map lists as a list; the strays
 * are rows the map does not know.
 */
export function rowsOffMap(root: ParentNode, page: SettingPage): string[] {
  const strays: string[] = [];
  for (const row of root.querySelectorAll<HTMLElement>("[data-slot=page-row]")) {
    const id = row.getAttribute("data-setting");
    const words = row.querySelector("[data-slot=item-title]")?.textContent ?? row.textContent ?? "";
    if (id) {
      if (!hasSetting(id)) strays.push(`${id}: not in the map`);
      else if (settingEntry(id).page !== page && !row.hasAttribute("data-shown")) strays.push(`${id}: the map puts it on ${settingEntry(id).page}, drawn on ${page}`);
      continue;
    }
    const list = row.closest<HTMLElement>("section[data-setting]")?.getAttribute("data-setting");
    if (!list || !hasSetting(list) || settingEntry(list).kind !== "list" || settingEntry(list).page !== page) strays.push(`“${words}”: a row with no place in the map`);
  }
  return strays;
}

/** The map ids a drawn page holds: its rows' and its list sections'. */
export const drawnIds = (root: ParentNode): Set<string> => new Set([...root.querySelectorAll<HTMLElement>("[data-setting]")].map((element) => element.getAttribute("data-setting")!));

describe("the guard itself", () => {
  it("passes a page whose rows are the map's, a row shown from another page, and a list's own rows", () => {
    const { container } = render(
      <>
        <PageSection>
          <SettingRow id="here.atOnce" />
          <SettingRow id="computer.screen" shown />
        </PageSection>
        <SettingSection of="here.apps">
          <PageRow title="Claude Code" />
        </SettingSection>
      </>,
    );
    expect(rowsOffMap(container, "here")).toEqual([]);
    expect([...drawnIds(container)].sort()).toEqual(["computer.screen", "here.apps", "here.atOnce"]);
  });

  it("refuses a row the map lacks, a row drawn on a page the map does not put it on, and a list row outside a list", () => {
    const { container } = render(
      <PageSection title="Loose">
        <PageRow title="Stuck after" />
        <SettingRow id="sharing.port" />
      </PageSection>,
    );
    expect(rowsOffMap(container, "here")).toEqual(["“Stuck after”: a row with no place in the map", "sharing.port: the map puts it on sharing, drawn on here"]);
  });
});

/** A page's fixtures as its computer answers them, settled. */
async function draw(preview: string): Promise<HTMLElement> {
  const { container } = render(<SettingsPagePreview page={preview} host="answers" />);
  for (let i = 0; i < 6; i++) await act(async () => void (await new Promise((done) => setTimeout(done, 0))));
  return container;
}

describe.each(Object.entries(GUARDED_PAGES))("%s, drawn", (page, guarded) => {
  it("draws no row the map lacks", async () => {
    for (const preview of guarded.previews) expect(rowsOffMap(await draw(preview), page as SettingPage), preview).toEqual([]);
    cleanup();
  });

  it("draws every row the map lists for it", async () => {
    const drawn = new Set<string>();
    for (const preview of guarded.previews) {
      for (const id of drawnIds(await draw(preview))) drawn.add(id);
      cleanup();
    }
    const missing = SETTINGS_MAP.filter((entry) => entry.page === page && !drawn.has(entry.id) && !guarded.elsewhere?.includes(entry.id)).map((entry) => entry.id);
    expect(missing).toEqual([]);
  });
});
