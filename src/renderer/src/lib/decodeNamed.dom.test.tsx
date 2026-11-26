import { characterEntities } from "character-entities";
import { afterEach, describe, expect, it } from "vitest";
import { decodeNamedCharacterReference, provideCharacterEntities } from "./decodeNamed";

afterEach(() => provideCharacterEntities(null));

describe("a named character reference, decoded", () => {
  it("reads every name from the document as the table reads it", () => {
    const names = Object.keys(characterEntities);
    expect(names.length).toBeGreaterThan(2000);
    const differ = names.filter((name) => decodeNamedCharacterReference(name) !== characterEntities[name]);
    expect(differ).toEqual([]);
  });

  it("refuses what is no name, by the document and by the table alike", () => {
    const none = ["nope", "notit", "ampx", "AMPx", "", "amp;amp", "x3c"];
    for (const value of none) expect(decodeNamedCharacterReference(value), value).toBe(false);
    provideCharacterEntities(characterEntities);
    for (const value of none) expect(decodeNamedCharacterReference(value), value).toBe(false);
  });

  it("reads the table when one is handed in, and never an inherited key", () => {
    provideCharacterEntities({ amp: "&" });
    expect(decodeNamedCharacterReference("amp")).toBe("&");
    expect(decodeNamedCharacterReference("lt")).toBe(false);
    expect(decodeNamedCharacterReference("constructor")).toBe(false);
  });
});
