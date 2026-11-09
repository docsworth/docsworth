import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canSee, type Identity, RESTRICTED, redactLinks } from "../src/core/acl.js";
import { LOCAL_IDENTITY } from "../src/core/identity.js";
import { ASCII_REFERENCES, INVISIBLE_REFERENCES, namingLines, pageNames } from "../src/core/references.js";
import { extractLinks, type InvalidPage, isPage, loadRepo, parsePage } from "../src/core/repo.js";
import { KnowledgeService } from "../src/core/service.js";
import { body, leaks, rng } from "./acl-oracle.js";
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

describe("link redaction: a link to a visible page stays as written", () => {
  it.each(VISIBLE)("%s", (_name, from, text) => {
    expect(redactLinks(text, from, repo, LOCAL_IDENTITY)).toBe(text);
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
