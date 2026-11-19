import { describe, expect, it } from "vitest";
import { htmlWords } from "./model";

describe("htmlWords in a browser", () => {
  it("names a background image however its address is written, as the browser's own parser reads it", () => {
    expect(htmlWords('<p style="background:url&lpar;https://e.test/r&rpar;">Hi</p><td background="https://e.test/t.png">x</td>')).toContain("[background image: https://e.test/r]");
    expect(htmlWords('<table><tr><td background="https&colon;//e.test/t.png">x</td></tr></table>')).toContain("[background image: https://e.test/t.png]");
    // one line per image, however many ways it was found
    expect(htmlWords('<p style="background-image:url(https://e.test/a.png)">Hi</p>').match(/background image/g)).toHaveLength(1);
  });
});
