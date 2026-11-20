// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const native = { openUrl: vi.fn(async () => {}), saveDownload: vi.fn(async (name: string) => `/Downloads/${name}`) };
vi.mock("../../lib/native", async (original) => ({ ...(await original<object>()), ...native }));

const { tempcodeMailKit } = await import("./kit");

afterEach(() => {
  vi.unstubAllGlobals();
  native.openUrl.mockClear();
  native.saveDownload.mockClear();
});

describe("a file from a mail", () => {
  const url = "https://lifeos.example/api/storage/3f0c9a52-6c1e-4a7b-9d55-2b8a4f1e7c10";
  const bytes = new Uint8Array([37, 80, 68, 70]);
  const served = () => vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes)));

  it("is saved under its own name, read as bytes from LifeOS's store", async () => {
    served();
    await expect(tempcodeMailKit.saveFile({ url, name: "Invoice 1042.pdf" })).resolves.toBe("saved");
    expect(native.saveDownload).toHaveBeenCalledTimes(1);
    const [name, data] = native.saveDownload.mock.calls[0] as unknown as [string, Uint8Array];
    expect(name).toBe("Invoice 1042.pdf");
    expect([...data]).toEqual([...bytes]);
  });

  it("is never handed to the browser by its address in the store, which would name it by the store's key", async () => {
    served();
    // Open, for a file no canvas shows, saves it under its own name and says so.
    await expect(tempcodeMailKit.openFile({ url, name: "attachment.pdf" })).resolves.toBe("saved");
    expect(native.openUrl).not.toHaveBeenCalled();
    expect((native.saveDownload.mock.calls[0] as unknown as [string])[0]).toBe("attachment.pdf");
  });
});

describe("a face", () => {
  const { Face } = tempcodeMailKit;
  const PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

  it("is the stored picture where there is one, drawn at once when it needs no reading", async () => {
    const { render, cleanup } = await import("@testing-library/react");
    const { container } = render(<Face name="Marisol Rivera" picture={PIXEL} size="row" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(PIXEL);
    expect(container.textContent).toBe("");
    cleanup();
  });

  it("falls back to initials quietly when the picture does not load", async () => {
    const { render, cleanup, fireEvent } = await import("@testing-library/react");
    const { container } = render(<Face name="Marisol Rivera" picture={PIXEL} size="row" />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("MR");
    cleanup();
  });

  it("reads a picture in LifeOS's store as bytes, once, and keeps it", async () => {
    const { render, cleanup, waitFor } = await import("@testing-library/react");
    const fetched = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetched);
    URL.createObjectURL = vi.fn(() => "blob:face-1");
    const url = "https://lifeos.example/api/storage/face-1";
    const first = render(<Face name="Tom Beck" picture={url} size="head" />);
    // Initials stand until the bytes are here.
    expect(first.container.textContent).toBe("TB");
    await waitFor(() => expect(first.container.querySelector("img")?.getAttribute("src")).toBe("blob:face-1"));
    cleanup();
    // Seen once, it is there from the first frame, with no second request.
    const again = render(<Face name="Tom Beck" picture={url} size="chip" />);
    expect(again.container.querySelector("img")?.getAttribute("src")).toBe("blob:face-1");
    expect(fetched).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("draws a mark for a list or a shared mailbox, and initials for a person: one letter at the small sizes", async () => {
    const { render, cleanup } = await import("@testing-library/react");
    const list = render(<Face name="Practice Weekly" mark="list" size="row" />);
    expect(list.container.querySelector("svg")).not.toBeNull();
    expect(list.container.textContent).toBe("");
    cleanup();
    const person = render(<Face name="Maya Chen" size="chip" />);
    expect(person.container.textContent).toBe("M");
    cleanup();
  });
});
