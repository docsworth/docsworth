// What a person can see of the live page (R5). A capture holds only that: text a page hides
// from the person reading it, and still puts in its DOM, is exactly where it would put words
// meant for an agent. Only the live page has computed styles and layout, so this runs in the
// tab. It errs towards dropping: a little text lost is cheaper than hidden text kept.
//
// Not detected (spec, flagged concern 4): text coloured like its background, text under
// another element, and text pushed past the right or bottom edge of a page that doesn't
// scroll that far (a page with an open modal doesn't scroll at all, so that can't be told
// from content below the fold). The person reviews the draft before anything is written.

/** Whether an element (with everything in it) and a text node are shown to the person. */
export type Shown = { element(el: Element): boolean; text(t: Text): boolean };

const ZERO_CLIP = /^rect\(\s*0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?\s*\)$/;
const HALF_INSET = /^inset\(\s*50%/;
const CLIPS = /^(?:hidden|clip)$/;

/** In a closed <details> and not its summary: folded away until the person opens it. */
function folded(n: Node): boolean {
  const d = n.parentElement;
  if (d?.localName !== "details" || d.hasAttribute("open")) return false;
  return n !== d.querySelector(":scope > summary");
}

/** The node's parent as rendered: the slot it's shown through, its element, or its shadow root's host. */
export function renderedParent(n: Node): Element | null {
  const p = n.parentElement;
  // A shadow host's child is shown through the slot that takes it. (Asked of the slots, not
  // of the child's assignedSlot, which a test's DOM doesn't have; the answer is the same.)
  const slot = p?.shadowRoot ? [...p.shadowRoot.querySelectorAll("slot")].find((s) => s.assignedNodes().includes(n as ChildNode)) : undefined;
  return slot ?? p ?? ((n.parentNode as Partial<ShadowRoot> | null)?.host ?? null);
}

/**
 * What's shown in `win`. `layout` is false only for a test's DOM, which computes no layout:
 * every box is 0×0 there, so the checks that read boxes would drop everything. It's never
 * read from the page, which could give its root no width to turn those checks off.
 */
export function liveShown(win: Window, layout = true): Shown {
  const doc = win.document;
  const root = doc.scrollingElement ?? doc.documentElement;
  // Where the page's scroll can reach on the left: 0, or for a right-to-left page, which
  // scrolls leftwards, as far left as its content goes.
  const startX = win.getComputedStyle(doc.documentElement).direction === "rtl" ? Math.min(0, root.clientWidth - root.scrollWidth) : 0;
  const range = doc.createRange();

  /** Drawn entirely before the page's start, where no scroll brings it into view. */
  function beforeStart(rects: DOMRect[], n: Node): boolean {
    if (rects.length === 0 || !rects.every((r) => (r.width > 0 && r.right + win.scrollX <= startX) || (r.height > 0 && r.bottom + win.scrollY <= 0))) return false;
    // Unless a container is scrolled past it (a carousel's earlier slides): the person can
    // scroll that back, as far as the container's own start.
    for (let a = renderedParent(n); a && a !== root; a = renderedParent(a)) {
      if (a.scrollLeft <= 0 && a.scrollTop <= 0) continue;
      const c = a.getBoundingClientRect();
      const x = c.left + a.clientLeft - a.scrollLeft;
      const y = c.top + a.clientTop - a.scrollTop;
      return !rects.some((r) => r.right > x && r.bottom > y);
    }
    return true;
  }

  return {
    element(el) {
      if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("hidden") || folded(el)) return false;
      const s = win.getComputedStyle(el);
      // display: contents has no box of its own, so checkVisibility() says false for it (MDN's
      // <main> is one). Its visibility still applies to the text directly in it; the elements
      // in it are checked by themselves.
      if (s.display === "contents") return s.visibility !== "hidden" && s.visibility !== "collapse";
      // display: none (here or above), visibility: hidden, opacity: 0, content-visibility: hidden.
      if (typeof el.checkVisibility === "function" && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
      // content-visibility: hidden keeps the element's box and skips what's in it; checkVisibility
      // reports only the elements inside, not text directly in it.
      if (s.getPropertyValue("content-visibility") === "hidden") return false;
      const positioned = s.position === "absolute" || s.position === "fixed";
      // Screen-reader-only text, clipped away.
      if (positioned && ZERO_CLIP.test(s.clip)) return false;
      if (HALF_INSET.test(s.clipPath)) return false;
      if (!layout) return true;
      const r = el.getBoundingClientRect();
      // Squeezed to a pixel or less with its overflow cut off: sr-only text, a closed accordion.
      if ((CLIPS.test(s.overflowX) && r.width <= 1) || (CLIPS.test(s.overflowY) && r.height <= 1)) return false;
      // A fixed box is placed against the viewport, which doesn't scroll: outside it on any
      // side, it's never seen. (Unless a transformed ancestor holds it: then it has an
      // offsetParent and scrolls with the page, as an absolute box does.)
      if (s.position === "fixed" && (el as HTMLElement).offsetParent === null)
        return !((r.width > 0 && r.right <= 0) || (r.height > 0 && r.bottom <= 0) || r.left >= win.innerWidth || r.top >= win.innerHeight);
      // Placed entirely before the page's start: `left: -9999px`, a transform, a margin.
      return !beforeStart([r], el);
    },
    text(t) {
      // Text directly in a closed <details> is folded away with the rest of it.
      if (folded(t)) return false;
      // font-size: 0 hides text, but pages also set it on a parent to close the gaps between
      // inline blocks, and set a size again inside: so it's checked where the text is. Its
      // size comes from its parent as rendered: a slot it's shown through, or a shadow root's
      // host for text directly in the root.
      const p = renderedParent(t);
      if (p && parseFloat(win.getComputedStyle(p).fontSize) < 1) return false;
      if (!layout || !/\S/.test(t.data)) return true;
      // Where the text itself is drawn: a text-indent, a transform or a margin can move it off
      // the page, or flatten it to nothing, while its element's box stays in place.
      range.selectNodeContents(t);
      const drawn = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      return drawn.length > 0 && !beforeStart(drawn, t);
    },
  };
}
