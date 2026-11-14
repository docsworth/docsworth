import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canSee, type Identity, RESTRICTED, redactionSweep, redactLinks, untilStable } from "../src/core/acl.js";
import { ConfigSchema } from "../src/core/config.js";
import { LOCAL_IDENTITY } from "../src/core/identity.js";
import { pageLinks } from "../src/core/links.js";
import { ASCII_REFERENCES, INVISIBLE_REFERENCES, namingLines, pageNames } from "../src/core/references.js";
import { extractLinks, type InvalidPage, isPage, loadRepo, parsePage } from "../src/core/repo.js";
import { KnowledgeService } from "../src/core/service.js";
import { body, labelsLeft, leaks, rng } from "./acl-oracle.js";
import { FUZZ_IDENTITIES, fuzzRepo } from "./acl-fuzz-fixture.js";
import { ACME, acmeOnGitHub, copyAcme, DEFAULT_CONFIG, INDEX, makeRepo, NOW, page } from "./helpers.js";
import { mirrorPage, serveMirror, writeMirror } from "./mirror-helpers.js";

// Link redaction, case by case: each way of writing a reference to a page the caller
// can't see, as CommonMark, GFM, HTML and URLs allow. The oracle (acl-oracle.ts) checks
// each case reaches the hidden page before redaction, so none passes for want of a link.

const fixture = fuzzRepo();
afterAll(fixture.cleanup);
const { repo } = fixture;
const FROM = "knowledge/runbooks/deploy-legacy.md"; // internal
const R = "../security/rotate-db-credentials.md"; // acl: security
const URL = "https://github.com/acme/knowledge/blob/main/knowledge/security/rotate-db-credentials.md";

const HIDDEN: [string, string][] = [
  ["an inline link", `[x](${R})`],
  ["nested brackets in the link text", `[a [b] c](${R})`],
  ["an escaped bracket in the link text", `[x \\] y](${R})`],
  ["a definition with its destination on the next line", `[x]\n\n[x]:\n${R}`],
  ["a definition in a quote", `> [x]\n>\n> [x]: ${R}`],
  ["a definition in a list item", `- [x]: ${R}\n\n[x]`],
  ["a definition with no space after the colon", `[x]:${R}\n\n[x]`],
  ["an unquoted href", `<a href=${R}>x</a>`],
  ["an img src", `<img src="${R}">`],
  ["a tag across lines", `<a\n  href="${R}">x</a>`],
  ["an attribute value across lines", `<a href="../security/rotate-db-\ncredentials.md">x</a>`],
  ["a percent escape across lines", `- <a href="../security/rotate-db-credentials%2\n  Emd">x</a>`],
  ["a numeric character reference", `[x](../security/rotate-db-credentials&#46;md)`],
  ["named character references", `[x](..&sol;security&sol;rotate-db-credentials&period;md)`],
  ["a numeric reference without its `;`, in HTML", `<a href="../security/rotate-db-credentials&#46md">x</a>`],
  // Review, round 5: a `\` from a reference is a `/` to a browser, as a written one is.
  ["a backslash as a named reference, in an img", '<img src="..&bsol;security&bsol;rotate-db-credentials.md">'],
  ["a backslash as a numeric reference, in an img", '<img src="..&#92;security&#92;rotate-db-credentials.md">'],
  ["percent-encoding, %2F included", `[x](..%2Fsecurity%2Frotate-db-credentials%2Emd)`],
  ["backslash escapes", `[x](..\\/security\\/rotate-db-credentials\\.md)`],
  ["Windows separators in HTML", `<a href="..\\security\\rotate-db-credentials.md">x</a>`],
  // `\.` is an escaped `.` to CommonMark but a `/` and a `.` to a browser in raw HTML.
  ["Windows separators after a dot, in HTML", '<img src=".\\..\\team-secret.md">'],
  ["a GitHub URL", `[x](${URL})`],
  ["an autolink", `<${URL}>`],
  ["a bare URL", `see ${URL}#L3 now`],
  ["a protocol-relative URL", `[x](${URL.slice("https:".length)})`],
  ["the repo path in text", "run `cat knowledge/security/rotate-db-credentials.md` first"],
  ["the path under the root in text", "see security/rotate-db-credentials.md for it"],
  ["a detour through another directory", `[x](zz/../${R})`],
  ["a root-relative link", "[x](/knowledge/security/rotate-db-credentials.md)"],
  ["a query and a fragment", `[x](${R}?plain=1#L2)`],
  ["a link in a table", `| a | [x](${R}) |\n| - | - |`],
  // Review, round 4: markup inside a path renders away (`**x.md**` shows `x.md`).
  ["the file name in bold", "see knowledge/security/**rotate-db-credentials.md** first"],
  ["emphasis inside the file name", "see knowledge/security/rotate-db-**credentials.md** first"],
  ["the file name as code", "see knowledge/security/`rotate-db-credentials.md` first"],
  ["code that starts with a space, inside a name with spaces", "see knowledge/security/on` call (old).md` first"],
  ["markup after an underscore that stays", "see knowledge/security/break_**glass.md** first"],
  // Review, round 8: a comment shows nothing.
  ["a comment inside the path", "See knowledge/security/<!--gap-->rotate-db-credentials.md"],
  // Merge gate, PR 13: a comment past a length bound was kept, and its spaces split the path.
  ["a long comment with spaces inside the path", `See knowledge/security/<!--${"a ".repeat(600)}-->rotate-db-credentials.md`],
  ["a tag with `<` in a quoted value inside the path", 'See knowledge/security/<span title="a<b">rotate-db-credentials.md'],
  // Each shows the path in a browser (commonmark.js, then an HTML5 parser): read left to
  // right, as CommonMark reads them, and ended where a browser ends them.
  ["`<!-->`, a whole comment, inside the path", "See knowledge/security/<!-->rotate-db-credentials.md<!-- x -->"],
  ["a comment opener in a tag's quoted value, inside the path", 'See knowledge/security/<span title="<!--">rotate-db-credentials.md<span title="-->">'],
  ["a CDATA opener inside a comment, inside the path", "See knowledge/security/<!-- <![CDATA[ -->rotate-db-credentials.md ]]>"],
  ["a comment a browser ends at `--!>`", "See knowledge/security/<!-- a --!>rotate-db-credentials.md -->"],
  ["a processing instruction a browser ends at its first `>`", "See knowledge/security/<?>rotate-db-credentials.md?>"],
  ["CDATA a browser ends at its first `>`", "See knowledge/security/<![CDATA[>rotate-db-credentials.md]]>"],
  // A comment with no end is text, so markup after it still renders away.
  ["an unclosed comment, then markup inside the path", "See <!-- x knowledge/security/<b></b>rotate-db-credentials.md"],
  // And where raw HTML is dropped whole, as CommonMark spans it.
  ["a comment holding `--!>`, dropped whole", "See knowledge/security/<!-- a --!> b -->rotate-db-credentials.md"],
  ["a tag inside the file name", "see knowledge/security/rotate<b>-db</b>-credentials.md first"],
  ["the file name in emphasis, by underscores", "see knowledge/security/_rotate-db-credentials.md_ first"],
  ["a link inside the path", "see [knowledge/security/rotate-db-](x)credentials.md first"],
  ["a reference link inside the path", "see [knowledge/security/rotate-db-][r]credentials.md first\n\n[r]: x"],
  ["an image inside the path", 'see knowledge/security/rotate-db-![](x "t")credentials.md first'],
  ["markup between two non-ASCII letters", "see knowledge/security/日**本.md** first"],
  ["the same through the full reader (an `&` selects it)", "see knowledge/security/日**本.md** &amp; more"],
  // An entity broken across lines ends at the break, as HTML reads it: `zz\u00047;..`
  // is a segment the next `..` cancels, so this reaches the hidden root-level page.
  ["an entity broken across lines", '<img src="zz&#4\n7;../../../team-secret.md">'],
  // Review, round 7: `(draft)` is a directory's own name, which a later `..` leaves.
  ["a directory named in parentheses, after ./", '<iframe src="./(draft)/../../team-secret.md"></iframe>'],
  ["a directory named in parentheses", '<iframe src="(draft)/../../team-secret.md"></iframe>'],
  ["indented code", "    cat knowledge/security/rotate-db-credentials.md"],
  ["a name with spaces and parentheses", "[x](<../security/on call (old).md>)"],
  ["the same, percent-encoded", "[x](../security/on%20call%20(old).md)"],
  ["a non-ASCII name", "[x](../services/ledger/café.md)"],
  ["a non-ASCII name as a named reference", "[x](../services/ledger/caf&eacute;.md)"],
  ["a non-ASCII name percent-encoded", "[x](../services/ledger/caf%C3%A9.md)"],
  // Review, round 1: an astral letter is two code units; `&Afr;` (U+1D504) undecoded is one.
  ["an astral name as a named reference, in an img", '<img src="../security/&Afr;.md">'],

  ["a root-level team page", "[x](../team-secret.md)"],
  ["a page that didn't load", "[a [b] c](../security/broken.md)"],
  // Merge gate, PR 13: a link to a path under the root that is no page fails closed as
  // the precise pass does, but the sweep only knew pages that exist. Now every place a
  // destination stands is read.
  ["a link with brackets in its text, to no page", "[a [b] c](../security/not-loaded.md)"],
  ["an img src to no page", '<img src="../gone/away.md">'],
  ["a definition in a quote, to no page", "> [x]\n>\n> [x]: ../gone/away.md"],
  ["a destination on the next line, to no page", "[a [b] c](\n../gone/away.md)"],
  ["an href broken across lines, to no page", '- <a href="../gone/aw\n  ay.md">x</a>'],
  ["a percent escape broken across lines, to no page", '<a href="../gone/away%2\nEmd">x</a>'],
  // A lone tag starts a raw HTML block: its later lines are HTML as written, quote marker
  // and all, so this href is `../index> .md`, no page (in a paragraph, `../index.md`).
  ["an href in a raw HTML block, its quote marker in the value", '<img src="x.png" alt="x">\n> <a href="../index\n> .md">t</a>'],
  // In a raw HTML block a browser takes a tag CommonMark's grammar wouldn't (a stray `"x"`).
  ["a tag only a browser takes, in a raw HTML block, to no page", '<div><img src="../gone/away.md" "x"></div>'],
  // A quote a paragraph leaves open: a browser's reading would run on into the next tag,
  // but the paragraph ends, and CommonMark reads that tag in a block of its own.
  ["a tag after a quote a paragraph leaves open, to no page", 'see <b title="x\n\n<img src="../gone/away.md">'],
  // Merge gate, PR 13, round 4: a GitHub URL into the repo (github.repo) to a path under the
  // root that is no page fails closed too, on any branch and however it's written.
  ["a GitHub URL into the repo, to no page", "[x](https://github.com/acme/knowledge/blob/main/knowledge/gone/away.md)"],
  ["a GitHub URL on another branch, to a page that isn't on this one", "[x](https://github.com/acme/knowledge/blob/feature/new/knowledge/security/not-loaded.md)"],
  ["a raw URL into the repo, to no page", '<img src="https://raw.githubusercontent.com/acme/knowledge/main/knowledge/gone/away.md">'],
  ["a bare URL into the repo, to no page", "see https://github.com/acme/knowledge/blob/main/knowledge/gone/away.md now"],
  ["an autolink into the repo, to no page", "<https://github.com/acme/knowledge/blob/main/knowledge/gone/away.md>"],
  ["a bare URL into the repo with a comment inside, to no page", "see https://github.com/acme/knowledge/blob/main/knowledge/gone/a<!--x-->way.md now"],
  // Merge gate, PR 13, round 6: markup can split the host itself, which still shows whole.
  ["a bare URL into the repo, its host split by markup, to no page", "see https://git**hub.com**/acme/knowledge/blob/main/knowledge/gone/away.md now"],
  // Merge gate, PR 13, round 12: hosts a browser's URL parser maps to github.com.
  ["a bare URL into the repo, its host in fullwidth, to no page", "see https://\uff47ithub.com/acme/knowledge/blob/main/knowledge/gone/away.md now"],
  ["a URL into the repo, an ideographic full stop in its host, to no page", "[x](https://github\u3002com/acme/knowledge/blob/main/knowledge/gone/away.md)"],
  ["a URL into the repo, its host percent-encoded, to no page", '<a href="https://%67ithub.com/acme/knowledge/blob/main/knowledge/gone/away.md">x</a>'],
  ["a URL into the repo, a soft hyphen in its host, to no page", "see https://git\u00adhub.com/acme/knowledge/blob/main/knowledge/gone/away.md now"],
  ["a bare URL into the repo with no scheme, a fullwidth full stop in its host, to no page", "see github\uff0ecom/acme/knowledge/blob/main/knowledge/gone/away.md now"],
  ["an href into the repo broken across lines in its scheme, to no page", '<a href="h\nttps://github.com/acme/knowledge/blob/main/knowledge/gone/away.md">x</a>'],
  // A markdown destination's `\` reaches the href as `%5C` (commonmark.js), which a browser
  // keeps: a path that is no page.
  ["a URL into the repo in a markdown link, with a backslash, to no page", "[x](https://github.com/acme/knowledge/blob/main/knowledge/runbooks\\deploy-production.md)"],
  // A space percent-encoded is part of the URL; only one written ends it.
  ["a bare URL into the repo with an encoded space, to no page", "see https://github.com/acme/knowledge/blob/main/knowledge/team%20space/gone.md now"],
  // In a raw HTML block `\-` is no escape, and a `>` line is HTML too, not a blank one.
  ["a URL into the repo in a raw HTML block, a backslash as written", '<img src="x.png" alt="x">\n> [r][]\n>\n> [r]: https://github.com/acme/knowledge/blob/main/knowledge/runbooks/deploy\\-production.md'],
  ["a URL into the repo broken across lines in an href, to no page", '<a href="https://github.com/acme/know\nledge/blob/main/knowledge/gone/away.md">x</a>'],
  // Merge gate, PR 13, round 5: a URL a browser reads as the repo's, though not as written.
  ["a URL into the repo with its port, to no page", "[x](https://github.com:443/acme/knowledge/blob/feature/new/knowledge/security/not-loaded.md)"],
  ["a bare URL into the repo with its port, to no page", "see https://github.com:443/acme/knowledge/blob/main/knowledge/gone/away.md now"],
  // Broken across lines in an href, where only the destination is read whole:
  ["a URL into the repo with userinfo, to no page", '<a href="https://someone@github.com/acme/know\nledge/blob/main/knowledge/gone/away.md">x</a>'],
  ["a URL into the repo on www, to no page", '<a href="https://www.github.com/acme/know\nledge/blob/main/knowledge/gone/away.md">x</a>'],
  ["a URL into the repo with a trailing dot and capitals, to no page", '<img src="HTTPS://GitHub.com./acme/knowledge/blob/main/knowledge/gone/away.md">'],
  ["a URL into the repo with no slashes after its scheme, to no page", '<a href="https:github.com/acme/know\nledge/blob/main/knowledge/gone/away.md">x</a>'],
  // A space in a directory: the reference starts at the `<` or quote, before the space
  // (with a `./`, so the path isn't spelled out as it is in the repo).
  ["a directory with a space, in angle brackets", "[a [b] c](<../team space/./plans.md>)"],
  ["a directory with a space, in an attribute", '<img src="../team space/./plans.md">'],
  ["a directory with a space, spelled out in text", "see `knowledge/team space/plans.md` or team space/plans.md"],
  // Three spaces: past the two words the sweep reads back, so the start at `<` or the
  // quote reaches it, and in text only the repo path spelled out does.
  ["a directory with three spaces, in angle brackets", "[a [b] c](<../a b c d/./notes.md>)"],
  ["a directory with three spaces, in an attribute", '<img src="../a b c d/./notes.md">'],
  ["a directory with three spaces, spelled out in text", "see knowledge/a b c d/notes.md for it"],
  ["two non-ASCII letters in a row", "[a [b] c](../security/日本.md)"],
  // Past what the sweep reads back, it redacts without resolving.
  ["a destination longer than the sweep reads back", `[a [b] c](${"x/".repeat(300)}${"../".repeat(301)}team-secret.md)`],
  ["forty directories in parentheses, then out of them", `[a [b] c](${"(a)/".repeat(40)}${"../".repeat(41)}team-secret.md)`],
];

