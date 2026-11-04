import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Header, type HeaderProps } from "../../web/components/Header";

const render = (props: Partial<HeaderProps>) =>
  renderToStaticMarkup(
    createElement(Header, { busy: false, scanProgress: null, skipped: 0, restarted: false, onRescan: () => {}, onSignOut: () => {}, ...props }),
  );

/** The text of the element carrying `data-testid="<id>"`, or null when it isn't rendered. */
const textOf = (html: string, id: string) => {
  const match = new RegExp(`data-testid="${id}"[^>]*>([^<]*)<`).exec(html);
  return match ? match[1].replaceAll("&#x27;", "'") : null;
};

describe("Header skipped notice", () => {
  it("is not shown when no email was skipped", () => {
    expect(textOf(render({ skipped: 0 }), "skipped-notice")).toBeNull();
  });

  it('uses the exact copy "N emails couldn\'t be read" for every N > 0 (Global Constraints)', () => {
    for (const n of [1, 3, 1234]) {
      expect(textOf(render({ skipped: n }), "skipped-notice")).toBe(`${n} emails couldn't be read`);
    }
  });
});
