// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { committed, failedLoad, HIDDEN_UNLOAD_MS, liveAskKey, liveAskUrl, LiveLayer, MOST_LOADED, navigated, stopped, type LiveState } from "./layer";

const FILE = "https://purdue0-my.sharepoint.com/personal/x/Documents/Plan.docx?web=1";
const FORM_ID = "DQSIkWdsW0yxEjajBLZtrQAAAAAAAAAAAAN__abc123ZUQ1JUVEhPQ1A4QS4u";
const BUILDER = `https://forms.cloud.microsoft/Pages/DesignPageV2.aspx?subpage=design&id=${FORM_ID}`;
const FORM = { forms: { tenant: "purdue0", formId: FORM_ID, page: "design" as const } };
const START: LiveState = { stage: "start", site: null, failed: null };

describe("how far the file has come", () => {
  it("goes from the file's page to Office's editor to ready", () => {
    let s = navigated(START, FILE);
    expect(s.stage).toBe("file");
    s = committed(s, "https://word-edit.officeapps.live.com/we/wordeditorframe.aspx", false);
    expect(s.stage).toBe("editor");
    expect(stopped(s).stage).toBe("ready");
  });

  it("names a sign-in's site, and stops the bar there", () => {
    const s = navigated(START, "https://login.microsoftonline.com/common/oauth2");
    expect(s.site).toBe("login.microsoftonline.com");
    expect(stopped(s).stage).toBe("ready");
    expect(navigated(navigated(s, "https://idp.purdue.edu/login"), FILE).site).toBeNull();
  });

  it("does not finish on the file's page alone, and never goes back", () => {
    const s = navigated(START, FILE);
    expect(stopped(s).stage).toBe("file");
    expect(navigated({ ...s, stage: "editor" }, FILE).stage).toBe("editor");
  });

  it("is ready on a form's own page when it stops loading: Forms has no editor frame", () => {
    for (const top of [BUILDER, "https://forms.office.com/Pages/DesignPageV2.aspx?id=x", "https://forms.microsoft.com/x"]) {
      let s = navigated(START, top);
      expect(s).toMatchObject({ stage: "file", site: null });
      s = committed(s, top, true);
      expect(s.stage).toBe("file");
      expect(stopped(s, top).stage).toBe("ready");
    }
    // A file's page on top still waits for Office's editor.
    expect(stopped(navigated(START, FILE), FILE).stage).toBe("file");
  });

  it("fails on a top frame's failure only, never an abort", () => {
    expect(failedLoad(START, -105, "ERR_NAME_NOT_RESOLVED", true).failed).toBe("It did not load (ERR_NAME_NOT_RESOLVED).");
    expect(failedLoad(START, -3, "ERR_ABORTED", true).failed).toBeNull();
    expect(failedLoad(START, -105, "x", false).failed).toBeNull();
  });
});

function bridge() {
  let key: ((init: KeyboardEventInit) => void) | null = null;
  return {
    ticket: vi.fn(async (ask: string | typeof FORM) => ({ ok: true as const, src: typeof ask === "string" ? ask : BUILDER, partition: "persist:office-live-purdue0" })),
    fullWindow: vi.fn(async () => undefined),
    typed: vi.fn(async () => 3),
    unload: vi.fn(async (): Promise<"unloaded" | "holding" | "gone"> => "unloaded"),
    onKey: vi.fn((cb: (init: KeyboardEventInit) => void) => ((key = cb), () => undefined)),
    press: (init: KeyboardEventInit) => key?.(init),
  };
}
const RECT = { x: 10, y: 60, width: 800, height: 600 };
const flush = () => new Promise((r) => setTimeout(r, 0));
const guests = () => [...document.querySelectorAll("webview[data-office-live]")] as HTMLElement[];