describe("link redaction: every form of a link to a hidden page", () => {
  it.each(HIDDEN)("%s", (_name, text) => {
    expect(leaks(text, FROM, repo, LOCAL_IDENTITY), "the case reaches the hidden page").not.toEqual([]);
    const out = redactLinks(text, FROM, repo, LOCAL_IDENTITY);
    expect(leaks(out, FROM, repo, LOCAL_IDENTITY)).toEqual([]);
    expect(out).toContain(RESTRICTED);
  });

  // GitHub matches paths byte for byte, so the oracle doesn't count these; a file system
  // that ignores case or Unicode composition (macOS, Windows) opens the hidden page. And
  // GitHub's strikethrough, which isn't core CommonMark, renders the path whole.
  it.each([
    ["the file name struck through", "see knowledge/security/~~rotate-db-credentials.md~~ first"],
    // An invisible character shows nothing either; a reader sees the path whole.
    ["a soft hyphen inside the path, as a reference", "see knowledge/security/rotate-db-cred&shy;entials.md first"],
    ["a zero-width space inside the path, as written", "see knowledge/security/rotate-db-cred\u200bentials.md first"],
    ["a zero-width space inside the path, as a numeric reference", "see knowledge/security/rotate-db-cred&#8203;entials.md first"],
    ["a path differing only in case", "[a [b] c](../Security/Rotate-DB-Credentials.MD)"],
    ["the repo path in capitals, in text", "see KNOWLEDGE/SECURITY/ROTATE-DB-CREDENTIALS.MD"],
    ["a decomposed name", "[a [b] c](../services/ledger/cafe\u0301.md)"],
    ["a combining mark, percent-encoded", "[a [b] c](../services/ledger/cafe%CC%81.md)"],
    ["a combining mark as a reference", '<img src="../services/ledger/cafe&#769;.md">'],
    ["a combining mark as a reference, in text", "see knowledge/services/ledger/cafe&#769;.md first"],
  ])("as a file system or GitHub reads it, though CommonMark's oracle doesn't: %s", (_name, text) => {
    expect(redactLinks(text, FROM, repo, LOCAL_IDENTITY)).toBe(RESTRICTED);
  });

  it("reads a value broken across lines whose rest looks like a list marker", () => {
    // Merge gate, PR 13: read as raw HTML (URL parsing drops the line break) this reaches
    // `security/1. secret.md`, but the joined view took `1. ` for a list marker and
    // dropped it. CommonMark itself reads a list item here, so the oracle sees no link.
    const out = redactLinks('<a href="../security/\n1. secret.md">x</a>', FROM, repo, LOCAL_IDENTITY);
    expect(out).not.toMatch(/secret/);
    expect(out.split("\n").every((l) => l.includes(RESTRICTED))).toBe(true);
  });

  // Forms the oracle doesn't read: other attributes HTML reads as a URL.
  it.each([
    ["a srcset", '<img srcset="x.png 1x, ../gone/away.md 2x">'],
    // Merge gate, PR 13, round 7: some attributes hold a list of URLs.
    ["a ping, second in its list", '<a href="#" ping="https://example.com/x ../gone/away.md">x</a>'],
    ["an imagesrcset, second in its list", '<link rel="preload" as="image" imagesrcset="x.png 1x, ../gone/away.md 2x">'],
    ["an archive, first in its list", '<object archive="../gone/away.md x.jar"></object>'],
    ["an object's data", '<object data="../gone/away.md"></object>'],
    ["an iframe's srcdoc", `<iframe srcdoc="<a href='../gone/away.md'>x</a>"></iframe>`],
    ["an iframe's srcdoc, its references encoded", '<iframe srcdoc="&lt;a href=&quot;../gone/away.md&quot;&gt;x&lt;/a&gt;"></iframe>'],
    ["a refresh", '<meta http-equiv="refresh" content="0; url=../gone/away.md">'],
    // A `?` percent-encoded is part of the path; only one written starts a query.
    ["a bare URL into the repo with an encoded `?`", "see https://github.com/acme/knowledge/blob/main/knowledge/gone%3F/away.md now"],
  ])("refuses %s to no page", (_name, text) => {
    const out = redactLinks(text, FROM, repo, LOCAL_IDENTITY);
    expect(out).toContain(RESTRICTED);
    expect(out).not.toContain("away");
  });

  // Merge gate, PR 13, round 9: a srcdoc is a document of its own, read by every sweep.
  it.each([
    ["a hidden page's path split by markup", '<iframe srcdoc="see knowledge/security/rotate-db-<b></b>credentials.md"></iframe>'],
    ["the same, its markup encoded", '<iframe srcdoc="see knowledge/security/rotate-db-&lt;b&gt;&lt;/b&gt;credentials.md"></iframe>'],
  ])("reads an iframe's srcdoc as a document: %s", (_name, text) => {
    expect(redactLinks(text, FROM, repo, LOCAL_IDENTITY)).toBe(RESTRICTED);
  });

  // Merge gate, PR 13, round 10: a browser resolves every relative URL against the first
  // `<base href>`, wherever it stands; a srcdoc inherits its parent's.
  // Without the base, `../index.md` is the visible root index; with it, the hidden
  // `knowledge/security/index.md`.
  it.each([
    ["a relative base", '<base href="../security/x/"><a href="../index.md">open</a>'],
    ["a markdown link under a base", '<base href="../security/x/">\n\n[open](../index.md)'],
    ["a base that's a URL into the repo", '<base href="https://github.com/acme/knowledge/blob/main/knowledge/security/x/">\n\n[open](../index.md)'],
    ["a base inherited by a srcdoc", `<base href="../security/x/"><iframe srcdoc="<a href='../index.md'>x</a>"></iframe>`],
  ])("resolves a link against a base: %s", (_name, text) => {
    expect(redactLinks(text.replace(/<base[^>]*>/, ""), FROM, repo, LOCAL_IDENTITY), "without the base, a visible page").toBe(text.replace(/<base[^>]*>/, ""));
    const out = redactLinks(text, FROM, repo, LOCAL_IDENTITY);
    expect(out).toContain(RESTRICTED);
    expect(out).not.toContain("index.md");
  });

  it("reads a URL's path as written: no compatibility mapping, a named reference to a non-ASCII letter", () => {
    // NFKC maps `𝔄` to `A`; a path isn't normalized so, only a host is (by the URL parser).
    const sam = FUZZ_IDENTITIES.find((w) => w.teams.has("security"))!;
    for (const text of ["[x](https://github.com/acme/knowledge/blob/main/knowledge/security/\u{1d504}.md)", "see https://github.com/acme/knowledge/blob/main/knowledge/security/\u{1d504}.md now", "[x](https://github.com/acme/knowledge/blob/main/knowledge/security/&Afr;.md)"]) {
      expect(redactLinks(text, FROM, repo, sam)).toBe(text);
    }
  });

  it("fails closed on a srcdoc nested deeper than any page nests one", () => {
    const nest = (doc: string) => `<iframe srcdoc="${doc.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}"></iframe>`;
    const deep = nest(nest(nest(nest("nothing to hide here"))));
    expect(redactLinks(nest(nest(nest("nothing to hide here"))), FROM, repo, LOCAL_IDENTITY)).toBe(nest(nest(nest("nothing to hide here"))));
    expect(redactLinks(deep, FROM, repo, LOCAL_IDENTITY)).toBe(RESTRICTED);
  });

  it("refuses a link to no page even where nothing is hidden, as the precise pass does", () => {
    const acme = loadRepo(ACME);
    const all: Identity = { mode: "github", login: "ada", teams: new Set(["payments", "security", "platform"]), repoAccess: true, canWrite: true };
    expect(acme.pages.every((p) => canSee(p, all)) && acme.invalid.length === 0, "nothing in the example is hidden from this caller").toBe(true);
    const from = "knowledge/runbooks/deploy-production.md";
    expect(redactLinks("[x](../security/not-loaded.md)", from, acme, all)).toBe(RESTRICTED);
    expect(redactLinks("[a [b] c](../security/not-loaded.md)", from, acme, all)).toBe(RESTRICTED);
    expect(redactLinks("[a [b] c](../index.md)", from, acme, all)).toBe("[a [b] c](../index.md)");
    // The example runs locally (no github.repo): no URL can be told to be into the repo.
    const url = "[x](https://github.com/acme/knowledge/blob/main/knowledge/gone/away.md)";
    expect(redactLinks(url, from, acme, all)).toBe(url);
  });

  // Merge gate, PR 13, round 6: a port in api_url was kept on one side and read past on the other.
  it.each(["https://ghe.example.com/api/v3", "https://ghe.example.com:8443/api/v3"])("refuses a URL into the repo on GitHub Enterprise Server, by its host (%s)", (api) => {
    const ghe = makeRepo(
      { ...INDEX, "knowledge/runbooks/a.md": page({ id: "a", title: "A" }) },
      { config: `${DEFAULT_CONFIG.replace("org: acme\n", `org: acme\n  repo: acme/knowledge\n  api_url: ${api}\n`)}` },
    );
    try {
      expect(ghe.config.github.api_url).toBe(api);
      const from = "knowledge/runbooks/a.md";
      const who: Identity = { mode: "github", login: "ada", teams: new Set(), repoAccess: true, canWrite: true };
      const web = api.replace("/api/v3", "");
      for (const text of [`see ${web}/acme/knowledge/blob/main/knowledge/gone/away.md`, `see ${web}/raw/acme/knowledge/main/knowledge/gone/away.md`, "[x](https://ghe.example.com/acme/knowledge/blob/main/knowledge/gone/away.md)"]) {
        expect(redactLinks(text, from, ghe, who)).toBe(RESTRICTED);
      }
      // github.com is another host there, so another repo.
      const elsewhere = "see https://github.com/acme/knowledge/blob/main/knowledge/gone/away.md";
      expect(redactLinks(elsewhere, from, ghe, who)).toBe(elsewhere);
      expect(redactLinks("see https://ghe.example.com/acme/knowledge/blob/main/knowledge/runbooks/a.md", from, ghe, who)).toBe("see https://ghe.example.com/acme/knowledge/blob/main/knowledge/runbooks/a.md");
    } finally {
      ghe.cleanup();
    }
  });

  it("is kept for a caller who can see the page", () => {
    const sam = FUZZ_IDENTITIES.find((w) => w.teams.has("security"))!;
    for (const [, text] of HIDDEN.slice(0, 30)) expect(redactLinks(text, FROM, repo, sam)).toBe(text);
  });
});

