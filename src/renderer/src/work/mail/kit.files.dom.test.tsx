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