describe("the layer", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("asks a ticket, then attaches the guest with its partition, laid over the tab", async () => {
    const b = bridge();
    const layer = new LiveLayer(() => b as never);
    layer.show("a", FILE, RECT, false);
    await flush();
    expect(b.ticket).toHaveBeenCalledWith(FILE);
    const [el] = guests();
    expect(el.getAttribute("partition")).toBe("persist:office-live-purdue0");
    expect(el.getAttribute("src")).toBe(FILE);
    expect(el.style).toMatchObject({ position: "fixed", left: "10px", top: "60px", width: "800px", height: "600px", visibility: "visible", zIndex: "1" });
  });

  it("asks a form's ticket by its tenant, id and page, attaches at the address main made, and is ready when it stops", async () => {
    const b = bridge();
    const layer = new LiveLayer(() => b as never);
    layer.show("f", { forms: { ...FORM.forms } }, RECT, false);
    await flush();
    expect(b.ticket).toHaveBeenCalledWith(FORM);
    const [el] = guests();
    expect(el.getAttribute("src")).toBe(BUILDER);
    // The same ask made afresh is the same guest; another page is another.
    layer.show("f", { forms: { ...FORM.forms } }, RECT, false);
    expect(guests()).toEqual([el]);
    const fire = (name: string, fields: Record<string, unknown> = {}) => el.dispatchEvent(Object.assign(new Event(name), fields));
    fire("did-navigate", { url: BUILDER });
    fire("load-commit", { url: BUILDER, isMainFrame: true });
    expect(layer.state("f").stage).toBe("file");
    fire("did-stop-loading");
    expect(layer.state("f").stage).toBe("ready");
    layer.show("f", { forms: { ...FORM.forms, page: "respond" } }, RECT, false);
    await flush();
    expect(guests()).not.toContain(el);
  });

  it("names a form's ask by its parts, and opens its address where there is no guest tag", () => {
    expect(liveAskKey(FILE)).toBe(FILE);
    expect(liveAskKey(FORM)).toBe(`forms:purdue0:${FORM_ID}:design`);
    expect(liveAskUrl(FORM)).toBe(BUILDER);
    expect(liveAskUrl({ forms: { ...FORM.forms, page: "respond" } })).toBe(`https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=${FORM_ID}`);
  });

  it("refused a ticket, says why and draws nothing", async () => {
    const b = bridge();
    b.ticket.mockResolvedValueOnce({ ok: false, error: "Only a file in OneDrive, SharePoint or Teams opens live." } as never);
    const layer = new LiveLayer(() => b as never);
    layer.show("a", FILE, RECT, false);
    await flush();
    expect(guests()).toHaveLength(0);
    expect(layer.state("a").failed).toMatch(/Only a file/);
  });

  it("hides a guest off screen without unloading it, and shows it again where its tab is", async () => {
    const layer = new LiveLayer(() => bridge() as never);
    layer.show("a", FILE, RECT, false);
    await flush();
    layer.hide("a");
    const [el] = guests();
    expect(el.style.visibility).toBe("hidden");
    expect(el.style.pointerEvents).toBe("none");
    layer.show("a", FILE, { ...RECT, x: 200 }, false);
    expect(guests()).toEqual([el]);
    expect(el.style).toMatchObject({ visibility: "visible", left: "200px" });
  });

  it("lies on the dialog layer in Full Window, and tells main so Escape is TempCode's", async () => {
    const b = bridge();
    const layer = new LiveLayer(() => b as never);
    layer.show("a", FILE, RECT, true);
    await flush();
    const [el] = guests();
    expect(el.style.zIndex).toBe("var(--layer-dialog)");
  });

  it("lets a guest hidden HIDDEN_UNLOAD_MS with no show go, and a show before then keeps it", async () => {
    vi.useFakeTimers();
    try {
      const b = bridge();
      const layer = new LiveLayer(() => b as never);
      layer.show("a", FILE, RECT, false);
      layer.show("k", `${FILE}&k`, RECT, false);
      await vi.advanceTimersByTimeAsync(0);
      layer.hide("a");
      layer.hide("k");
      await vi.advanceTimersByTimeAsync(HIDDEN_UNLOAD_MS - 1000);
      layer.show("k", `${FILE}&k`, RECT, false);
      await vi.advanceTimersByTimeAsync(2000);
      // The one hidden past the time went (through Word's unload where it has a guest id); the one shown again stays.
      expect(guests().map((g) => g.getAttribute("data-office-live"))).toEqual(["k"]);
      layer.hide("k");
      await vi.advanceTimersByTimeAsync(HIDDEN_UNLOAD_MS + 1);
      expect(guests()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it(`keeps ${MOST_LOADED} loaded, and lets the one shown least recently go`, async () => {
    const layer = new LiveLayer(() => bridge() as never);
    for (const key of ["a", "b", "c", "d"]) {
      layer.show(key, `${FILE}&${key}`, RECT, false);
      await flush();
      layer.hide(key);
    }
    layer.show("e", `${FILE}&e`, RECT, false);
    await flush();
    expect(guests().map((g) => g.getAttribute("data-office-live"))).toEqual(["c", "d", "e"]);
  });

  it("keeps a guest past three that Word still holds while saving", async () => {
    const b = bridge();
    const layer = new LiveLayer(() => b as never);
    for (const key of ["a", "b", "c"]) {
      layer.show(key, `${FILE}&${key}`, RECT, false);
      await flush();
      const el = guests().find((g) => g.getAttribute("data-office-live") === key)! as unknown as { getWebContentsId(): number } & HTMLElement;
      el.getWebContentsId = () => key.charCodeAt(0);
      el.dispatchEvent(new Event("dom-ready"));
      layer.hide(key);
    }
    b.unload.mockResolvedValue("holding");
    layer.show("d", `${FILE}&d`, RECT, false);
    await flush();
    expect(b.unload).toHaveBeenCalledWith("a".charCodeAt(0), false);
    expect(guests().map((g) => g.getAttribute("data-office-live"))).toEqual(["a", "b", "c", "d"]);
  });

  it("leaves at once when Word lets go, waits while it holds, then asks", async () => {
    const b = bridge();
    const layer = new LiveLayer(() => b as never);
    layer.show("a", FILE, RECT, false);
    await flush();
    const [el] = guests();
    (el as unknown as { getWebContentsId(): number }).getWebContentsId = () => 42;
    el.dispatchEvent(new Event("dom-ready"));
    b.unload.mockResolvedValue("holding");
    const ask = vi.fn(async () => false);
    expect(await layer.leave("a", ask, 0)).toBe(false);
    expect(ask).toHaveBeenCalled();
    expect(guests()).toHaveLength(1);
    ask.mockResolvedValue(true);
    expect(await layer.leave("a", ask, 0)).toBe(true);
    expect(b.unload).toHaveBeenLastCalledWith(42, true);
    expect(guests()).toHaveLength(0);
  });

  it("reads his typing from main by the guest's id", async () => {
    const b = bridge();
    const layer = new LiveLayer(() => b as never);
    layer.show("a", FILE, RECT, false);
    await flush();
    expect(await layer.typed("a")).toBe(0);
    const [el] = guests();
    (el as unknown as { getWebContentsId(): number }).getWebContentsId = () => 7;
    el.dispatchEvent(new Event("dom-ready"));
    expect(await layer.typed("a")).toBe(3);
    expect(b.typed).toHaveBeenCalledWith(7);
  });

  it("plays a forwarded key on the tab's own body, inside the Files place", async () => {
    const b = bridge();
    const layer = new LiveLayer(() => b as never);
    const body = document.createElement("div");
    document.body.appendChild(body);
    layer.show("a", FILE, RECT, false, body);
    await flush();
    const [el] = guests();
    el.tabIndex = 0;
    el.focus();
    const heard: KeyboardEvent[] = [];
    body.addEventListener("keydown", (e) => heard.push(e));
    b.press({ key: "w", code: "KeyW", metaKey: true });
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ key: "w", metaKey: true, bubbles: true });
  });

  it("is not there in a browser", () => {
    expect(new LiveLayer(() => undefined).can()).toBe(false);
  });
});