const VISIBLE: [string, string, string][] = [
  ["a relative link", FROM, "[x](deploy-production.md)"],
  // knowledge/index.md is visible while knowledge/security/index.md isn't: same file name.
  ["a link to a page that shares a hidden page's file name", FROM, "[x](../index.md)"],
  ["the same from the hidden page's directory", "knowledge/security/rotate-db-credentials.md", '[x](../index.md "t") and <a href="./../index.md">y</a>'],
  ["a detour that cancels the directory", "knowledge/security/rotate-db-credentials.md", "[x](%2e/../index.md)"],
  ["a GitHub URL to a visible page", FROM, "[x](https://github.com/acme/knowledge/blob/main/knowledge/index.md)"],
  ["a path in text", FROM, "see ../index.md and knowledge/index.md, then [the index](../index.md)"],
  ["a definition in a quote", FROM, "> [ref]\n>\n> [ref]: ../onboarding/on-call.md"],
  // A raw HTML block ends at a blank line; in the list item after it, a value broken
  // across lines is read past the item's indent, as CommonMark reads a paragraph.
  ["an href broken across lines, after a raw HTML block", FROM, '<img src="x.png" alt="x">\n\n- <a href="../ind\n  ex.md">t</a>'],
  ["a GitHub URL into the repo, on a branch named after the root", FROM, "[x](https://github.com/acme/knowledge/blob/knowledge/update/knowledge/index.md)"],
  ["a URL elsewhere, to a path that would be no page", FROM, "see https://example.com/acme/knowledge/blob/main/knowledge/gone/away.md and [x](https://notgithub.com/acme/knowledge/blob/main/knowledge/gone/away.md)"],
  ["a GitHub URL into another repo", FROM, "see https://github.com/acme/other/blob/main/knowledge/gone/away.md"],
  // In raw HTML a browser reads `\` as `/` itself: the visible page.
  ["a URL into the repo in an href, with a backslash, to a visible page", FROM, '<a href="https://github.com/acme/knowledge/blob/main/knowledge/runbooks\\deploy-production.md">x</a>'],
  ["Windows separators in HTML", FROM, '<a href="..\\index.md">x</a>'],
  // In raw HTML `\.` is `/` then `.`, not CommonMark's escaped `.`: `./../index.md`.
  ["Windows separators after a dot, in HTML", FROM, '<a href=".\\..\\index.md">x</a>'],
  ["character references", FROM, "[x](..&#47;index&period;md)"],
  // Review, round 1: the path continues past the space to a visible page; its tail
  // `security/rotate-db-credentials.md` is a hidden page's path under the root.
  ["a path whose tail is a hidden page's, in angle brackets", FROM, "[x](<../team space/security/rotate-db-credentials.md>)"],
  ["the same, percent-encoded", FROM, "[x](../team%20space/security/rotate-db-credentials.md)"],
  ["the same as a GitHub URL", FROM, "[x](https://github.com/acme/knowledge/blob/main/knowledge/team%20space/security/rotate-db-credentials.md)"],
  // A browser keeps `%5C`, so this names no page; the liberal reading (`\` as `/`) is the
  // visible one, and a `.md` naming no page is the liberal reading's to judge.
  ["the same after an escaped backslash", FROM, "[x](..&bsol;team%20space/security/rotate-db-credentials.md)"],
];

describe("link redaction: a hidden page named in a destination's query", () => {
  // The destination pass reads a destination as the URL it is, its query cut; the name
  // sweep reads a hidden page's path anywhere, a query included, in every form a value
  // takes. (The oracle cuts the query too, so these are asserted directly.)
  it.each([
    ["broken across lines in a quote", '> <a href="./deploy-production.md?next=../security/rotate-db-\n> credentials.md">x</a>', "credentials"],
    ["broken across lines in a raw HTML block, where a list marker is part of it", '<div>\n<a href="./deploy-production.md?next=../security/\n1. secret.md">x</a>\n</div>', "secret"],
    ["with Windows separators after a dot, in HTML", '<a href="./deploy-production.md?next=.\\..\\team-secret.md">x</a>', "team-secret"],
    ["with more spaces than the sweep reads back by words", '<a href="./deploy-production.md?next=../a b c d/./notes.md">x</a>', "notes"],
    ["with a percent escape broken across lines", '<a href="./deploy-production.md?next=../security/rotate-db-credentials%2\nEmd">x</a>', "credentials"],
    ["with two non-ASCII letters broken across lines", '<a href="./deploy-production.md?next=../security/日\n本.md">x</a>', "本"],
  ])("%s", (_name, text, name) => {
    const out = redactLinks(text, FROM, repo, LOCAL_IDENTITY);
    expect(out).toContain(RESTRICTED);
    expect(out).not.toContain(name);
  });
});

describe("link redaction: the label of a reference whose definition goes", () => {
  // Code review, round 1: as on main, a definition in a quote went and its reference stayed.
  it.each([
    ["a path's as a route's", "> [Rotate the keys]\n>\n> [rotate the keys]: ../security/rotate-db-credentials.md"],
    // A label wrapped across lines is one label to CommonMark.
    ["a label wrapped across lines, in a quote", "> [Rotate\n> the keys]\n>\n> [rotate the keys]: ../security/rotate-db-credentials.md"],
    ["a label wrapped across lines", "[Rotate\nthe keys]\n\n[rotate the keys]: ../security/rotate-db-credentials.md"],
  ])("goes with it: %s", (_name, text) => {
    const out = redactLinks(text, FROM, repo, LOCAL_IDENTITY);
    expect(out).not.toMatch(/Rotate|the keys/i);
  });
});

describe("link redaction: a link to a visible page stays as written", () => {
  it.each(VISIBLE)("%s", (_name, from, text) => {
    expect(redactLinks(text, from, repo, LOCAL_IDENTITY)).toBe(text);
  });
});

// The owner's decision (2026-11-13): a route-shaped link that names no page or file fails
// closed, as a `.md` path under the root that is no page does. A route a page's slug or id
// gives it counts as that page: hidden wins a shared route, visible keeps its own.
describe("link redaction: routes, as a docs site serves them", () => {
  const sec = (fm: Record<string, unknown>) => page({ owner_team: "security", acl: "security", ...fm });
  const site = makeRepo({
    ...INDEX,
    "knowledge/guides/intro.md": page({ id: "intro", title: "Intro" }),
    "knowledge/guides/setup.md": page({ id: "setup", title: "Setup" }),
    "knowledge/handbook-page.md": page({ id: "handbook", title: "Handbook" }),
    "knowledge/welcome-page.md": page({ id: "welcome-page", title: "Welcome", slug: "/guides/welcome" }),
    "knowledge/sec/hsm.md": sec({ id: "hsm", title: "HSM" }),
    "knowledge/sec/02-keys.md": sec({ id: "keys", title: "Keys" }),
    "knowledge/old/vault-notes.md": sec({ id: "vault-notes", title: "Vault", slug: "/vault" }),
    "knowledge/old/release.md": sec({ id: "release", title: "Release", slug: "/1.0-release" }),
    // A hidden page a slug moved away from `/setup`, and a visible one a slug moved there.
    "knowledge/setup.md": sec({ id: "setup-legacy", title: "Old setup", slug: "/legacy" }),
    "knowledge/next.md": page({ id: "next", title: "Next", slug: "/start" }),
    // A page that didn't load, its slug kept: hidden.
    "knowledge/broken.md": "---\ntitle: Broken\nslug: /broken-route\n---\nNo valid frontmatter.\n",
    // Review, round 4: a source a slug moves reads a relative link from its URL.
    "knowledge/guides/moved-src.md": page({ id: "moved-src", title: "Moved source", slug: "/moved/intro" }),
    "knowledge/x/secret-page.md": sec({ id: "secret-page", title: "Secret", slug: "/moved/secret" }),
    // Review, round 4: a slug holding punctuation, beside a visible page at the shorter route.
    "knowledge/old/setup-old.md": sec({ id: "setup-old", title: "Old setup", slug: "/guides/setup(old)" }),
    // A dotted file name, its route moved by its id: linked by its stem.
    "knowledge/sec/2.0-plan.md": sec({ id: "plan-2", title: "Plan" }),
    // Under this page's own route: a site with trailing slashes reads `secret` here.
    "knowledge/guides/intro/secret.md": sec({ id: "secret", title: "Intro secret" }),
    // A visible page beside a hidden one at its route read with a trailing slash.
    "knowledge/guides/faq.md": page({ id: "faq", title: "FAQ" }),
    "knowledge/guides/intro/faq.md": sec({ id: "intro-faq", title: "Intro FAQ", slug: "faq" }), // its id would move it
    // Hidden, where `zz%5C../../handbook-page.md` lands from guides/: a browser keeps `%5C`.
    "knowledge/guides/handbook-page.md": sec({ id: "guides-handbook", title: "Guides handbook" }),
    // Two pages at one route: hidden wins.
    "knowledge/shared.md": page({ id: "shared", title: "Shared" }),
    "knowledge/sec/shared-copy.md": sec({ id: "shared-copy", title: "Shared copy", slug: "/shared" }),
    // A page that didn't load, at a visible page's route: hidden wins there too.
    "knowledge/team.md": page({ id: "team", title: "Team" }),
    "knowledge/broken-team.md": "---\ntitle: Broken\nslug: /team\n---\nNo valid frontmatter.\n",
    "vault/README.md": "# The repo's own vault directory\n",
    "src/index.ts": "export {};\n",
    Makefile: "all:\n",
    "knowledge/img/a.png": "png",
  });
  afterAll(site.cleanup);
  const nina: Identity = { mode: "github", login: "nina", teams: new Set(), repoAccess: true, canWrite: true };
  const from = "knowledge/guides/intro.md";
  const hides = (text: string, at = from) => redactLinks(text, at, site, nina);

  it.each([
    ["a hidden page's route, root-relative", "[HSM](/sec/hsm)"],
    ["the same with the docs prefix", "[HSM](/docs/sec/hsm)"],
    ["the same with a trailing slash", "[HSM](/sec/hsm/)"],
    ["its path relative to this page, without .md", "[HSM](../sec/hsm)"],
    ["a number-prefixed page by its route", "[Keys](/sec/keys)"],
    ["a number-prefixed page by its file name, without .md", "[Keys](../sec/02-keys)"],
    ["a hidden page by its slug, beside a repo directory of the same name", "[Vault](/vault)"],
    ["a hidden page by a dotted slug", "[Release](/1.0-release)"],
    ["a page that didn't load, by its slug", "[Broken](/broken-route)"],
    ["a route naming nothing", "[Gone](/guides/gone)"],
    ["a relative route naming nothing", "[Gone](gone)"],
    ["as an HTML href", '<a href="/sec/hsm">HSM</a>'],
    ["as a definition", "[HSM]\n\n[HSM]: /sec/hsm"],
    ["a definition a link uses, to a route naming nothing", "[Gone]\n\n[Gone]: gone"],
    ["with a query and a fragment", "[HSM](/sec/hsm?x=1#top)"],
    ["a slug holding a parenthesis, beside a visible page at the shorter route", "[Old](/guides/setup(old))"],
    ["a dotted file's stem, relative", "[Plan](../sec/2.0-plan)"],
    ["a dotted file's stem, root-relative", "[Plan](/sec/2.0-plan)"],
    ["a page under this page's own route, read as a site with trailing slashes reads it", "[Secret](secret)"],
    ["the same where the route without the slash is a visible page's", "[FAQ](faq)"],
    ["a route two pages share, one hidden", "[Shared](/shared)"],
    ["a route a page that didn't load shares with a visible one", "[Team](/team)"],
    // On GitHub a directory lists its files, a hidden page's among them.
    ["a directory under the knowledge root", "[Sec](../sec) and [Sec](../sec/)"],
  ])("hides %s", (_name, text) => {
    const out = hides(text);
    expect(out).toContain(RESTRICTED);
    expect(out).not.toMatch(/HSM|Keys|Vault|Release|Broken|Gone|Old|Plan|Secret|FAQ|Shared|Team|Sec|Up/);
  });

  it.each([
    ["a visible page by its id route", "[Guide](/handbook)"],
    ["a visible page by its slug route", "[Welcome](/guides/welcome)"],
    ["a visible page by a relative route", "[Setup](setup)"],
    ["the same, root-relative", "[Setup](/guides/setup)"],
    ["the same with the docs prefix", "[Guide](/docs/handbook)"],
    // Resolved with `%2F` kept, then decoded and resolved again, as a server reads it.
    ["a route with an encoded slash after the docs prefix", "[Intro](/docs%2Fguides/intro)"],
    ["a route with an encoded slash after a dot-dot segment", "[Intro](..%2Fguides/intro)"],
    // `knowledge/..%2Fsrc` to a browser, then `src` to a server: the repo's own directory.
    ["a repo directory reached through an encoded slash", "[Source](../..%2Fsrc)"],
    ["a visible page by its slug, at a route a hidden page's file once had", "[Start](/start)"],
    ["the route a hidden page's slug moved it away from, now a visible page's", "[Setup](/guides/setup)"],
    ["a repo directory outside the knowledge root", "[Source](/src)"],
    ["a repo file outside the knowledge root", "[Build](/Makefile)"],
    ["an attachment", "![a](/knowledge/img/a.png) and ![b](../img/a.png)"],
    ["a dotted path naming nothing", "![x](/img/missing.png)"],
    ["an external URL", "[x](https://example.com/sec/hsm)"],
    ["an anchor", "[x](#sec-hsm)"],
    // Only a link CommonMark reads fails closed for naming nothing: these aren't links.
    ["a footnote", "The ceremony is yearly.[^1]\n\n[^1]: The board sets it."],
    ["a glossary line", "[HSM]: hardware security module"],
    ["a definition no link uses", "[spare]: nowhere"],
    ["words in brackets, then words in parentheses", "[sic](as written)"],
  ])("keeps %s", (_name, text) => {
    expect(hides(text)).toBe(text);
  });

  // Found by the fuzz: where a browser goes, not only the liberal reading.
  it.each([
    // No reference without its `;` in markdown: `#46md` is a fragment, the link is to `setup&`.
    ["a numeric reference without its `;`, its `#` a fragment", "[Setup](setup&#46md)"],
    // `\` reaches the href as `%5C`: `zz%5C..` is a segment, and `..` climbs out of it only.
    ["an escaped backslash, as a browser resolves it, to a hidden page", "[Handbook](zz&bsol;../../handbook-page.md)"],
    // `%2F` is no separator to a browser either: `zz%2F..` is one segment.
    ["an encoded slash, as a browser resolves it, to a hidden page", "[Handbook](zz%2F../../handbook-page.md)"],
    // Code review, round 7: decoded first it's the visible /handbook; as a browser resolves
    // it, /guides/handbook, a route naming nothing.
    ["an encoded slash, as a browser resolves it, to a route naming nothing", "[Guide](zz%2F../../handbook)"],
    // `%2F` isn't a separator to a URL parser: a path, not `//github.com/…`.
    ["an encoded slash that would read as a protocol-relative URL", "[Setup](/%2Fgithub.com/acme/knowledge/blob/main/knowledge/guides/setup)"],
    ["the same in an href", '<a href="/%2Fgithub.com/acme/knowledge/blob/main/knowledge/guides/setup">Setup</a>'],
  ])("hides %s", (_name, text) => {
    expect(hides(text)).toBe(RESTRICTED);
  });

  it("hides an href broken across lines inside a reference, as HTML reads it", () => {
    // `&#` then a line break is no reference: `#46;md` is a fragment, the link is to `setup&`.
    const out = hides('<a href="setup&#\n46;md">Setup</a>');
    expect(out.split("\n").every((l) => l.includes(RESTRICTED))).toBe(true);
  });

  it("hides a definition a redaction brings into effect", () => {
    // The first definition for `ref` is hidden, in a quote the first pass doesn't read; once
    // its line goes, the second one takes effect, to a route naming nothing.
    const out = hides("> [ref]: /sec/hsm\n\n[Shown][ref]\n\n[ref]: gone");
    expect(pageLinks(out), out).toEqual([]);
  });

  // Code review, round 1: the sweep removed a definition's line in a container, and the
  // reference using it stayed, showing its label as text.
  it.each([
    ["in a quote", "> [HSM]\n>\n> [HSM]: /sec/hsm"],
    ["in a list item, by another label", "- [Vault keys][vk]\n\n  [vk]: /vault"],
    ["in a quote, the label in another case and spacing", "> [The  HSM][hsm key]\n>\n> [HSM Key]: /sec/hsm"],
    ["in a quote, with spaces inside the brackets", "> [The HSM][ hsm key ]\n>\n> [HSM Key]: /sec/hsm"],
    // Code review, round 2: CommonMark folds case as Unicode does (ß is SS), and a label
    // may hold an escaped bracket.
    ["matched by Unicode case folding", "[HSM Straße]\n\n[HSM STRASSE]: /sec/hsm"],
    ["holding an escaped bracket, in a quote", "> [HSM a\\]b]\n>\n> [hsm A\\]B]: /sec/hsm"],
    ["holding an escaped opening bracket, in a quote", "> [HSM a\\[b]\n>\n> [hsm A\\[B]: /sec/hsm"],
    // Code review, round 3: `\\` is an escaped backslash, so the bracket after it opens a reference.
    ["after an escaped backslash, in a quote", "> \\\\[HSM]\n>\n> [HSM]: /sec/hsm"],
  ])("hides the label of a reference whose definition it hides, %s", (_name, text) => {
    const out = hides(text);
    expect(out).not.toMatch(/HSM|Vault/);
    expect(pageLinks(out)).toEqual([]);
  });

  // Code review, round 1, rebutted: whether a destination is a link is told by its value, so an
  // unused definition to the same route naming nothing goes with the broken link. It rendered
  // nothing, so the page shows the same; only the markdown agents read loses that line.
  // Code review, round 5: only what CommonMark reads as a reference to the label goes, not
  // an inline link whose text happens to be the label.
  it("keeps an inline link whose text is a hidden definition's label", () => {
    expect(hides("[HSM](https://vendor.example/hsm)\n\n[HSM]: /sec/hsm")).toMatch(/^\[HSM\]\(https:\/\/vendor\.example\/hsm\)/);
  });

  // Only a reference's own lines go, the rest of its paragraph stays: each line is matched
  // to the label as CommonMark matches it. Where none matches, the whole paragraph goes.
  it.each([
    ["by its label as written", ["First line.", "See [HSM] next.", "Last line."], "[HSM]", [0, 2]],
    // Code review, round 6: two references in one paragraph gave it twice.
    ["twice on one line", ["First line.", "See [HSM] and [HSM].", "Last line."], "[HSM]", [0, 2]],
    ["in another case", ["First line.", "See [hsm] next.", "Last line."], "[HSM]", [0, 2]],
    ["folded as Unicode folds case", ["First line.", "See [Straße] next.", "Last line."], "[STRASSE]", [0, 2]],
    ["holding an escaped bracket", ["First line.", "See [a\\]b] next.", "Last line."], "[A\\]B]", [0, 2]],
    ["with runs of space", ["First line.", "See [two   words] next.", "Last line."], "[TWO WORDS]", [0, 2]],
    ["wrapped across lines", ["First line.", "See [two", "words] next.", "Last line."], "[two words]", [0, 3]],
    // Read past the list item's indent: on its own, `     See [HSM]` would be indented code.
    ["in a list item's paragraph", ["- 1. item", "", "     See [HSM] next.", "     Last line."], "[HSM]", [0, 1, 3]],
    ["after an escaped backslash, beside a literal bracket", ["See \\\\[HSM] next.", "Write \\[HSM] literally."], "[HSM]", [1]],
    // A label holding what reads as a list marker on its own line: no line shows it, so all of it.
    ["holding `2)` at a line's start", ["- [HSM", "  2) more] next."], "[HSM 2) more]", []],
  ])("goes from a paragraph, %s, keeping the rest", (_name, lines, label, kept) => {
    const text = `${(lines as string[]).join("\n")}\n\n> ${label}: /sec/hsm`;
    const out = hides(text).split("\n");
    expect(out.slice(0, (lines as string[]).length).map((l, i) => (l.includes(RESTRICTED) ? -1 : i)).filter((i) => i >= 0), out.join("\n")).toEqual(kept);
    expect(out.join("\n")).not.toMatch(/See \[|words\]|more\]/);
  });

  // Found by the fuzz: once the definition's lines go, the second `[ref]:` follows a
  // paragraph's line and can't start a definition: it's a reference to a label that went.
  it("hides a reference a replaced line makes, to a label that went in an earlier pass", () => {
    const out = hides("[ref]\n\n[ref]:\n/sec/hsm\n[ref]:/guides/setup\n\n[ref]");
    expect(out).not.toMatch(/\[ref\]/);
  });

  // Code review, round 9: CommonMark is the judge of what's a definition and a reference.
  it("keeps references to a visible definition when a `]:` inside a paragraph names a hidden page", () => {
    const out = hides("Lead paragraph.\n[term]: /sec/hsm\n\n[term]: https://vendor.example/term\n\nUse [term].");
    expect(out.endsWith("Use [term].")).toBe(true);
    expect(out).not.toMatch(/sec\/hsm/);
  });

  // Merge gate, PR 53: a reference image is a reference too.
  it.each([
    ["a reference image", "![HSM]\n\n> [HSM]: /sec/hsm"],
    ["a full reference image", "![the HSM][HSM]\n\n> [HSM]: /sec/hsm"],
  ])("hides %s whose definition it hides", (_name, text) => {
    expect(hides(text)).not.toMatch(/HSM/);
  });

  // Merge gate, PR 53, round 2: a full reference's text wraps to the line before its label.
  it.each([
    ["in a quote", "> [HSM rotation procedure\n> details][ref]\n>\n> [ref]: /sec/hsm"],
    ["at the top level", "[HSM rotation procedure\ndetails][ref]\n\n[ref]: /sec/hsm"],
    ["as an image", "> ![HSM rotation\n> diagram][ref]\n>\n> [ref]: /sec/hsm"],
    // Merge gate, PR 53, round 3: text holding brackets of its own.
    ["its text holding brackets", "> [HSM rotation [draft]\n> details][ref]\n>\n> [ref]: /sec/hsm"],
    // Defined by its file path, which the first pass reads (and took the label alone, as a
    // shortcut reference).
    ["its text holding brackets, defined by file path", "> [HSM rotation [draft]\n> details][ref]\n>\n> [ref]: ../sec/hsm.md"],
    ["its text holding brackets on one line, defined by file path", "[HSM rotation [draft] details][ref]\n\n[ref]: ../sec/hsm.md"],
    // A `]` a code span holds closes nothing: the `]` before the label has no `[` to match,
    // so the reference takes its whole block.
    ["its text holding a code span with a bracket", "> [HSM `]` rotation\n> details][ref]\n>\n> [ref]: /sec/hsm"],
    // An image that gets no token stays an image (Codex, PR 54).
    ["as an image, its text holding a code span with a bracket", "> ![HSM `]` rotation][ref]\n>\n> [ref]: /sec/hsm"],
  ])("hides a full reference whose text wraps lines, %s", (_name, text) => {
    expect(hides(text)).not.toMatch(/HSM|details|diagram|draft/);
  });

  // Merge gate, PR 53, round 3: brackets are matched as they nest, escapes aside, so only the
  // reference's own lines go.
  it.each([
    ["brackets in its text", "Keep this line.\n[HSM [draft]\nrotation][ref]\n\n[ref]: /sec/hsm"],
    ["an escaped bracket in its text", "Keep this line.\n[HSM \\] rotation\ndetails][ref]\n\n[ref]: /sec/hsm"],
    ["a shortcut after an escaped bracket", "Keep this line.\nLiterally \\][ref] here.\n\n[ref]: /sec/hsm"],
  ])("keeps the rest of the paragraph around a reference, %s", (_name, text) => {
    const out = hides(text);
    expect(out.split("\n")[0]).toBe("Keep this line.");
    expect(out).not.toMatch(/HSM|rotation|details|Literally/);
  });

  // Merge gate, PR 53: read in its paragraph, a code span opened on the line before is code.
  it("keeps a label in code that spans lines, in a paragraph with a reference", () => {
    const out = hides("See [HSM].\nWrite `[HSM]\nliterally`.\n\n> [HSM]: /sec/hsm");
    expect(out.split("\n").slice(0, 3)).toEqual([RESTRICTED, "Write `[HSM]", "literally`."]);
  });

  it("keeps an inline link whose text is the label, in a paragraph with a reference", () => {
    const out = hides("[HSM](https://vendor.example/hsm) stays.\nSee [HSM].\n\n> [HSM]: /sec/hsm");
    expect(out.startsWith("[HSM](https://vendor.example/hsm) stays.\n")).toBe(true);
    expect(out).not.toMatch(/See \[HSM\]/);
  });

  it("keeps a label in code, in a paragraph with a reference", () => {
    const out = hides("Write `[HSM]` for it.\nSee [HSM].\n\n> [HSM]: /sec/hsm");
    expect(out.startsWith("Write `[HSM]` for it.\n")).toBe(true);
    expect(out).not.toMatch(/See \[HSM\]/);
  });

  // A backtick on the line before closes the one before `[HSM]`: in the paragraph, it's a
  // reference, though on its own line it would read as code. The paragraph goes whole.
  it("hides a reference that reads as code on its own line only", () => {
    const out = hides("See ` this\n` [HSM] `x`\n\n> [HSM]: /sec/hsm");
    expect(out).not.toMatch(/HSM/);
  });

  it("keeps an inline link whose text is the label, beside a paragraph with a reference", () => {
    const out = hides("[HSM](https://vendor.example/hsm)\n\nSee [HSM].\n\n> [HSM]: /sec/hsm");
    expect(out.startsWith("[HSM](https://vendor.example/hsm)\n\n")).toBe(true);
    expect(out).not.toMatch(/See \[HSM\]/);
  });

  it("takes an unused definition sharing a broken link's destination with it, though it rendered nothing", () => {
    const out = hides("[Broken](gone)\n\n[term]: gone");
    expect(out.startsWith(RESTRICTED)).toBe(true);
    expect(pageLinks(out)).toEqual([]);
  });

  it("hides a chain of definitions each redaction brings into effect, past a few passes", () => {
    // Each pass brings the next into effect; past a few, every route naming nothing goes.
    const chain = Array.from({ length: 6 }, (_, i) => `> [ref]: gone-${i}`).join("\n>\n");
    const out = hides(`${chain}\n\n[Shown][ref]`);
    expect(pageLinks(out), out).toEqual([]);
  });

  it("sweeps until nothing changes, and past a few passes once more, liberally", () => {
    const calls: boolean[] = [];
    // A sweep that never settles: each strict pass changes the text.
    const out = untilStable("x", (text, liberal) => {
      calls.push(liberal);
      return liberal ? "settled" : `${text}x`;
    });
    expect(out).toBe("settled");
    expect(calls).toEqual([false, false, false, true]);
    // One that settles stops there.
    expect(untilStable("x", (text) => (text.length < 3 ? `${text}x` : text))).toBe("xxx");
    // The liberal pass fails closed on a route naming nothing that isn't a link.
    const sweep = redactionSweep(from, site, nina);
    expect(sweep("[term]: gone", false)).toBe("[term]: gone");
    expect(sweep("[term]: gone", true)).toBe(RESTRICTED);
  });

  // Code review, round 2, rebutted: link syntax in code isn't a link, but a hidden page's
  // route there goes, as a hidden page's path in code does: a route hides "wherever a
  // destination stands" (security model). The owner's "links only" is about a route
  // mentioned bare (`see /vault`), which stays.
  it("hides a hidden page's route in link syntax inside code, and keeps a bare mention", () => {
    expect(hides("`[Vault](/vault)`")).toContain(RESTRICTED);
    expect(hides("see /vault and /sec/hsm")).toBe("see /vault and /sec/hsm");
  });

  it("sweeps again when a pass changes what the rest means", () => {
    // The fence names a hidden page, so its line goes; then what was code is markdown, and
    // its link, to a route naming nothing, is a link.
    const out = hides("```knowledge/sec/hsm.md\n[Gone](gone)\n```");
    expect(out).not.toMatch(/Gone/);
    expect(pageLinks(out)).toEqual([]);
  });

  // Code review, round 3: probes appended after the text would be code if it ends in a
  // fence it never closes, as redaction can leave it; they go first.
  it("the oracle's label check sees a reference left before a fence that never closes", () => {
    const original = "[HSM]\n\n[HSM]: /sec/hsm\n\n```";
    expect(labelsLeft(original, "[HSM]\n\n```", from, site, nina)).toEqual(["a reference's label shows: [HSM]", 'a reference\'s text shows, on line 1: "[HSM]"']);
    expect(labelsLeft(original, hides(original), from, site, nina)).toEqual([]);
  });

  // Merge gate, PR 53, round 3: the label went, its text stayed, and the label check saw no
  // reference left. A line holding part of one, kept, is a leak.
  it("the oracle sees a full reference's text left on a line of its own", () => {
    const original = "> [HSM rotation [draft]\n> details][ref]\n>\n> [ref]: /sec/hsm";
    const out = `> [HSM rotation [draft]\n> ${RESTRICTED}\n>\n> ${RESTRICTED}`;
    expect(labelsLeft(original, out, from, site, nina)).toEqual(['a reference\'s text shows, on line 1: "> [HSM rotation [draft]"']);
    expect(labelsLeft(original, hides(original), from, site, nina)).toEqual([]);
  });

  // The long fuzz, PR 54: replacing an `<img>` that started an HTML block made the next line,
  // text before, a reference; the original references the label elsewhere. It shows the same.
  it("the oracle's label check leaves a reference redaction made, of a label referenced elsewhere", () => {
    const original = '<img src="x.png" alt="x">\n[runbook][ref]\n\n[ref]: /sec/hsm\n\n[ref]';
    const out = `${RESTRICTED}\n[runbook][ref]\n\n${RESTRICTED}\n\n${RESTRICTED}`;
    expect(labelsLeft(original, out, from, site, nina)).toEqual([]);
    expect(labelsLeft(original, `${RESTRICTED}\n[runbook][ref]\n\n${RESTRICTED}\n\n[ref]`, from, site, nina)).toEqual(["a reference's label shows: [REF]", 'a reference\'s text shows, on line 6: "[ref]"']);
  });

  it("the oracle's text check leaves a line beside a reference, and one that only adds links", () => {
    // `<div>` can interrupt a paragraph and `<qqq>` can't: changed, the next line is a link.
    const original = "Intro words.\n[HSM][ref]\n<div>\n[x][ref]\n\n[ref]: /sec/hsm";
    const out = `Intro words.\n${RESTRICTED}\n<div>\n[x][ref]\n\n${RESTRICTED}`;
    expect(labelsLeft(original, out, from, site, nina)).toEqual([]);
  });

  // Code review, round 9: the round 3 case had it as a definition, but after `\\` the line
  // starts with `\`, so CommonMark reads no definition (its refmap is empty): `[HSM]` was a
  // reference to nothing, text before and after. The line naming the hidden route goes.
  it("takes a line that only looks like a definition, and leaves the text it isn't a reference for", () => {
    const out = hides("> [HSM]\n>\n> \\\\[HSM]: /sec/hsm");
    expect(out).toBe(`> [HSM]\n>\n> ${RESTRICTED}`);
  });

  it("keeps an escaped bracket, which opens no reference, in a quote", () => {
    expect(hides("> Write \\[HSM] literally.\n>\n> [HSM]: /sec/hsm")).toMatch(/^> Write \\\[HSM\] literally\./);
  });

  it("hides a reference before a colon, on a line that can't start a definition", () => {
    // Inside a paragraph, `[HSM]:note` is a reference, not a definition: it goes with its definition.
    expect(hides("See this\n[HSM]:note\n\n[HSM]: /sec/hsm")).not.toMatch(/HSM/);
  });

  it("leaves what follows a hidden link that reads like a definition once redacted", () => {
    expect(hides("[HSM](../sec/hsm.md): how keys rotate")).toBe(`${RESTRICTED}: how keys rotate`);
  });

  it("keeps every route for a caller who can see the page", () => {
    const sam: Identity = { mode: "github", login: "sam", teams: new Set(["security"]), repoAccess: true, canWrite: true };
    for (const text of ["[HSM](/sec/hsm)", "[Keys](/sec/keys)", "[Vault](/vault)", "[Release](/1.0-release)"]) expect(redactLinks(text, from, site, sam)).toBe(text);
  });

  it("reads a relative route from the page's own URL, where its slug puts it", () => {
    // welcome-page.md sits at the root, but its slug serves it at /guides/welcome, so
    // `setup` there is /guides/setup: visible.
    expect(hides("[Setup](setup)", "knowledge/welcome-page.md")).toBe("[Setup](setup)");
    // From its file's directory, `sec/hsm` would be the hidden page; from its URL it names nothing.
    expect(hides("[HSM](sec/hsm)", "knowledge/welcome-page.md")).toContain(RESTRICTED);
    // Review, round 4: guides/moved-src.md is served at /moved/intro, so `secret` is
    // /moved/secret, a hidden page's slug. From its file's directory it names nothing.
    expect(hides("[Secret](secret)", "knowledge/guides/moved-src.md")).toBe(RESTRICTED);
    // A dotted file's stem from its file's directory, where the page's URL reads nothing.
    expect(hides("[Plan](sec/2.0-plan)", "knowledge/welcome-page.md")).toBe(RESTRICTED);
    // A browser clamps `..` at the site's root: the index, visible.
    expect(hides("[Up](../../../..)")).toBe("[Up](../../../..)");
    // Out of the repo and back into its directory: the host's files don't decide, so it
    // names nothing and fails closed.
    expect(hides(`[Up](/../${basename(site.root)}/src)`)).toBe(RESTRICTED);
    // From guides/setup.md, `faq` is guides/faq (visible) or guides/setup/faq (nothing).
    expect(hides("[FAQ](faq)", "knowledge/guides/setup.md")).toBe("[FAQ](faq)");
  });
});

describe("link redaction: full URLs to the docs site (site_url)", () => {
  const config = `${DEFAULT_CONFIG}site_url: https://docs.example.com/docs/\n`;
  const site = makeRepo(
    {
      ...INDEX,
      "knowledge/guides/intro.md": page({ id: "intro", title: "Intro" }),
      "knowledge/handbook-page.md": page({ id: "handbook", title: "Handbook" }),
      "knowledge/sec/hsm.md": page({ id: "hsm", title: "HSM", owner_team: "security", acl: "security" }),
      // Review, round 4: slugs a URL in text would be cut short of.
      "knowledge/sec/v1.md": page({ id: "v1", title: "HSM v1", owner_team: "security", acl: "security", slug: "/handbook(v1)" }),
      "knowledge/sec/v2.md": page({ id: "v2", title: "HSM v2", owner_team: "security", acl: "security", slug: "/handbook_" }),
    },
    { config },
  );
  afterAll(site.cleanup);
  const nina: Identity = { mode: "github", login: "nina", teams: new Set(), repoAccess: true, canWrite: true };
  const from = "knowledge/guides/intro.md";

  it("loads the key", () => expect(site.config.site_url).toBe("https://docs.example.com/docs/"));

  it.each([
    ["a hidden page's URL", "[HSM](https://docs.example.com/docs/sec/hsm)"],
    ["with a trailing slash, a query and a fragment", "[HSM](https://docs.example.com/docs/sec/hsm/?x=1#top)"],
    // Review, round 4: the host and port match exactly; the scheme doesn't (http shows the same route).
    ["in another case, with the default port and a trailing dot", "[HSM](https://Docs.Example.com.:443/docs/sec/hsm)"],
    ["over http", "[HSM](http://docs.example.com/docs/sec/hsm)"],
    ["as an autolink", "<https://docs.example.com/docs/sec/hsm>"],
    ["as a bare URL", "see https://docs.example.com/docs/sec/hsm."],
    ["without a scheme, in text", "see docs.example.com/docs/sec/hsm"],
    ["in code", "run `curl https://docs.example.com/docs/sec/hsm`"],
    ["as a protocol-relative link", "[HSM](//docs.example.com/docs/sec/hsm)"],
    ["as an href", '<a href="https://docs.example.com/docs/sec/hsm">HSM</a>'],
    ["a route on the site naming nothing", "[Gone](https://docs.example.com/docs/guides/gone)"],
    ["an autolink to a slug holding a parenthesis, beside a visible page at the shorter route", "<https://docs.example.com/docs/handbook(v1)>"],
    ["a bare URL to a slug ending in an underscore", "see https://docs.example.com/docs/handbook_ now"],
    // Code review, round 3, rebutted: a URL elsewhere holding the site's URL to a hidden page
    // (an archive's copy) is a link to that page; URLs elsewhere count by the pages they
    // name, as one ending in a hidden page's path does.
    ["another site's URL holding a hidden page's", "[archive](https://web.archive.org/web/2026/https://docs.example.com/docs/sec/hsm)"],
    // Code review, round 4: from every place the site's host starts, not the first only.
    ["another site's URL holding the host twice, then a hidden page's URL", "[archive](https://web.archive.org/web/docs.example.com/https://docs.example.com/docs/sec/hsm)"],
    // Merge gate, PR 53, round 3: userinfo between the scheme and the host.
    ["another site's URL holding the site's with userinfo, over http on port 80", "[archive](https://web.archive.org/web/http://user@docs.example.com:80/docs/sec/hsm)"],
    // Found by the fuzz: an encoded host is the site's to a browser; a paired `)` stays.
    ["another site's URL holding the site's with its host encoded", "see https://web.archive.org/web/2026/https://docs.exampl%65%2Ecom/docs/sec/hsm now"],
    // Code review, round 8: the same with no `//` before it, and with IDNA's dot and a soft hyphen.
    ["another site's URL holding the site's host in fullwidth letters, with no scheme", "[archive](https://web.archive.org/web/\uff44\uff4f\uff43\uff53.example.com/docs/sec/hsm)"],
    ["another site's URL holding the site's host with an ideographic full stop", "see https://web.archive.org/web/docs\u3002example.com/docs/sec/hsm now"],
    ["another site's URL holding the site's host with a soft hyphen", "see https://web.archive.org/web/do\u00adcs.example.com/docs/sec/hsm now"],
    // A host a URL parser maps (fullwidth letters) is the site's to a browser too.
    ["another site's URL holding the site's with its host in fullwidth letters", "see https://web.archive.org/web/2026/https://\uff44\uff4f\uff43\uff53.example.com/docs/sec/hsm now"],
    ["another site's URL holding the site's after encoded slashes", "[x](https://example.com/r/https:%2F%2Fdocs.example.com/docs/sec/hsm)"],
    // Read percent-decoded too, as a hidden page's path is in text.
    ["a hidden page's URL with encoded slashes", "[x](HTTP://Docs.Example.com.:80%2Fdocs/sec%2Fhsm)"],
    // Code review, round 5: an encoded host with no `//` before it.
    ["another site's URL holding the site's host encoded, with no scheme", "[archive](https://web.archive.org/web/docs%2eexample.com/docs/sec/hsm)"],
    // Found by the fuzz: the scheme says the port is its default (http's 80).
    ["a hidden page's URL over http on port 80, after a label", "[ref]:HTTP://Docs.Example.com.:80%2Fdocs/sec/hsm\n[ref]"],
    ["another site's URL holding a hidden slug with parentheses, in a link", "[x](https://web.archive.org/web/2026/https://docs.example.com/docs/handbook(v1))"],
    ["a token holding the site's host more times than it reads", `see ${"docs.example.com/".repeat(10)}x`],
    // Code review, round 6: eight places, each giving three readings, are kept; nine aren't.
    ["another site's URL holding nine of the site's", `[archive](https://archive.example/?${Array.from({ length: 9 }, (_, i) => `u${i}=https://docs.example.com/docs/`).join("&")})`],
    // Every line it spans: the sweep reads a line at a time, a destination across lines.
    ["an href broken across lines", '<a href="https://docs.example.com/docs/sec/\nhsm">HSM</a>'],
    // Found by the fuzz: `\` reaches the href as `%5C`, so the route is `guides\intro`, nothing.
    ["a link to a visible page's route with an escaped backslash", "[HSM](https://docs.example.com/docs/guides&bsol;intro)"],
    ["an autolink to a route naming nothing", "<https://docs.example.com/docs/guides/gone>"],
    // After a scheme a browser can't parse, it's still the site's URL to a reader.
    ["a hidden page's URL after a broken scheme", "see https:%2F/docs.example.com/docs/sec/hsm now"],
  ])("hides %s", (_name, text) => {
    const out = redactLinks(text, from, site, nina);
    expect(out.split("\n").every((l) => l.includes(RESTRICTED))).toBe(true);
    expect(out).not.toMatch(/HSM|Gone/);
  });

  it.each([
    ["a visible page's URL", "[Guide](https://docs.example.com/docs/handbook)"],
    ["another host", "[x](https://other.example.com/docs/sec/hsm)"],
    ["the same host outside the prefix", "[x](https://docs.example.com/blog/sec/hsm)"],
    ["the same host past a near prefix", "[x](https://docs.example.com/docs-archive/sec/hsm) and <https://docs.example.com/docsx>"],
    ["another host under www", "[x](https://www.docs.example.com/docs/sec/hsm)"],
    ["another port", "[x](https://docs.example.com:8443/docs/sec/hsm)"],
    ["a visible page's URL ending a sentence", "see https://docs.example.com/docs/handbook."],
    // An archive's copy of a visible page: a URL elsewhere counts by the page it holds.
    ["another site's URL holding a visible page's", "[archive](https://web.archive.org/web/2026/https://docs.example.com/docs/handbook)"],
    // A bare URL isn't a link to CommonMark, and text can cut one short: only a hidden page's hides it.
    ["a bare URL to a route naming nothing", "see https://docs.example.com/docs/guides/gone now"],
    ["a URL cut at markup that shows whole", "see [//docs.example.com/docs/guides/in](#x)tro now"],
    ["a footnote holding a URL to a route naming nothing", "Yearly.[^1]\n\n[^1]: https://docs.example.com/docs/guides/gone and more"],
    ["another site's URL holding eight of the site's", `[archive](https://archive.example/?${Array.from({ length: 8 }, (_, i) => `u${i}=https://docs.example.com/docs/`).join("&")})`],
    ["an attachment on the site", "![x](https://docs.example.com/docs/img/a.png)"],
  ])("keeps %s", (_name, text) => {
    expect(redactLinks(text, from, site, nina)).toBe(text);
  });

  // The URL sweep takes the line a definition's destination stands on, the line after its
  // label: the definition goes, and its reference with it (found by the fuzz, round 3).
  it("hides a reference whose definition's destination, on the next line, the URL sweep takes", () => {
    const out = redactLinks("[HSM]\n\n[HSM]:\nhttps:%2F/docs.example.com/docs/sec/hsm", from, site, nina);
    expect(out).not.toMatch(/HSM/);
  });

  // Code review, round 4: the oracle missed the same; this is its positive control.
  it("the oracle reads a site URL from every place the host starts", () => {
    expect(leaks("[archive](https://web.archive.org/web/docs.example.com/https://docs.example.com/docs/sec/hsm)", from, site, nina)).not.toEqual([]);
  });

  // Found by the fuzz: in a raw HTML block a backslash escapes nothing, but a reader sees the
  // route (`broken\-route` as `broken-route`, a page that didn't load).
  it("hides a site URL to a hidden route written with an escape, in a raw HTML block", () => {
    const broken = makeRepo(
      { ...INDEX, "knowledge/broken-route.md": "---\ntitle: Broken\nslug: /broken-route\n---\nNo valid frontmatter.\n" },
      { config: `${DEFAULT_CONFIG}site_url: https://docs.example.com/docs/\n` },
    );
    try {
      const text = '<img src="x.png" alt="x">\n*[see](https://web.archive.org/web/\uff44\uff4f\uff43\uff53.example.com/docs/broken\\-route)*';
      expect(redactLinks(text, "knowledge/index.md", broken, nina)).toBe(`<img src="x.png" alt="x">\n${RESTRICTED}`);
    } finally {
      broken.cleanup();
    }
  });

  // Code review, round 7: an IPv6 host's brackets were read as a regex's class.
  it("reads a site_url on an IPv6 host", () => {
    const host = "[1111:1111:1111:1111:1111:1111:1111:1111]";
    const v6 = makeRepo(
      {
        ...INDEX,
        "knowledge/handbook-page.md": page({ id: "handbook", title: "Handbook" }),
        "knowledge/sec/hsm.md": page({ id: "hsm", title: "HSM", owner_team: "security", acl: "security" }),
      },
      { config: `${DEFAULT_CONFIG}site_url: http://${host}/docs/\n` },
    );
    try {
      expect(redactLinks(`[Guide](http://${host}/docs/handbook)`, "knowledge/index.md", v6, nina)).toBe(`[Guide](http://${host}/docs/handbook)`);
      // As a class, `[1111:…]` matched each `1` after a `=`: nine places, past the cap.
      const query = `[Guide](http://${host}/docs/handbook?${"abcdefghi".split("").map((k) => `${k}=1`).join("&")})`;
      expect(redactLinks(query, "knowledge/index.md", v6, nina)).toBe(query);
      expect(redactLinks(`[HSM](http://${host}/docs/sec/hsm)`, "knowledge/index.md", v6, nina)).toBe(RESTRICTED);
    } finally {
      v6.cleanup();
    }
  });

  it.each([
    ["ftp://docs.example.com/docs/", /http or https/],
    ["https://user:pw@docs.example.com/docs/", /no credentials, query or fragment/],
    ["https://docs.example.com/docs/?x=1", /no credentials, query or fragment/],
    ["docs.example.com/docs/", /site_url/],
  ])("refuses site_url %s", (url, message) => {
    expect(() => ConfigSchema.parse({ github: { org: "acme" }, site_url: url })).toThrow(message);
  });
});

describe("link redaction: where a reference starts", () => {
  it("keeps a visible page whose path ends with a hidden page's repo path", () => {
    // Review, round 4: `archive/knowledge/security/x.md` holds the hidden
    // `knowledge/security/x.md` whole; the link resolves to the visible page.
    const copy = copyAcme();
    try {
      const page = join(copy.root, "knowledge/archive/knowledge/security/rotate-db-credentials.md");
      mkdirSync(dirname(page), { recursive: true });
      writeFileSync(page, readFileSync(join(copy.root, "knowledge/glossary.md"), "utf8").replace("id: glossary", "id: archived"));
      const deep = loadRepo(copy.root);
      for (const text of [
        "[a [b] c](archive/knowledge/security/rotate-db-credentials.md)",
        "<img src=\"https://github.com/acme/knowledge/blob/main/knowledge/archive/knowledge/security/rotate-db-credentials.md\">",
      ])
        expect(redactLinks(text, "knowledge/index.md", deep, LOCAL_IDENTITY)).toBe(text);
    } finally {
      copy.cleanup();
    }
  });

  it("tells a file name with an underscore from one without", () => {
    // Review, round 5: between letters an underscore is never emphasis, so the rendered
    // reading keeps it, and a visible `on_call.md` isn't a hidden `oncall.md`.
    const copy = copyAcme();
    try {
      const glossary = readFileSync(join(copy.root, "knowledge/glossary.md"), "utf8");
      writeFileSync(join(copy.root, "knowledge/runbooks/on_call.md"), glossary.replace("id: glossary", "id: on-call-visible"));
      writeFileSync(join(copy.root, "knowledge/runbooks/oncall.md"), glossary.replace("id: glossary", "id: on-call-hidden").replace(/^---\n/, "---\nacl: security\n"));
      writeFileSync(join(copy.root, "knowledge/runbooks/_oncall.md"), glossary.replace("id: glossary", "id: on-call-draft"));
      const both = loadRepo(copy.root);
      expect(both.byId.get("on-call-hidden")?.acl).toBe("security");
      // Review, round 7: a lone `_` isn't emphasis either; it shows as written.
      for (const text of ["[a [b] c](on_call.md)", "see on_call.md and runbooks/on_call.md", "[knowledge/runbooks/_oncall.md](_oncall.md)"]) expect(redactLinks(text, FROM, both, LOCAL_IDENTITY)).toBe(text);
      expect(redactLinks("[a [b] c](oncall.md)", FROM, both, LOCAL_IDENTITY)).toBe(RESTRICTED);
    } finally {
      copy.cleanup();
    }
  });

  it("doesn't read two links joined across a blank line as one URL", () => {
    // Joined, `…/index.md "title"` and `[x](team space/…)` would make a "URL" ending with
    // `security/rotate-db-credentials.md`; the link is to the visible team space page.
    const text = '[ref]: https://github.com/acme/knowledge/blob/main/knowledge/index.md "title"\n\n[x](\nteam%20space/security/rotate-db-credentials.md\n)';
    expect(redactLinks(text, "knowledge/glossary.md", repo, LOCAL_IDENTITY)).toBe(text);
  });

  it("reads a path that starts at a page's own directory as that directory's page", () => {
    // `security/rotate-db-credentials.md` is a hidden page's path under the root, and from
    // inside `team space/` it's the visible `team space/security/rotate-db-credentials.md`.
    const text = "[a [b] c](security/rotate-db-credentials.md)";
    expect(redactLinks(text, "knowledge/team space/plans.md", repo, LOCAL_IDENTITY)).toBe(text);
    expect(redactLinks(text, "knowledge/glossary.md", repo, LOCAL_IDENTITY)).toBe(RESTRICTED);
  });

  it("doesn't let a start inside a URL that resolves to a visible page speak for the URL", () => {
    // Review, round 2. After the port's `:` the rest resolves, from runbooks/, to a visible
    // page; the URL itself, `public/..` normalized, is the hidden page.
    const copy = copyAcme();
    try {
      const page = join(copy.root, "knowledge/runbooks/443/acme/knowledge/blob/main/knowledge/security/rotate-db-credentials.md");
      mkdirSync(dirname(page), { recursive: true });
      writeFileSync(page, readFileSync(join(copy.root, "knowledge/glossary.md"), "utf8").replace("id: glossary", "id: deep-copy"));
      const deep = loadRepo(copy.root);
      expect(deep.byId.get("deep-copy")?.acl).toBe("internal");
      const text = '<img src="https://github.com:443/acme/knowledge/blob/main/knowledge/public/../security/rotate-db-credentials.md">';
      expect(leaks(text, FROM, deep, LOCAL_IDENTITY)).not.toEqual([]);
      expect(redactLinks(text, FROM, deep, LOCAL_IDENTITY)).toBe(RESTRICTED);
      // And as a bare URL in text, which only the name sweep reads.
      const bare = "see https://github.com:443/acme/knowledge/blob/main/knowledge/public/../security/rotate-db-credentials.md now";
      expect(redactLinks(bare, FROM, deep, LOCAL_IDENTITY)).toBe(RESTRICTED);
    } finally {
      copy.cleanup();
    }
  });

  it("reads a hidden page's path spelled out in text, with more spaces than it reads back by", () => {
    const text = "see a b c d/notes.md for it";
    expect(leaks(text, "knowledge/glossary.md", repo, LOCAL_IDENTITY)).not.toEqual([]);
    expect(redactLinks(text, "knowledge/glossary.md", repo, LOCAL_IDENTITY)).toBe(RESTRICTED);
  });

  it("reads a path that enters a directory with a space and leaves it again", () => {
    // Review, round 6: `..` cancels `scratch folder`, a directory of the path's own, not
    // junk a start one character early leaves in front. (The oracle reads text paths
    // only up to a space, so this one is asserted directly.)
    // The hidden page is root-level, so no path under the root names it from its tail.
    const text = "see `../scratch folder/../team-secret.md` first";
    expect(redactLinks(text, FROM, repo, LOCAL_IDENTITY)).toBe(RESTRICTED);
  });

  it("reads a hidden page's path from this page's directory, spelled out in text", () => {
    // Review, round 3: three spaces, and neither its repo path nor its path under the
    // root (`runbooks/a b c d/secret.md`) is in the text.
    const text = "See a b c d/secret.md before you start";
    expect(leaks(text, FROM, repo, LOCAL_IDENTITY)).not.toEqual([]);
    expect(redactLinks(text, FROM, repo, LOCAL_IDENTITY)).toBe(RESTRICTED);
  });

  it("reads a path with spaces wrapped at one of them as a reader does: whole", () => {
    // A soft line break renders as a space, in a paragraph, a quote or a code span.
    for (const [text, out] of [
      ["See a b\nc d/secret.md first", `${RESTRICTED}\n${RESTRICTED}`],
      ["> See a b\n> c d/secret.md first", `> ${RESTRICTED}\n> ${RESTRICTED}`],
      ["Run `cat a b c\nd/secret.md` first", `${RESTRICTED}\n${RESTRICTED}`],
      // The same through the full reader, which an `&` anywhere in the text selects.
      ["See a b\nc d/secret.md &amp; more", `${RESTRICTED}\n${RESTRICTED}`],
    ]) expect(redactLinks(text!, FROM, repo, LOCAL_IDENTITY)).toBe(out);
  });

  it("reads a non-ASCII name broken across lines as one, in text with nothing to decode", () => {
    const text = '<a href="../security/日\n本.md">x</a>';
    expect(leaks(text, FROM, repo, LOCAL_IDENTITY)).not.toEqual([]);
    expect(redactLinks(text, FROM, repo, LOCAL_IDENTITY)).toBe(`${RESTRICTED}\n${RESTRICTED}`);
  });

  it("reads a path from right after a curly quote or a no-break space", () => {
    for (const text of ["see \u201c../team-secret.md\u201d now", "see\u00a0../team-secret.md now"]) expect(redactLinks(text, FROM, repo, LOCAL_IDENTITY)).toBe(RESTRICTED);
  });
});

describe("link redaction: what goes", () => {
  it("a common link alone, in place", () => {
    expect(redactLinks(`before [x](${R}) after`, FROM, repo, LOCAL_IDENTITY)).toBe(`before ${RESTRICTED} after`);
  });

  it("a line in another form whole, keeping its quote and list markers", () => {
    const text = `first line\n> - see [a [b] c](${R}) and more\nlast line`;
    expect(redactLinks(text, FROM, repo, LOCAL_IDENTITY)).toBe(`first line\n> - ${RESTRICTED}\nlast line`);
  });

  it("every line a value spans", () => {
    expect(redactLinks(`<a href="../security/rotate-db-\ncredentials.md">x</a>\nnext`, FROM, repo, LOCAL_IDENTITY)).toBe(`${RESTRICTED}\n${RESTRICTED}\nnext`);
  });
});

describe("the sweep's own reading", () => {
  it("decodes exactly the named references that stand for ASCII, as the `entities` package does", () => {
    const named = createRequire(import.meta.url)("entities/lib/maps/entities.json") as Record<string, string>;
    const ascii = Object.entries(named)
      .filter(([, v]) => /[\x00-\x7f]/.test(v))
      .map(([k, v]) => [k, v.replace(/[^\x00-\x7f]/g, "\u001a")]);
    expect(ASCII_REFERENCES).toEqual(Object.fromEntries(ascii));
  });

  it("drops exactly the named references that stand for invisible characters, as the `entities` package says", () => {
    const named = createRequire(import.meta.url)("entities/lib/maps/entities.json") as Record<string, string>;
    const invisible = Object.entries(named).filter(([, v]) => [...v].every((c) => /\p{Cf}/u.test(c))).map(([k]) => k);
    expect([...INVISIBLE_REFERENCES].sort()).toEqual(invisible.sort());
  });

  it("reads a text with nothing to decode as it reads the same text decoded", () => {
    // Text with no `&`, `%` or `\` takes a faster path. Appending a line holding `&` forces
    // the full reading, and that line can name nothing.
    const names = pageNames(repo, (p) => !canSee(p, LOCAL_IDENTITY));
    const r = rng(7);
    const targets = [...repo.pages.map((p) => p.path), ...repo.invalid.map((p) => p.path)];
    let named = 0;
    for (let i = 0; i < 1500; i++) {
      const from = repo.pages[Math.floor(r() * repo.pages.length)]!.path;
      const text = body(r, from, targets, "knowledge").replace(/[&%\\]/g, "");
      const fast = [...namingLines(text, from, names)];
      expect(fast, text).toEqual([...namingLines(`${text}\n&`, from, names)]);
      if (fast.length) named++;
    }
    expect(named).toBeGreaterThan(200);
  });
});

describe("link redaction: input size", () => {
  const N = 64 * 1024;
  const fill = (unit: string) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  const best = (text: string) => {
    let ms = Infinity;
    for (let i = 0; i < 3 && ms >= 50; i++) {
      const t0 = performance.now();
      redactLinks(text, FROM, repo, LOCAL_IDENTITY);
      ms = Math.min(ms, performance.now() - t0);
    }
    return ms;
  };
  it.each([
    ["hidden names everywhere", fill("index.md ")],
    ["hidden names with no space", fill("/index.md")],
    ["delimiters before a name", `${fill("a(")}../security/index.md`],
    ["delimiters between names", fill("a(index.md")],
    ["a long run before a name", `${fill("abcdefgh")}/index.md`],
    ["quotes before a name", `${fill("\"' <")}x/index.md`],
    ["quotes on every line", `${fill('"\n')}x/index.md`],
    ["references", fill("&#46;&period;%2E\\.")],
    ["encoded names", fill("&#47;index&#46;md")],
    ["names on every line in containers", fill("> - 1. index.md\n")],
    // Main's own link regexes scanned from each `[` to the end of the text: 1.1 s here.
    ["brackets that never close", fill("[a")],
    ["anchors that never close", fill('<a href="x">')],
    ["markup that never pairs", fill("*a _b `c ~d ")],
    // A run of markers was retried at every shorter length: 1.7 s.
    ["a line of backticks", fill("`")],
    ["a line of asterisks and tildes", fill("*~")],
    // Comments and the like are removed unbounded, so each must be found in linear time.
    ["comments that never close", fill("<!--a ")],
    ["processing instructions and declarations that never close", fill("<?a <!a ")],
    // Each ends sooner in a browser, so each looks for the one CommonMark end far away.
    ["comments a browser ends at `--!>`, closed at the end", `${fill("<!--a--!>")}-->`],
    ["processing instructions a browser ends at `>`, closed at the end", `${fill("<?a>")}?>`],
    ["CDATA a browser ends at `>`, closed at the end", `${fill("<![CDATA[]]a>")}]]>`],
    ["tags whose quoted values never close", fill('<a x="')],
    ["tags with many attributes that never close", fill("<a b c d e f g h ")],
    // Every place a destination stands is read, each no further than the next of its kind.
    ["link destinations that never end", fill("](a")],
    ["definitions that never end", fill("]:a")],
    ["angle destinations that never close", fill("](<a")],
    ["lone tags, each starting a raw HTML block", fill('<a href="x">\n')],
    ["values broken across lines in a raw HTML block", `<p>\n${fill('<a href="\n> ')}`],
    ["tags only a browser takes, in a raw HTML block", `<div>\n${fill('<a "x" href=y ')}`],
    // A GitHub URL into the repo is read once, and only so many ways.
    ["repo URLs run together", fill("https://github.com/acme/knowledge/")],
    ["repo hosts run together", fill("github.com:443/")],
    // Each srcdoc is read as a document of its own.
    ["iframes with a srcdoc each", fill('<iframe srcdoc="x <b>y</b>"></iframe>')],
    ["iframes with a srcdoc each, on one line in a quote", fill('> <iframe srcdoc="a&amp;b">')],
    // And nested: each level would read its document again.
    ["a srcdoc nested 40 deep", (() => {
      let doc = "x";
      for (let i = 0; i < 40; i++) doc = `<iframe srcdoc="${doc.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe>`;
      return fill(`${doc}\n`);
    })()],
    ["a repo URL with the root in it at every step", `https://github.com/acme/knowledge/blob/${fill("knowledge/")}x.md`],
    ["a browser's tag whose quoted value never closes", `<div>\n<a href="${fill("<b ")}`],
  ])("%s, at 64 KB: under 250 ms, or within 10× of prose", (what, text) => {
    // A check for superlinear time, not for constant factors: with the reach cap lifted
    // and nothing memoized these take minutes. Below 250 ms the ratio isn't asserted, because
    // timer noise on a loaded CI runner moves a few milliseconds by multiples.
    const hostile = best(text);
    if (hostile < 250) return;
    const benign = best(fill(`Some prose about deploys, with a [link](${"deploy-production.md"}) & 50% more.\n`));
    expect(hostile, `${what}: ${Math.round(hostile)} ms against ${Math.round(benign)} ms`).toBeLessThan(Math.max(250, 10 * benign));
  });

  // At 64 KB a quadratic pass can still finish under 250 ms (a definition's label looked up
  // backwards took 234 ms there, and 2.9 s at 256 KB): so at 256 KB, against a bound a linear
  // pass meets many times over (about 0.25 s here). A slow CI runner under the suite's load
  // took a linear pass to 2 s (public main, 2026-11-14), so past the bound it's held against
  // prose of the same size on the same runner, as at 64 KB: about 3× when linear.
  it.each([
    ["definitions that never end", "]:a"],
    ["definitions after a bracket", "[x]:a "],
  ])("%s, at 256 KB: under 1.5 s, or within 10× of prose", (what, unit) => {
    const size = (u: string) => u.repeat(Math.ceil((4 * N) / u.length)).slice(0, 4 * N);
    const hostile = best(size(unit));
    if (hostile < 1500) return;
    const benign = best(size(`Some prose about deploys, with a [link](${"deploy-production.md"}) & 50% more.\n`));
    expect(hostile, `${what}: ${Math.round(hostile)} ms against ${Math.round(benign)} ms`).toBeLessThan(10 * benign);
  });

  // Code review, round 6: each reference's paragraph was looked up among all of them. At
  // 1 MB that took 6.6× as long as prose of that size; indexed, 1.6× alone and up to 3.1×
  // under the full suite's load. Against prose on the same machine, so a slow runner moves both.
  // Its time isn't the check: six 1 MB redactions take about 4.6 s here and 13.5–16.6 s on CI,
  // and a slow runner took the public repo's main past the default 20 s before the ratio ran.
  it("references to many definitions that go, at 1 MB: within 4.5× of prose", () => {
    let text = "";
    for (let i = 0; text.length < 16 * N; i++) text += `> [l${i}]: ../security/rotate-db-credentials.md\n\n[l${i}]\n\n`;
    const prose = "Some prose about deploys, with a [link](deploy-production.md) & 50% more.\n".repeat(Math.ceil((16 * N) / 74));
    const hostile = best(text);
    const benign = best(prose);
    expect(hostile, `${Math.round(hostile)} ms against ${Math.round(benign)} ms`).toBeLessThan(4.5 * benign);
  }, 60_000);

  // Each place a host can start is parsed only up to where an authority ends and DNS allows.
  it("a URL whose path holds parentheses before letters not in ASCII, at 256 KB: under 1.5 s", () => {
    const site = makeRepo({ ...INDEX }, { config: `${DEFAULT_CONFIG}site_url: https://docs.example.com/docs/\n` });
    try {
      const text = `see https://x.example/${"(\uff44".repeat(2 * N)}`;
      const t0 = performance.now();
      redactLinks(text, FROM, site, LOCAL_IDENTITY);
      expect(performance.now() - t0).toBeLessThan(1500);
    } finally {
      site.cleanup();
    }
  });

  // Merge gate, PR 53, round 2: finding a token the text doesn't hold, one `q` at a time.
  it("a long run like the token, before a reference whose definition goes, at 256 KB: under 1.5 s", () => {
    const text = `z${"q".repeat(4 * N)}\n\n[x]\n\n> [x]: ../security/rotate-db-credentials.md`;
    expect(best(text)).toBeLessThan(1500);
  });

  // Code review, round 5: a URL's unpaired `)`s cut one at a time took 7 s at 16 K.
  it("a site URL followed by closing parentheses, at 256 KB: under 1.5 s", () => {
    const site = makeRepo({ ...INDEX }, { config: `${DEFAULT_CONFIG}site_url: https://docs.example.com/docs/\n` });
    try {
      const text = `see https://docs.example.com/docs/handbook${")".repeat(4 * N)}`;
      const t0 = performance.now();
      redactLinks(text, FROM, site, LOCAL_IDENTITY);
      expect(performance.now() - t0).toBeLessThan(1500);
    } finally {
      site.cleanup();
    }
  });
});

describe("page loading: input size", () => {
  it("reads a page's links in linear time", () => {
    // `extractLinks` runs on every page load; `![` repeated was quadratic there too.
    const N = 64 * 1024;
    const best = (text: string) => {
      let ms = Infinity;
      for (let i = 0; i < 3 && ms >= 50; i++) {
        const t0 = performance.now();
        extractLinks(text);
        ms = Math.min(ms, performance.now() - t0);
      }
      return ms;
    };
    const benign = best("See [the runbook](deploy-production.md) first.\n".repeat(N / 46));
    // And titles that never close: one in parentheses ran to the end of the page (228 ms).
    for (const unit of ["[a", "![", "[a](", "[x]: ", "[a](b (", `[a](b '[a](b "`, "[a](<"]) {
      const hostile = best(unit.repeat(N / unit.length));
      expect(hostile, `${JSON.stringify(unit)}: ${Math.round(hostile)} ms against ${Math.round(benign)} ms`).toBeLessThan(Math.max(250, 10 * benign));
    }
  });

  it("reads a link however long its text, destination or title", () => {
    // Merge gate, PR 13: bounds of 999 and 2,000 characters made long links vanish from
    // lint's view; main had none, and CommonMark bounds only a definition's label.
    const long = "a".repeat(5000);
    expect(extractLinks(`[${long}](x.md)`)).toEqual(["x.md"]);
    expect(extractLinks(`[a](${long}.md)`)).toEqual([`${long}.md`]);
    expect(extractLinks(`[a](<${long} b.md>)`)).toEqual([`${long} b.md`]);
    expect(extractLinks(`[a](x.md "${long}")`)).toEqual(["x.md"]);
    expect(extractLinks(`[a](x.md (${long} \\(b\\)))`)).toEqual(["x.md"]);
    expect(extractLinks(`[r]: ${long}.md "${long}"`)).toEqual([`${long}.md`]);
  });
});

describe("read: supersedes", () => {
  const copy = copyAcme();
  afterAll(copy.cleanup);
  const glossary = join(copy.root, "knowledge/glossary.md");
  writeFileSync(glossary, readFileSync(glossary, "utf8").replace(/^---\n/, "---\nsupersedes: [rb-rotate-db-creds, rb-deploy-legacy, zz-unknown, broken-one]\n"));
  writeFileSync(join(copy.root, "knowledge/runbooks/broken.md"), "---\ntitle: Broken\nid: broken-one\n---\nNo valid frontmatter.\n");
  const read = async (who: Identity) => {
    const page = await new KnowledgeService(copy.root, { get: async () => who, fresh: async () => who, github: null }, () => NOW).read({ id: "glossary" });
    return page as { supersedes: string[] };
  };

  it("lists only pages the caller could look up", async () => {
    expect(loadRepo(copy.root).byId.get("glossary")?.supersedes).toContain("rb-rotate-db-creds");
    expect((await read(LOCAL_IDENTITY)).supersedes).toEqual(["rb-deploy-legacy", "zz-unknown"]);
    const sam: Identity = { mode: "github", login: "sam", teams: new Set(["security"]), repoAccess: true, canWrite: true };
    expect((await read(sam)).supersedes).toEqual(["rb-rotate-db-creds", "rb-deploy-legacy", "zz-unknown"]);
  });

  it("can't name a mirrored page: a page that tries doesn't load, so nothing of it is served", async () => {
    // Merge gate, PR 13, round 8: the filter reads repo pages only. A mirror id holds `:`,
    // which a canonical id can't, so `supersedes` can't hold one (schema.ts `ID`).
    const parsed = parsePage("knowledge/x.md", readFileSync(glossary, "utf8").replace(/^supersedes: .*$/m, "supersedes: [mirror:confluence:SEC:900]"));
    expect(isPage(parsed)).toBe(false);
    expect((parsed as InvalidPage).issues.map((i) => i.field)).toEqual(["supersedes"]);
  });
});

describe("mirrored pages: links to repo pages", () => {
  it("redacts a wiki page's URL to a repo page the reader can't see, and keeps one they can", async () => {
    const acme = acmeOnGitHub();
    try {
      const page = mirrorPage("ENG", "301", "Old rotation notes", `Rotate with [the runbook](${URL}), after [the index](https://github.com/acme/knowledge/blob/main/knowledge/index.md).`, { owner_team: "platform" });
      await writeMirror(acme.root, { ENG: [page] });
      serveMirror(acme.root);
      const as = (teams: string[]) => {
        const who: Identity = { mode: "github", login: "x", teams: new Set(teams), repoAccess: true, canWrite: true };
        return new KnowledgeService(acme.root, { get: async () => who, fresh: async () => who, github: null }, () => NOW);
      };
      const pat = await as(["platform"]).read({ id: page.id });
      expect(pat.content).toBe(`Rotate with ${RESTRICTED}, after [the index](https://github.com/acme/knowledge/blob/main/knowledge/index.md).`);
      const found = await as(["platform"]).search({ query: "rotate runbook old rotation notes" });
      expect(found.mirrored?.map((m) => m.id)).toEqual([page.id]);
      expect(JSON.stringify(found)).not.toContain("rotate-db-credentials");
      expect((await as(["security"]).read({ id: page.id })).content).toBe(page.markdown);
    } finally {
      acme.cleanup();
    }
  });
});
