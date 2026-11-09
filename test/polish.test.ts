import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { GitHubClient } from "../src/core/github.js";
import { IdentityProvider } from "../src/core/identity.js";
import { NEGATIONS, POLISH_MAX_CHARS, polishChanges, polishSummary } from "../src/core/polish.js";
import { replaceBody } from "../src/core/writes.js";
import { loadRepo } from "../src/core/repo.js";
import { KnowledgeService } from "../src/core/service.js";
import { FakeGitHub } from "./fake-github.js";
import { ACME, acmeOnGitHub, NOW } from "./helpers.js";
import { ALL_SPACES, SEC_PAGE, serveMirror, writeMirror } from "./mirror-helpers.js";

const PAGE = `---
id: rb-x
title: X
---
# Restart the queue

Wait 5 minutes before you restart. Never restart both
replicas at once, and do not skip the drain.

Run \`queue drain --all\` first. See [the dashboard](https://grafana.example.com/d/queue) and [Rollback](rollback.md).

\`\`\`sh
queue restart --replica 1
\`\`\`

1. Retry up to 3 times.
2. Page #oncall if it still fails.
`;

// A real polish: rewrapped, reordered, emphasis added, prose tightened, steps renumbered.
const POLISHED = `---
id: rb-x
title: X
---
# Restart the queue

## Steps

1. Run \`queue drain --all\` first, and do not skip the drain.
2. Wait **5 minutes** before you restart.
3. Never restart both replicas at once.

\`\`\`sh
queue restart --replica 1
\`\`\`

- Retry up to 3 times.
- Page #oncall if it still fails.

See [the dashboard](https://grafana.example.com/d/queue) and [Rollback](rollback.md).
`;

describe("polish guard: each class", () => {
  it("passes a real polish: rewrapped, reordered, emphasis, renumbered", () => {
    expect(polishChanges(PAGE, POLISHED)).toEqual([]);
  });

  it.each([
    ["frontmatter", POLISHED.replace("title: X", "title: X "), /changed the frontmatter/],
    ["a fenced block", POLISHED.replace("--replica 1", "--replica 2"), /changed a code block/],
    ["inline code", POLISHED.replace("queue drain --all", "queue drain"), /removed inline code `queue drain --all`[\s\S]*added inline code `queue drain`/],
    ["a link target", POLISHED.replace("(rollback.md)", "(rollback-v2.md)"), /removed link `rollback.md`/],
    ["a link's URL", POLISHED.replace("d/queue", "d/queues"), /removed link `https:\/\/grafana.example.com\/d\/queue`/],
    ["a number", POLISHED.replace("**5 minutes**", "**10 minutes**"), /removed number `5 minutes`[\s\S]*added number `10 minutes`/],
    ["a number's unit", POLISHED.replace("**5 minutes**", "**5 seconds**"), /removed number `5 minutes`/],
    ["a dropped negation", POLISHED.replace("do not skip", "skip"), /"not" appears \(1 → 0\)/],
    ["an added modal", POLISHED.replace("Wait", "You should wait"), /"should" appears \(0 → 1\)/],
  ])("refuses a changed %s, naming it", (_label, after, message) => {
    const changes = polishChanges(PAGE, after);
    expect(changes.join("; ")).toMatch(message);
  });

  it("catches two numbers swapped between their units", () => {
    const swapped = PAGE.replace("Wait 5 minutes", "Wait 3 minutes").replace("up to 3 times", "up to 5 times");
    expect(polishChanges(PAGE, swapped)).toEqual(expect.arrayContaining(["removed number `5 minutes`", "added number `3 minutes`"]));
  });

  it("catches a reordered pair of fenced blocks", () => {
    const two = "---\nid: a\n---\n```\none\n```\n\n```\ntwo\n```\n";
    expect(polishChanges(two, "---\nid: a\n---\n```\ntwo\n```\n\n```\none\n```\n")).toEqual(["changed the order of the page's code (commands keep their order; move only sections that have none)"]);
  });

  it("does not pair a number with a word across a paragraph or list item", () => {
    const a = "---\nid: a\n---\nKeep 3\n\nreplicas.\n\n1. wait 30\n2. restart\n";
    const b = "---\nid: a\n---\n1. wait 30\n2. restart\n\nKeep 3\n\nreplicas.\n";
    expect(polishChanges(a, b)).toEqual([]);
  });

  it("summarises what it compared", () => {
    expect(polishSummary(PAGE)).toBe("1 code block(s), 1 inline code span(s), 2 link(s), 0 URL(s) and 2 number(s) unchanged; frontmatter identical");
  });
});

// Review round 1 (Codex): each was a real miss or a false reject in the first version.
const fm = "---\nid: a\n---\n";
describe("polish guard: markdown forms", () => {
  it.each([
    ["a reference link pointed at another definition", "[run][prod]\n\n[prod]: prod.md\n[safe]: safe.md\n", "[run][safe]\n\n[prod]: prod.md\n[safe]: safe.md\n", /removed link `prod.md`[\s\S]*added link `safe.md`/],
    ["a collapsed reference changed", "[prod][]\n\n[prod]: prod.md\n", "[prod][]\n\n[prod]: staging.md\n", /removed link `prod.md`/],
    ["a shortcut reference's definition changed", "See [prod].\n\n[prod]: prod.md\n", "See [prod].\n\n[prod]: staging.md\n", /removed link `prod.md`/],
    ["a target with parentheses", "[run](docs/a(b).md)\n", "[run](docs/a(b).txt)\n", /removed link `docs\/a\(b\).md`/],
    ["a fence closed by a longer fence", "```sh\nkubectl delete pod production\n````\n", "```sh\nkubectl delete pod staging\n````\n", /changed a code block/],
    ["a tilde fence", "~~~\nrm -rf /tmp/cache\n~~~\n", "~~~\nrm -rf /tmp\n~~~\n", /changed a code block/],
    ["an indented fence", "1. Run:\n   ```\n   make deploy\n   ```\n", "1. Run:\n   ```\n   make destroy\n   ```\n", /changed a code block/],
    ["an unclosed fence", "```\nmake deploy\n", "```\nmake destroy\n", /changed a code block/],
    ["a sign", "Set the offset to -5 minutes.\n", "Set the offset to +5 minutes.\n", /removed number `-5 minutes`[\s\S]*added number `\+5 minutes`/],
    ["a struck-through instruction", "You must restart the primary.\n", "You ~~must restart the primary~~.\n", /added struck-through text `must restart the primary`/],
    ["a double-backtick code span", "Run ``echo `id` `` first.\n", "Run ``echo `whoami` `` first.\n", /removed inline code/],
    // Review round 2.
    ["a code span that wraps a line", "Run `deploy\n--prod` now.\n", "Run `deploy\n--staging` now.\n", /removed inline code `deploy --prod`/],
    ["a target nested three parentheses deep", "[run](docs/a(b(c(d)e)f).md)\n", "[run](docs/evil(b(c(d)e)f).md)\n", /removed link `docs\/a\(b\(c\(d\)e\)f\).md`/],
    ["a unit that is link text", "Wait 5 [minutes](units.md).\n", "Wait 5 [seconds](units.md).\n", /removed number `5 minutes`[\s\S]*added number `5 seconds`/],
    ["an escaped parenthesis in a target", "[run](docs/a\\(1.md)\n", "[run](docs/a\\(2.md)\n", /removed link/],
    ["a footnote's text", "Drain it first.[^1]\n\n[^1]: Do not skip this.\n", "Drain it first.[^1]\n\n[^1]: Skip this if busy.\n", /"not" appears \(1 → 0\)/],
    ["a dropped didn't", "It didn't work, so restart.\n", "It did work, so restart.\n", /"n't" appears \(1 → 0\)/],
    ["a task box ticked", "- [ ] Drain the node\n- [x] Cordon it\n", "- [x] Drain the node\n- [x] Cordon it\n", /removed task `\[ \] drain the node`[\s\S]*added task `\[x\] drain the node`/i],
    ["two commands trading steps", "## Steps\n\n1. Run `drain node-1`.\n2. Run `delete node-1`.\n", "## Steps\n\n1. Run `delete node-1`.\n2. Run `drain node-1`.\n", /^changed the order of the page's code/],
    ["a command moved to another section", "## Steps\n\nRun `drain node-1`.\n\n## Rollback\n\nRun `uncordon node-1`.\n", "## Steps\n\nRun `uncordon node-1`.\n\n## Rollback\n\nRun `drain node-1`.\n", /^changed the order of the page's code/],
    ["a fenced block moved to another section", "## Steps\n\n```\nmake deploy\n```\n\n## Rollback\n\nUndo it.\n", "## Steps\n\nDeploy it.\n\n## Rollback\n\n```\nmake deploy\n```\n", /moved code into or out of the "steps" section/i],
    // Merge gate, PR 3, round 32: labels match with Unicode case folding.
    ["a definition changed under a label that only case folding matches (ß)", "See [run][STRASSE].\n\n[straße]: safe.md\n", "See [run][STRASSE].\n\n[straße]: evil.md\n", /removed link `safe.md`/],
    ["a definition changed under a shortcut that only case folding matches (ſ)", "See [ſafe].\n\n[SAFE]: safe.md\n", "See [ſafe].\n\n[SAFE]: evil.md\n", /removed link `safe.md`/],
    // Found by differential fuzzing against commonmark.js (test/polish-fuzz.test.ts):
    ["a command in an indented code block", "Intro.\n\n    rm -rf /tmp\n", "Intro.\n\n    rm -rf /\n", /^changed a code block/],
    ["a heading indented by a tab, which makes it code", "# Incident response\n\nText.\n", "\t# Incident response\n\nText.\n", /^changed a code block/],
    ["the blank line before an indented block dropped, which makes it text", "Retry the job\n\n    run 5\n", "Retry the job\n    run 5\n", /^changed a code block/],
    ["a fence in a quote in a list item, ended by an outdented line", "- > ```\n  > a\n  > ```\n", "- > ```\n > a\n  > ```\n", /^changed a code block/],
    ["a bare URL after a [ (not a GFM link), its digit dropped", "Open [https://example.com/5 now.\n", "Open [https://example.com/ now.\n", /removed number `5 now`/],
    ["backticks in a definition's destination, which a code span can't take", "1. Drain the node:\n\n[a]:   ```sh\n   kubectl drain node-  ```\n", "1. Drain the node\n[a]:   ```sh\n   kubectl drain node-  ```\n", /added inline code `sh kubectl drain node-  `/],
    ["a definition retargeted after one inside an HTML comment block (which isn't one)", "See [a].\n\n<!--\n\n[a]: safe.md\n\n-->\n\n[a]: other.md\n", "See [a].\n\n<!--\n\n[a]: safe.md\n\n-->\n\n[a]: evil.md\n", /removed link `other.md`/],
    ["a list item in a quote kept open by a `>`-only line, so its indented task isn't code", ">\n>     - [ ] Check the canary for 10 minutes.\n> - See [the guide](guide.md \"Guide\").\n", "> - See [the guide](guide.md \"Guide\").\n>\n>     - [ ] Check the canary for 10 minutes.\n", /^changed a code block/],
    ["a decoded entity extending a bare URL (GFM reads the decoded text)", "See https://example.com/5>.\n", "See https://example.com/5>.&amp;\n", /added link `https:\/\/example.com\/5>.&`/],
    ["an entity it can't decode, kept on a bare URL rather than dropped", "See https://x.test/a&rpar; now.\n", "See https://x.test/a now.\n", /removed link `https:\/\/x.test\/a&rpar;`/],
    ["a task box on the line after an empty item's marker, ticked", "-\n  [ ] deploy\n", "-\n  [x] deploy\n", /removed task `\[ \] deploy`[\s\S]*added task `\[x\] deploy`/],
    ["a second definition on an indented line, its title spanning lines", "See [run][a].\n\n[prod]: p.md\n    [a]: safe.md \"S\nfe\"\n", "See [run][a].\n\n[prod]: p.md\n    [a]: safe.md \"S\n", /^the page has a reference definition .* a label or title spanning lines/],
    ["a task whose paragraph a setext underline made a heading, the underline dropped", "- [ ] Check the canary.\n  - \n", "- [ ] Check the canary.\n - \n", /added task `\[ \] Check the canary.`/],
    ["an escaped entity, which is its text", "See <https://example.com/5>&#53;.\n", "See <https://example.com/5>\\&#53;.\n", /removed number `5`[\s\S]*added number `53`/],
    ["a task box indented one past an empty item's content, ticked", "-\n   [ ] deploy\n", "-\n   [x] deploy\n", /added task `\[x\] deploy`/],
    ["a raw tag across two lines after a ]( that doesn't parse", "[p](rod]: <prod\npage.md>\n", "[p](rod]: <prod\npage.m:d>\n", /^the page contains raw HTML/],
    ["the same, in an ordered item in a quote", "> 1.\n>    [ ] deploy\n", "> 1.\n>    [x] deploy\n", /added task `\[x\] deploy`/],
    ["a line added to an unclosed fence at the page's end", "  ~~~\n", "  ~~~\n  ", /^changed a code block/],
    ["a blank line added to an empty fence", "   ```sh\n   ```\n", "   ```sh\n  \n```\n", /^changed a code block/],
    ["a blank line in a list item's fence keeps no spaces", "- ~~~yaml\n  a\n \n  b\n  ~~~\n", "~~~yaml\na\n \nb\n~~~\n", /^changed a code block/],
    ["a digit after a full stop", "Note: do not skip this.\n", "Note: do not skip this.3 \n", /added number `3`/],
    ["a digit inside a word", "Joining on-call.\n", "Joining on-c3all.\n", /^changed digits in the text: added `3`/],
    ["a bracket splitting a number", "SEV1s in 2024 came from bad deploys.\n", "SEV1s in 202[4 came from bad deploys.\n", /removed number `2024 came`/],
    ["a list number that's text, in a quote that makes it a marker", "Click *Build*.\n2. Enter the tag.\n", "Click *Build*.\n> 2. Enter the tag.\n", /removed number `2`/],
    ["an unclosed ** joining a negation", "Do not skip this.\n", "Do no**t skip this.\n", /\"not\" appears \(1 → 0\)/],
    ["a bare destination's trailing >", "See [r][a].\n\n[a]: safe.md \"Safe\"\n", "See [r][a].\n\n[a]: safe.md> \"Safe\"\n", /added link `safe.md>`/],
    ["an autolink turned bare, GFM keeping its >", "See <https://example.com/5>.\n", "See https://example.com/5>.\n", /added link `https:\/\/example.com\/5>`/],
    ["an escaped autolink", "See <https://example.com/5>.\n", "See \\<https://example.com/5>.\n", /removed link `https:\/\/example.com\/5`/],
    ["a bare URL after a backslash, which GFM doesn't link", "Go to https://example.com/5 now.\n", "Go to \\https://example.com/5 now.\n", /removed link `https:\/\/example.com\/5`/],
    ["an empty bullet after a paragraph, which makes a definition text", "See [prod].\n\n[prod]: x.md\n", "See [prod].\n* \n[prod]: x.md\n", /removed link `x.md`/],
    ["a definition line in paragraph text, which is a use", "See [run][a].\n\n[a]: safe.md\n> [a]: safe.md\n", "See [run][a].\n [a]: safe.md\n> [a]: safe.md\n", /added link text `a → safe.md`/],
    ["a link title across a heading and a paragraph", "## See [the guide](de.md \"Guide\").\n", "## See [the guide](de.md\n\"Guide\").\n", /removed link `de.md`/],
    ["a code span pairing across list items", "1. Check: `kubectl get pods -l `pp=x`.\n2. Scale: `kubectl scale --replicas=24`.\n", "1. Check: `kubectl get pods -l `pp=x`.\n2. Scale: `kubctl scale --replicas=24`.\n", /added inline code `kubctl scale --replicas=24`/],
    ["a link's text across quoted lines", "> - See [the\n> guide](guide.md \"Guide\").\n", "> - See [the > guide](guide.md \"Guide\").\n", /removed link text `the guide → guide.md/],
    ["a blank line in a link's title", "See [the guide](guide.md \"Gui\nde\").\n", "See [the guide](guide.md \"Gui\n\nde\").\n", /removed link `guide.md`/],
    ["an escaped image", "![img](x.png)\n", "\\![img](x.png)\n", /added link text `img → x.png`/],
    ["a label across a blank line", "See [prod] now.\n\n[prod]: x.md\n", "See [prod\n\n] now.\n\n[prod]: x.md\n", /removed link `x.md`/],
    ["a negation glued after a full reference", "See [run][a] and.\n\n[a]: x.md\n", "See [run][a]not and.\n\n[a]: x.md\n", /\"not\" appears \(0 → 1\)/],
    ["a negation in an unresolved reference's label", "See [run][x] here.\n", "See [run][never x] here.\n", /\"never\" appears \(0 → 1\)/],
    ["an escaped shortcut reference", "See [prod].\n\n[prod]: x.md\n", "See \\[prod].\n\n[prod]: x.md\n", /removed link `x.md`/],
    ["a ](x) whose [ went", "- [ ](x) check it.\n", "- ](x) check it.\n", /removed link `x`/],
    ["a backtick in a link's destination, which keeps the next code span code", "Use [d](a.`md).\nRun `deploy-prod`.\n", "Use [d](a.`md).\nRun `deployrod`.\n", /added inline code `deployrod`/],
    ["a shortcut inside an unresolved collapsed reference", "See [run][].\n\n[a]: safe.md\n", "See [r[a]: n][].\n\n[a]: safe.md\n", /added link `safe.md`/],
    ["a shortcut before a [ that isn't a label", "See [prod][\n\n[prod]: <prod page.md>\n", "See [prod][\n\n[prod]: <pro&amp;d page.md>\n", /removed link `prod page.md`/],
    ["a link closing an outer [ after a failed one", "1.[ Shadow first.\nThen follow [Incident re](sponse](../x.md).\n", "1.[ Shadow twice.\nThen follow [Incident re](sponse](../x.md).\n", /removed link text `Shadow first/],
    ["a second definition on an indented continuation line", "See [run][a].\n\n[prod]: p.md\n    [a]: safe.md \"Safe\"\n", "See [run][a].\n\n[prod]: p.md\n    [a]: safe.md \"Safe> \n", /removed link `safe.md`/],
    ["a tab inside a link's parentheses", "See [a](x.png).\n", "See [a](\tx.png).\n", /^a link has a tab around its destination/],
    ["a setext underline after definitions", "[a]: x.md\n===\nText.\n", "[a]: x.md\n===\nMore text.\n", /^the page has a reference definition .* a heading underline right after it/],
    ["an HTML block start after a definition's label", "[prod]:\n<prod page.md>\n", "[prod]:\n<p page.md>\n", /added HTML tag `<p page.md>`/],
    // Found alongside merge gate round 39: the check's own mark characters.
    ["a fenced block and a literal U+0002 trading sections", "## Steps\n\n```\nmake deploy\n```\n\n## Rollback\n\nNote \u0002 here.\n", "## Steps\n\nNote \u0002 here.\n\n## Rollback\n\n```\nmake deploy\n```\n", /^the page contains a control character \(U\+0000 to U\+0004\)/],
    ["a literal U+0004 added", "Run `a` now.\n", "Run `a` \u0004 now.\n", /^the page contains a control character \(U\+0000 to U\+0004\)/],
    // Merge gate, PR 3, round 38: a list item's fence ends with the item.
    ["code in a block opened by an outdented fence after a list item's fence", "- ~~~sh\n  echo safe\n~~~\necho production\n~~~\n", "- ~~~sh\n  echo safe\n~~~\necho staging\n~~~\n", /changed a code block/],
    ["code after a list item's fence that outdented text ended", "- ~~~\n  a\nb\n  ~~~\nrm -rf /tmp\n", "- ~~~\n  a\nb\n  ~~~\nrm -rf /\n", /changed a code block/],
    ["code in a block opened by an outdented fence in a quoted list", "> - ~~~\n>   a\n> ~~~\n> rm x\n> ~~~\n", "> - ~~~\n>   a\n> ~~~\n> rm y\n> ~~~\n", /changed a code block/],
    // Merge gate, PR 3, round 37: a fence in a quote in a list keeps its indentation, and
    // a task may sit in a nested list on one line.
    ["a fence's indentation changed in a quote in a list item", "- > ```yaml\n  >   key: value\n  > ```\n", "- > ```yaml\n  > key: value\n  > ```\n", /changed a code block/],
    ["a fence's indentation changed in a list in a quote in a list item", "- > - ```yaml\n  >   a:\n  >     key: v\n  >   ```\n", "- > - ```yaml\n  >   a:\n  >   key: v\n  >   ```\n", /changed a code block/],
    ["a task in a nested list ticked", "- - [ ] Delete production\n", "- - [x] Delete production\n", /removed task `\[ \] Delete production`[\s\S]*added task `\[x\] Delete production`/],
    ["a number at the start of a paragraph's line, which only looks like a list marker", "Retry the job\n3. times at most.\n", "Retry the job\n5. times at most.\n", /removed number `3`[\s\S]*added number `5`/],
    ["a number starting a line inside a list item's paragraph", "1. Drain\n   3. times.\n", "1. Drain\n   5. times.\n", /removed number `3`[\s\S]*added number `5`/],
    ["a task in a quoted nested list ticked", "> 1. - [ ] Delete production\n", "> 1. - [x] Delete production\n", /removed task `\[ \] Delete production`/],
    // Merge gate, PR 3, round 36: a unit's case counts, and so does a fence's info string.
    ["a unit's case changed", "Allow 5 MB per upload.\n", "Allow 5 Mb per upload.\n", /removed number `5 MB`[\s\S]*added number `5 Mb`/],
    ["an attached unit's case changed", "Allow 500MB per upload.\n", "Allow 500Mb per upload.\n", /removed number `500MB per`[\s\S]*added number `500Mb per`/],
    ["milliwatts turned into megawatts", "Draws 10 mW idle.\n", "Draws 10 MW idle.\n", /removed number `10 mW`/],
    ["a fence's info string changed", "```text\ngraph TD; A-->B\n```\n", "```mermaid\ngraph TD; A-->B\n```\n", /changed a code block/],
    ["a fence's info string added", "```\ngraph TD; A-->B\n```\n", "```mermaid\ngraph TD; A-->B\n```\n", /changed a code block/],
    // Merge gate, PR 3, round 35: no two headings share a section.
    ["a command moved between headings that differ in an underscore", "## prod_api\n\nRun `drain`.\n\n## prodapi\n\nNothing.\n", "## prod_api\n\nNothing.\n\n## prodapi\n\nRun `drain`.\n", /moved code into or out of the "prod_api" section/],
    ["two headings that differ in an underscore trading names", "## prod_api\n\nRun `drain`.\n\n## prodapi\n\nRun `uncordon`.\n", "## prodapi\n\nRun `drain`.\n\n## prod_api\n\nRun `uncordon`.\n", /moved code into or out of the "prod_api" section/],
    ["a command moved out from under a heading that only dropped its closing hashes", "## Steps ##\n\nRun `a`.\n\nRun `b`.\n", "## Steps\n\nRun `a`.\n\n## Extra\n\nRun `b`.\n", /moved code into or out of the "Steps" section/],
    ["a command moved between two headings with the same text", "## Steps\n\nRun `a`.\n\n## Notes\n\nNever run anything here.\n\n## Steps\n\nRun `b`.\n", "## Steps\n\nFirst.\n\n## Notes\n\nNever run anything here.\n\n## Steps\n\nRun `a`. Run `b`.\n", /moved code into or out of the "Steps \(2\)" section/],
    // Merge gate, PR 3, round 34: headings inside list items have sections too.
    ["a command moved between headings in list items", "- ## Steps\n\n  Run `drain`.\n- ## Rollback\n\n  Run `uncordon`.\n", "- ## Steps\n\n  Run `drain`.\n\n  Run `uncordon`.\n- ## Rollback\n\n  Nothing to do.\n", /moved code into or out of the "Steps" section/],
    ["a command moved between headings in ordered list items", "1. ## Steps\n   Run `drain`.\n2. ## Rollback\n   Run `uncordon`.\n", "1. ## Steps\n   Run `drain`.\n   Run `uncordon`.\n2. ## Rollback\n   Nothing.\n", /moved code into or out of the "Steps" section/],
    ["a command moved between headings indented four in a list item", "1.  item\n\n    ## Steps\n\n    Run `drain`.\n\n    ## Rollback\n\n    Run `uncordon`.\n", "1.  item\n\n    ## Steps\n\n    Run `drain`.\n    Run `uncordon`.\n\n    ## Rollback\n\n    Nothing.\n", /moved code into or out of the "Steps" section/],
    ["a command moved between headings in a quoted list", "> - ## Steps\n>   Run `drain`.\n> - ## Rollback\n>   Run `uncordon`.\n", "> - ## Steps\n>   Run `drain`.\n>   Run `uncordon`.\n> - ## Rollback\n>   Nothing.\n", /moved code into or out of the "Steps" section/],
    ["a command moved between setext headings in list items", "- Steps\n  -----\n  Run `drain`.\n- Rollback\n  --------\n  Run `uncordon`.\n", "- Steps\n  -----\n  Run `drain`.\n  Run `uncordon`.\n- Rollback\n  --------\n  Nothing.\n", /moved code into or out of the "Steps" section/],
    // Merge gate, PR 3, round 33: a title may span lines, and then the page is refused.
    ["a definition whose title spans lines, changed under its use", "See [run][x].\n\n[x]: safe.md \"multi\nline\"\n", "See [run][x].\n\n[x]: evil.md \"multi\nline\"\n", /^the page has a reference definition .* title spanning lines/],
    ["a definition whose parenthesised title spans lines", "See [run][x].\n\n[x]: safe.md (multi\nline)\n", "See [run][x].\n\n[x]: evil.md (multi\nline)\n", /^the page has a reference definition .* title spanning lines/],
    ["a negation moved into a title that starts on the next line and spans lines", "Do not deploy.\n\n[x]: safe.md\n\"a\nb\"\n", "Deploy.\n\n[x]: safe.md\n\"a not\nb\"\n", /^the page has a reference definition .* title spanning lines/],
    // Found alongside round 32: definitions placed as CommonMark places them, and pages
    // where that takes the whole block structure refused.
    ["text on a definition line whose label is only spaces", "Intro.\n\n[ ]: a.md \"Do not deploy\"\n", "Intro.\n\n[ ]: a.md \"Deploy now\"\n", /"not" appears \(1 → 0\)/],
    ["text on a definition line whose label is over 999 characters", `Intro.\n\n[${"x".repeat(1000)}]: a.md "Do not deploy"\n`, `Intro.\n\n[${"x".repeat(1000)}]: a.md "Deploy now"\n`, /"not" appears \(1 → 0\)/],
    ["a definition after a thematic break, changed under its use", "Intro.\n\n---\n[a]: safe.md\n\nSee [run][a].\n", "Intro.\n\n---\n[a]: evil.md\n\nSee [run][a].\n", /removed link `safe.md`/],
    ["a definition opening a quote after text, changed under its use", "Intro text\n> [a]: safe.md\n\nSee [run][a].\n", "Intro text\n> [a]: evil.md\n\nSee [run][a].\n", /removed link `safe.md`/],
    ["a definition after a quoted heading, changed under its use", "> # Head\n> [a]: safe.md\n\nSee [run][a].\n", "> # Head\n> [a]: evil.md\n\nSee [run][a].\n", /removed link `safe.md`/],
    ["text lazily continuing a quote, on a definition-like line", "> quote text\n[a]: a.md \"Do not deploy\"\n", "> quote text\n[a]: a.md \"Deploy now\"\n", /"not" appears \(1 → 0\)/],
    ["a definition whose label spans lines", "See [run][foo bar].\n\n[foo\nbar]: safe.md\n", "See [run][foo bar].\n\n[foo\nbar]: evil.md\n", /^the page has a reference definition .* a label or title spanning lines/],
    // Indented by a tab or four after a blank line, it's indented code in CommonMark.
    ["a definition-like line indented by a tab, which is code", "Intro.\n\n\t[a]: a.md \"Do not deploy\"\n", "Intro.\n\n\t[a]: a.md \"Deploy now\"\n", /^changed a code block/],
    ["a definition-like line indented by four spaces, which is code", "Intro.\n\n    [a]: a.md \"Do not deploy\"\n", "Intro.\n\n    [a]: a.md \"Deploy now\"\n", /^changed a code block/],
    // Indented four in a list item's content, it's a definition: read on the item's content.
    ["a definition indented four in a list item, retargeted under its use", "1.  See [r][a].\n\n    [a]: safe.md\n", "1.  See [r][a].\n\n    [a]: evil.md\n", /removed link `safe.md`/],
    ["a definition with a tab before its destination (commonmark.js takes spaces only)", "See [r][a].\n\n[a]:\tsafe.md\n", "See [r][a].\n\n[a]:\tevil.md\n", /^the page has a reference definition/],
    ["a definition after a setext heading, retargeted under its use", "Title\n===\n[a]: safe.md\n\nSee [r][a].\n", "Title\n===\n[a]: evil.md\n\nSee [r][a].\n", /removed link `safe.md`/],
    ["text on a definition-like line continuing an indented paragraph line", "Intro text\n    more text\n[a]: a.md \"Do not deploy\"\n", "Intro text\n    more text\n[a]: a.md \"Deploy now\"\n", /"not" appears \(1 → 0\)/],
    // Merge gate, PR 3, round 31: a line that isn't a definition is text, and a
    // definition reads code spans as written.
    ["text on a definition line whose destination's parentheses don't balance", "Intro.\n\n[a]: safe(md \"Do not deploy\"\n", "Intro.\n\n[a]: safe(md \"Deploy now\"\n", /"not" appears \(1 → 0\)/],
    ["text on a definition line whose destination nests past 32", `Intro.\n\n[a]: ${"(".repeat(33)}${")".repeat(33)} "Do not deploy"\n`, `Intro.\n\n[a]: ${"(".repeat(33)}${")".repeat(33)} "Deploy now"\n`, /"not" appears \(1 → 0\)/],
    ["text on a definition line whose destination starts with < but doesn't close there", "Intro.\n\n[a]: <1.md>x \"Do not deploy\"\n", "Intro.\n\n[a]: <1.md>x \"Deploy now\"\n", /"not" appears \(1 → 0\)/],
    ["text on a definition line whose destination holds a control character", "Intro.\n\n[a]: safe\u0007md \"Do not deploy\"\n", "Intro.\n\n[a]: safe\u0007md \"Deploy now\"\n", /"not" appears \(1 → 0\)/],
    ["code in a used definition's destination", "See [the runbook][rb].\n\n[rb]: https://x.example/`a`\n", "See [the runbook][rb].\n\n[rb]: https://x.example/`b`\n", /removed link `https:\/\/x.example\/`a``/],
    ["a definition changed under a label that holds code", "See [`x`][].\n\n[`x`]: https://a.example\n", "See [`x`][].\n\n[`x`]: https://b.example\n", /removed link `https:\/\/a.example`/],
    ["code in a used definition's title", "See [r][rb].\n\n[rb]: https://a.example \"run `drain`\"\n", "See [r][rb].\n\n[rb]: https://a.example \"run `delete`\"\n", /removed link text `r → https:\/\/a.example "run `drain`"`/],
    ["two links whose text is code trading targets", "Use [`drain`](https://a.example) or [`delete`](https://b.example).\n", "Use [`drain`](https://b.example) or [`delete`](https://a.example).\n", /removed link text ``drain` → https:\/\/a.example`/],
    // Merge gate, PR 3, round 30.
    ["a literal asterisk dropped from link text", "[delete *.log](runbook.md)\n", "[delete .log](runbook.md)\n", /removed link text `delete \*.log → runbook.md`/],
    ["a literal asterisk dropped from a task", "- [ ] delete *.log\n", "- [ ] delete .log\n", /removed task `\[ \] delete \*.log`/],
    // Merge gate, PR 3, round 29: an entity moved to another number.
    ["a minus sign moved between numbers", "Offset &minus;5 minutes and 10 minutes.\n", "Offset 5 minutes and &minus;10 minutes.\n", /removed number `\u22125 minutes`|removed number `-5 minutes`/],
    ["an unreadable entity moved to another word", "Use &rarr;prod then staging.\n", "Use prod then &rarr;staging.\n", /removed entity `&rarr;prod`/],
    // Merge gate, PR 3, round 27: an indented "fence" is code, its ``` lines included.
    ["the info string of an indented fence-like line", "    ```echo safe\n    body\n    ```\n", "    ```rm -rf /\n    body\n    ```\n", /changed a code block/],
    ["the closer of an indented fence-like block", "    ```\n    body\n    ```\n", "    ```\n    body\n    `````\n", /changed a code block/],
    ["an indented fence-like line inside a list item", "1.     ```echo safe\n       body\n       ```\n", "1.     ```rm -rf /\n       body\n       ```\n", /changed a code block/],
    // Merge gate, PR 3, round 26: a link that becomes an image loads by itself.
    ["a link turned into an image", "See [status](https://example.com/a.png).\n", "See ![status](https://example.com/a.png).\n", /added link text `!status → https:\/\/example.com\/a.png`/],
    ["a reference link turned into an image", "See [status][s].\n\n[s]: https://example.com/a.png\n", "See ![status][s].\n\n[s]: https://example.com/a.png\n", /added link text `!status → https:\/\/example.com\/a.png`/],
    ["a shortcut reference turned into an image", "See [s].\n\n[s]: https://example.com/a.png\n", "See ![s].\n\n[s]: https://example.com/a.png\n", /added link text `!s → https:\/\/example.com\/a.png`/],
    // Merge gate, PR 3, round 25.
    ["spaces before a line break inside a code span", "Run `printf 'a b'` now.\n", "Run `printf 'a  \nb'` now.\n", /removed inline code `printf 'a b'`/],
    ["links whose text differs only in case trading destinations", "[US](country.md) and [us](team.md)\n", "[US](team.md) and [us](country.md)\n", /removed link text `US → country.md`/],
    ["tasks differing only in case trading boxes", "- [x] Notify US\n- [ ] Notify us\n", "- [ ] Notify US\n- [x] Notify us\n", /removed task `\[x\] Notify US`/],
    // Merge gate, PR 3, round 24: what CommonMark reads first wins.
    ["comment-like code spans trading places", "Use `<!-- prod -->` then `<!-- staging -->`.\n", "Use `<!-- staging -->` then `<!-- prod -->`.\n", /^changed the order of the page's code/],
    ["a comment-like code span edited", "Keep `<!-- prod -->` as is.\n", "Keep `<!-- staging -->` as is.\n", /removed inline code `<!-- prod -->`/],
    ["a definition-like line inside a code span", "Run `deploy\n[a]: safe.md` now.\n", "Run `deploy\n[a]: evil.md` now.\n", /removed inline code `deploy \[a\]: safe.md`/],
    ["a definition-like line interrupting a paragraph", 'Note:\n[x]: safe.md "do not deploy"\n', 'Note:\n[x]: safe.md "deploy"\n', /"not" appears \(1 → 0\)/],
    ["a backtick inside a comment", "<!-- `x` --> Run it.\n", "<!-- `y` --> Run it.\n", /removed HTML comment `<!-- `x` -->`/],
    ["a list item that only looks like a task", "- [x]: safe.md is the default\n", "- [x]: safe.md is not the default\n", /"not" appears \(0 → 1\)/],
    // Merge gate, PR 3, round 23: a malformed definition is visible text.
    ["a line that only looks like a definition (unclosed title)", '[unused]: safe.md "Do not deploy\n', '[unused]: evil.md "Deploy immediately\n', /"not" appears \(1 → 0\)/],
    ["a line that only looks like a definition (text after the title)", '[unused]: safe.md "t" then do not deploy\n', '[unused]: safe.md "t" then deploy\n', /"not" appears \(1 → 0\)/],
    // Merge gate, PR 3, round 22.
    ["a reference definition in a quote", "> [run][x]\n>\n> [x]: safe.md\n", "> [run][x]\n>\n> [x]: evil.md\n", /removed link `safe.md`/],
    ["a reference definition in a list item", "- [run][x]\n- [x]: safe.md\n", "- [run][x]\n- [x]: evil.md\n", /removed link `safe.md`/],
    ["a quoted definition's title on the next line", '> [run][x]\n>\n> [x]: safe.md\n>   "Do not deploy"\n', '> [run][x]\n>\n> [x]: safe.md\n>   "Deploy now"\n', /removed link text `run → safe.md "Do not deploy"`/],
    // Merge gate, PR 3, round 21.
    ["a fenced block indented by four (indented code)", "```\nmake deploy\n```\n", "    ```\n    make deploy\n    ```\n", /changed a code block/],
    ["a command moved into an unused definition's title", "Run `deploy --prod` now.\n", '[unused]: / "Run `deploy --prod` now."\n', /removed inline code `deploy --prod`/],
    // Merge gate, PR 3, round 19.
    ["comment-only code blocks trading contents", "```\n<!-- a -->\n```\n\n```\n<!-- b -->\n```\n", "```\n<!-- b -->\n```\n\n```\n<!-- a -->\n```\n", /^changed the order of the page's code/],
    ["a comment inside a code block edited", "```html\n<!-- keep: prod -->\n```\n", "```html\n<!-- keep: staging -->\n```\n", /changed a code block/],
    // Merge gate, PR 3, round 18.
    ["an underscore dropped from link text", "[prod_api](runbook.md)\n", "[prodapi](runbook.md)\n", /removed link text `prod_api → runbook.md`/],
    ["an underscore dropped from a task", "- [ ] Configure prod_api\n", "- [ ] Configure prodapi\n", /removed task `\[ \] configure prod_api`/i],
    ["another of an invisible character the page has", "Restart\u200b it.\n", "Restart\u200b it. Do n\u200bot wait.\n", /added the character U\+200B/],
    // Merge gate, PR 3, round 17.
    ["a reference title on the next line", '[run][x]\n\n[x]: safe.md\n  "Do not deploy"\n', '[run][x]\n\n[x]: safe.md\n  "Deploy now"\n', /removed link text `run → safe.md "Do not deploy"`/],
    ["a task's continuation line", "- [ ] Deploy\n  to production\n", "- [ ] Deploy\n  to staging\n", /removed task `\[ \] deploy to production`/i],
    ["a non-ASCII unit", "\u0627\u0646\u062a\u0638\u0631 \u0665 \u062f\u0642\u0627\u0626\u0642.\n", "\u0627\u0646\u062a\u0638\u0631 \u0665 \u0633\u0627\u0639\u0627\u062a.\n", /removed number `\u0665 \u062f\u0642\u0627\u0626\u0642`/],
    // Merge gate, PR 3, round 16.
    ["a space after a shell continuation", "```sh\nrm -rf /tmp/a \\\n  /tmp/b\n```\n", "```sh\nrm -rf /tmp/a \\ \n  /tmp/b\n```\n", /changed a code block/],
    ["a link's title", '[run](safe.md "Do not deploy")\n', '[run](safe.md "Deploy now")\n', /removed link text `run → safe.md "Do not deploy"`/],
    ["a reference definition's title", '[run][x]\n\n[x]: safe.md "Do not deploy"\n', '[run][x]\n\n[x]: safe.md "Deploy now"\n', /removed link text `run → safe.md "Do not deploy"`/],
    ["an ASCII control character", "Restart it.\n", "Do n\u001bot restart it.\n", /added the character U\+001B/],
    // Merge gate, PR 3, round 15.
    ["tasks reordered, their boxes left behind", "- [x] Drain traffic\n- [ ] Delete database\n", "- [x] Delete database\n- [ ] Drain traffic\n", /removed task `\[x\] drain traffic`/i],
    ["deeply nested reference text trading references", "[production [very [deep] guide]][a] or [staging [very [deep] guide]][b]\n\n[a]: prod.md\n[b]: staging.md\n", "[production [very [deep] guide]][b] or [staging [very [deep] guide]][a]\n\n[a]: prod.md\n[b]: staging.md\n", /removed link text `production \[very \[deep\] guide\] → prod.md`/],
    // Merge gate, PR 3, round 14.
    ["reference links with nested text trading references", "[the [production] guide][a] or [the [staging] guide][b]\n\n[a]: prod.md\n[b]: staging.md\n", "[the [production] guide][b] or [the [staging] guide][a]\n\n[a]: prod.md\n[b]: staging.md\n", /removed link text `the \[production\] guide → prod.md`/],
    ["code moved between headings in a quote", "> ## Steps\n>\n> Run `drain`.\n>\n> ## Rollback\n>\n> Undo it.\n", "> ## Steps\n>\n> Drain it.\n>\n> ## Rollback\n>\n> Run `drain`.\n", /moved code into or out of the "steps" section/i],
    ["an Arabic-Indic digit", "\u0627\u0646\u062a\u0638\u0631 \u0665 \u062f\u0642\u0627\u0626\u0642.\n", "\u0627\u0646\u062a\u0638\u0631 \u0669 \u062f\u0642\u0627\u0626\u0642.\n", /removed number `\u0665 \u062f\u0642\u0627\u0626\u0642`[\s\S]*added number `\u0669 /],
    // Merge gate, PR 3, round 13.
    ["a version inside a word", "Require TLSv1.2 or later.\n", "Require TLSv1.3 or later.\n", /removed word with digits `tlsv1.2`/],
    ["IPv4 to IPv6", "Listen on IPv4 only.\n", "Listen on IPv6 only.\n", /removed word with digits `ipv4`/],
    ["a code block moved between setext sections", "Steps\n=====\n\n```\nmake deploy\n```\n\nNotes\n=====\n\nDone.\n", "Steps\n=====\n\nDeploy.\n\nNotes\n=====\n\n```\nmake deploy\n```\n", /moved code into or out of the "steps" section/i],
    ["an identifier changed", "Read ADR-0001 first.\n", "Read ADR-0003 first.\n", /removed number `ADR-0001`[\s\S]*added number `ADR-0003`/],
    // Merge gate, PR 3, round 12: what goes with what.
    ["task-box states swapped between tasks", "- [x] Drain traffic\n- [ ] Delete database\n", "- [ ] Drain traffic\n- [x] Delete database\n", /removed task `\[x\] drain traffic`/i],
    ["two links trading destinations", "[production](https://prod.example/) and [staging](https://staging.example/)\n", "[production](https://staging.example/) and [staging](https://prod.example/)\n", /removed link text `production → https:\/\/prod.example\/`/],
    ["reference links trading definitions", "[production][a] and [staging][b]\n\n[a]: prod.md\n[b]: staging.md\n", "[production][b] and [staging][a]\n\n[a]: prod.md\n[b]: staging.md\n", /removed link text `production → prod.md`/],
    // Merge gate, PR 3, round 11.
    ["scientific notation", "Wait 1e3 seconds.\n", "Wait 1e9 seconds.\n", /removed number `1e3 seconds`/],
    ["a tab turned into a space in a fence's code", " ```\n\tfoo: 1\n ```\n", " ```\n foo: 1\n ```\n", /changed a code block/],
    ["a reference destination with an escaped >", "[run][x]\n\n[x]: <safe\\> path.md>\n", "[run][x]\n\n[x]: <safe\\> evil.md>\n", /removed link `safe\\> path.md`/],
    ["an inline destination with an escaped >", "[run](<safe\\> path.md>)\n", "[run](<safe\\> evil.md>)\n", /removed link `safe\\> path.md`/],
    // Merge gate, PR 3, round 9.
    ["code after an indented fence line inside a block", "```\n    ```\nrm -rf /tmp/cache\n```\n", "```\n    ```\nrm -rf /\n```\n", /changed a code block/],
    ["code after a tab-indented fence line inside a block", "```\n\t```\nrm -rf /tmp/cache\n```\n", "```\n\t```\nrm -rf /\n```\n", /changed a code block/],
    ["code after a deeper fence line, the opener indented 3", "   ```\n      ```\n   make deploy\n   ```\n", "   ```\n      ```\n   make destroy\n   ```\n", /changed a code block/],
    ["a fence opened on a list item's line", "1. ```\n   make deploy\n   ```\n", "1. ```\n   make destroy\n   ```\n", /changed a code block/],
    ["a fence in a deeply indented quote", "1. - > ```\n       > rm -rf /tmp/cache\n       > ```\n", "1. - > ```\n       > rm -rf /\n       > ```\n", /changed a code block/],
    ["a fence in a quote in a list item", "- > ```\n  > rm -rf /tmp/cache\n  > ```\n", "- > ```\n  > rm -rf /\n  > ```\n", /changed a code block/],
    ["an upper-case URL", "See HTTPS://safe.example/runbook today.\n", "See HTTPS://evil.example/runbook today.\n", /removed link `HTTPS:\/\/safe.example\/runbook`/],
    // Merge gate, PR 3, round 8: unclosed openers hide everything after them.
    ["an unclosed comment", "You must wait 5 minutes.\n", "<!-- You must wait 5 minutes.\n", /added raw HTML opener `<!--`/],
    ["an unclosed processing instruction", "You must wait 5 minutes.\n", "<? You must wait 5 minutes.\n", /added raw HTML opener `<\?`/],
    ["an unclosed CDATA section", "You must wait 5 minutes.\n", "<![CDATA[ You must wait 5 minutes.\n", /added raw HTML opener `<!\[cdata\[`/],
    ["an unclosed tag", "You must wait 5 minutes.\n", "<div\nYou must wait 5 minutes.\n", /added raw HTML opener `<div`/],
    ["any polish of a page with an unclosed opener", "<div\nRun it now.\n", "<div\nRun it right away.\n", /^the page contains raw HTML/],
    // Merge gate, PR 3, round 7.
    ["an ordered task box ticked", "1. [ ] Drain the node\n", "1. [x] Drain the node\n", /removed task `\[ \] drain the node`/i],
    ["a decoded minus removed", "Wait &minus;5 minutes.\n", "Wait 5 minutes.\n", /removed number `-5 minutes`/],
    ["an unreadable entity removed", "Go &rarr;prod.\n", "Go prod.\n", /removed entity `&rarr;prod.`/],
    ["a reference label with an escaped bracket", "[run][prod\\]]\n\n[prod\\]]: safe.md\n", "[run][prod\\]]\n\n[prod\\]]: evil.md\n", /removed link `safe.md`/],
    // Merge gate, PR 3, round 6.
    ["a leading-decimal number", "Wait .5 minutes.\n", "Wait .9 minutes.\n", /removed number `.5 minutes`/],
    ["an instruction hidden in a processing instruction", "You must wait 5 minutes.\n", "Proceed immediately. <? You must wait 5 minutes. ?>\n", /added HTML tag/],
    ["an instruction hidden in CDATA", "You must wait 5 minutes.\n", "Proceed. <![CDATA[ must wait 5 minutes ]]>\n", /added HTML tag/],
    ["a target behind a title with escaped quotes", '[run](safe.md "say \\"now\\"")\n', '[run](evil.md "say \\"now\\"")\n', /removed link `safe.md`/],
    ["a target this scanner can't parse", '[run](safe.md "never closed\n', '[run](evil.md "never closed\n', /removed link `unparsed \]\(safe.md/],
    // Merge gate, PR 3, round 5.
    ["a closing tag moved to hide an instruction", "<span hidden>note</span> You must wait 5 minutes.\n", "<span hidden>note You must wait 5 minutes.</span>\n", /^the page contains raw HTML/],
    ["any polish of a page with raw HTML", "Run it <b>now</b>.\n", "Run it <b>right away</b>.\n", /^the page contains raw HTML/],
    ["a decoded minus added", "Wait 5 minutes.\n", "Wait &minus;5 minutes.\n", /added number `-5 minutes`/],
    ["an entity this check can't read", "Go prod.\n", "Go &rarr;prod.\n", /added entity `&rarr;prod.`/],
    // Merge gate, PR 3, round 4: hiding a fact rather than changing it.
    ["a reference definition with its target on the next line", "[run][prod]\n\n[prod]:\n  safe.md\n", "[run][prod]\n\n[prod]:\n  evil.md\n", /removed link `safe.md`/],
    ["an instruction hidden in a span", "You must wait 5 minutes.\n", "Proceed immediately. <span hidden>must wait 5 minutes.</span>\n", /added HTML tag `<span hidden>`/],
    ["an HTML attribute changed", '<details open>\nSteps\n</details>\n', "<details>\nSteps\n</details>\n", /removed HTML tag `<details open>`/],
    ["a negation written as an entity", "Restart it.\n", "Do &#110;ot restart it.\n", /"not" appears \(0 → 1\)/],
    ["a look-alike letter", "Restart it.\n", "Do n\u043et restart it.\n", /added the character U\+043E/],
    ["a zero-width space written as an entity", "Restart it.\n", "Do n&#8203;ot restart it.\n", /added the character U\+200B/],
    ["a soft hyphen", "Restart it.\n", "Do n\u00adot restart it.\n", /added the character U\+00AD/],
    ["a Greek look-alike letter", "Restart it.\n", "Do n\u03bft restart it.\n", /added the character U\+03BF/],
    // Merge gate, PR 3, round 3.
    ["a tilde fence in a blockquote", "> ~~~\n> rm -rf /tmp/cache\n> ~~~\n", "> ~~~\n> rm -rf /tmp\n> ~~~\n", /changed a code block/],
    ["a backtick fence in a nested quote", "> > ```\n> > make deploy\n> > ```\n", "> > ```\n> > make destroy\n> > ```\n", /changed a code block/],
    ["an instruction hidden in a comment", "You must wait 5 minutes.\n", "Proceed immediately. <!-- must wait 5 minutes -->\n", /added HTML comment[\s\S]*removed number `5 minutes`[\s\S]*"must" appears \(1 → 0\)/],
    // An HTML comment block holds text, not code: the block is gone (CommonMark §4.6).
    ["a code block hidden in a comment", "```\nmake deploy\n```\n", "<!--\n```\nmake deploy\n```\n-->\n", /^changed a code block/],
    ["a code block hidden in a comment opened mid-paragraph", "Text\n\n```\nmake deploy\n```\n", "Text <!--\n\n```\nmake deploy\n```\n-->\n", /^an HTML comment wraps a code block/],
    ["an existing comment edited", "Step one. <!-- owner: platform -->\n", "Step one. <!-- owner: payments -->\n", /removed HTML comment `<!-- owner: platform -->`/],
    // Merge gate, PR 3, round 2.
    ["a fenced block's code shifted", "```yaml\nkey:\n  child: 1\n```\n", "```yaml\n  key:\n    child: 1\n```\n", /changed a code block/],
    ["an unquoted HTML href", "Use <a href=/safe>the console</a>.\n", "Use <a href=/evil>the console</a>.\n", /removed link `\/safe`/],
    ["an unquoted image src", "<img src=asset.png>\n", "<img src=other.png>\n", /removed link `asset.png`/],
    ["a hyphenated unit", "Set a 5-minute timeout.\n", "Set a 5-second timeout.\n", /removed number `5 minute`[\s\S]*added number `5 second`/],
    // Merge gate, PR 3.
    ["an email autolink", "Page <ops@example.com>.\n", "Page <attacker@example.com>.\n", /removed link `ops@example.com`/],
    ["a URI autolink", "Fetch <ftp://files.example.com/a>.\n", "Fetch <ftp://files.example.com/b>.\n", /removed link `ftp:\/\/files.example.com\/a`/],
    ["a bare email", "Mail ops@example.com first.\n", "Mail ops@evil.example first.\n", /removed link `ops@example.com`/],
    ["a www link", "See www.example.com/runbook today.\n", "See www.example.org/runbook today.\n", /removed link `www.example.com\/runbook`/],
    ["an HTML anchor", 'Use <a href="https://ok.example/x">the console</a>.\n', 'Use <a href="https://evil.example/x">the console</a>.\n', /removed link `https:\/\/ok.example\/x`/],
  ])("catches %s", (_what, a, b, message) => {
    expect(polishChanges(fm + a, fm + b).join("; ")).toMatch(message);
  });

  it.each([
    ["sentence punctuation after a bare URL", "See https://example.com/runbook, then continue.\n", "See https://example.com/runbook. Then continue.\n"],
    ["a URL in parentheses", "(see https://example.com/a)\n", "See https://example.com/a.\n"],
    ["CRLF line endings", "Wait 5 minutes.\n\n```\nmake deploy\n```\n", "Wait 5 minutes.\r\n\r\n```\r\nmake deploy\r\n```\r\n"],
    ["a fence moved into a list item", "Run:\n\n```\nmake deploy\n```\n", "1. Run:\n\n   ```\n   make deploy\n   ```\n"],
    ["a reference link turned inline", "[prod][p]\n\n[p]: prod.md\n", "[prod](prod.md)\n"],
    ["typographic apostrophes", "Don't restart it.\n", "Don\u2019t restart it.\n"],
    ["a range's hyphen", "Wait 5-10 minutes.\n", "Wait 5-10 minutes before you retry.\n"],
    ["a hyphenated unit written out", "Set a 5-minute timeout.\n", "Set the timeout to 5 minutes.\n"],
    ["a fence and its code indented together", "```\nmake\n  --all\n```\n", "1. Run:\n   ```\n   make\n     --all\n   ```\n"],
    ["typographic punctuation and an arrow", "Don't wait -- restart it -> done...\n", "Don\u2019t wait \u2014 restart it \u2192 done\u2026\n"],
    ["a page already in another script, reworded", "\u041f\u0435\u0440\u0435\u0437\u0430\u043f\u0443\u0441\u0442\u0438\u0442\u0435 \u0435\u0433\u043e.\n", "\u0415\u0433\u043e \u043f\u0435\u0440\u0435\u0437\u0430\u043f\u0443\u0441\u0442\u0438\u0442\u0435.\n"],
    ["a decoded entity added", "Use A & B.\n", "Use A &amp; B.\n"],
    ["an unreadable entity the page already had", "Use A &rarr; B.\n", "Use A &rarr; then B.\n"],
    ["an entity written as its character", "Use A &amp; B.\n", "Use A & B.\n"],
    ["a fenced block moved into a blockquote", "```\nmake deploy\n```\n", "> ```\n> make deploy\n> ```\n"],
    ["rewording after a quote whose fence never closed", "> ```\n> make deploy\n\nWait 5 minutes, then check.\n", "> ```\n> make deploy\n\nThen check, after 5 minutes.\n"],
    ["prose reworded around an unchanged comment", "Run it now. <!-- reviewed 2026 -->\n", "<!-- reviewed 2026 -->\nRun it right away.\n"],
    ["a link with an angle-bracket destination, reworded", "Read [the guide](<docs/run book.md>) first.\n", "First, read [the guide](<docs/run book.md>).\n"],
    ["a closing fence indented with its list item", "1. Run:\n   ```\n   make\n   ```\n\nDone.\n", "1. Run this:\n   ```\n   make\n   ```\n\nDone.\n"],
    ["text around a fence on a list item's line, reworded", "1. ```\n   make deploy\n   ```\n\nThen wait.\n", "1. ```\n   make deploy\n   ```\n\nWait after that.\n"],
    ["sections without code reordered", "## Why\n\nIt keeps the cache warm.\n\n## Steps\n\nRun `drain`.\n\n## Notes\n\nOwned by platform.\n", "## Notes\n\nOwned by platform.\n\n## Why\n\nIt keeps the cache warm.\n\n## Steps\n\nRun `drain`.\n"],
    ["headings added to a flat page", "Run `drain`, then `restart`.\n\nIf it fails, run `uncordon`.\n", "## Steps\n\nRun `drain`, then `restart`.\n\n## Rollback\n\nIf it fails, run `uncordon`.\n"],
    ["links moved, each with its text", "See [production](https://prod.example/).\n\nOr [staging](https://staging.example/).\n", "Or [staging](https://staging.example/).\n\nSee [production](https://prod.example/).\n"],
    // live:polish, 2026-11-05: a false reject on onb-backend.
    ["an identifier's sentence restructured", "Read ADR-0001 and ADR-0002 first.\n", "Read these first:\n\n- ADR-0001\n- ADR-0002\n"],
    ["a task rewrapped", "- [ ] Deploy to\n  production\n", "- [ ] Deploy\n  to production\n"],
    ["an invisible character removed", "Restart\u200b it.\n", "Restart it.\n"],
    ["a list item that only looks like a task, reworded", "- [x]: safe.md is the default\n", "- [x]: safe.md is the usual default\n"],
    ["tasks moved with their boxes", "- [x] Drain traffic\n- [ ] Delete database\n", "- [ ] Delete database\n- [x] Drain traffic\n"],
    ["a collapsed reference", "See [prod][].\n\n[prod]: prod.md\n", "Read [prod][] first.\n\n[prod]: prod.md\n"],
    ["a version word moved in its sentence", "On RHEL8, use dnf.\n", "Use dnf on RHEL8.\n"],
    ["an autolink written bare", "See <https://example.com/a>.\n", "See https://example.com/a.\n"],
    ["a number next to an email", "Page ops2@example.com within 5 minutes.\n", "Within 5 minutes, page ops2@example.com.\n"],
    ["a code span rewrapped, its next line indented", "Run `printf 'a b'` now.\n", "Run `printf 'a\n  b'` now.\n"],
    ["a code span rewrapped", "Run `deploy --prod` now.\n", "Run `deploy\n  --prod` now.\n"],
    ["a link with a title, rewrapped", "[run](a.md \"Run it\")\n", "[run](a.md\n\"Run it\")\n"],
    ["rewording after a block closed by a longer fence", "```\nmake\n````\n\nYou can restart it later.\n", "```\nmake\n````\n\nRestart it later, when ready.\n"],
    ["an unused definition dropped, whose label is also an inline link's text", "[prod](staging.md)\n\n[prod]: prod.md\n", "[prod](staging.md)\n"],
    ["text after a list item's fence with a blank line inside, reworded", "- ~~~\n  a\n\n  b\n  ~~~\n\nThen wait.\n", "- ~~~\n  a\n\n  b\n  ~~~\n\nWait after that.\n"],
    ["a bare URL's trailing underscore turned into a tilde (outside the link in GFM)", "See https://example.com/runbook_ now.\n", "See https://example.com/runbook~ now.\n"],
    ["an unused definition's title changed after indented code (it shows nowhere)", "Intro.\n\n    make deploy\n[a]: a.md \"Do not deploy\"\n", "Intro.\n\n    make deploy\n[a]: a.md \"Deploy now\"\n"],
    ["an unused definition's title changed in a list item's content (it shows nowhere)", "1.  item\n\n    [a]: a.md \"Do not deploy\"\n", "1.  item\n\n    [a]: a.md \"Deploy now\"\n"],
    ["an unused definition's title changed after a setext heading (it shows nowhere)", "Title\n===\n[a]: a.md \"Do not deploy\"\n", "Title\n===\n[a]: a.md \"Deploy now\"\n"],
    ["a decoded period after a bare URL (trimmed, as GFM trims it)", "See https://x.test/a&#46; now\n", "See https://x.test/a now\n"],
    ["a list renumbered", "1. Drain.\n1. Restart.\n1. Check.\n", "1. Drain.\n2. Restart.\n3. Check.\n"],
    ["a list after a blank line renumbered from 1", "Steps:\n\n3. Drain.\n4. Restart.\n", "Steps:\n\n1. Drain.\n2. Restart.\n"],
    ["a list with continuation lines and nested bullets renumbered", "1. Drain the node\n   and wait.\n   - first\n1. Restart.\n", "1. Drain the node\n   and wait.\n   - first\n2. Restart.\n"],
    ["a fence moved into a quote in a list item", "Run:\n\n```yaml\na:\n  key: v\n```\n", "- Run:\n\n  > ```yaml\n  > a:\n  >   key: v\n  > ```\n"],
    ["a unit capitalised in a heading, then not", "## Wait 5 Minutes\n\nThen check.\n", "## Wait 5 minutes\n\nThen check.\n"],
    ["a fence's characters changed, its info string kept", "```sh\nmake deploy\n```\n", "~~~~ sh\nmake deploy\n~~~~\n"],
    ["one of two headings with the same text renamed", "## Steps\n\nRun `a`.\n\n## Notes\n\nNone.\n\n## Steps\n\nRun `b`.\n", "## Deploy steps\n\nRun `a`.\n\n## Notes\n\nNone.\n\n## Steps\n\nRun `b`.\n"],
    ["a heading's closing hashes dropped", "## Steps ##\n\nRun `a`.\n\n## Rollback\n\nRun `b`.\n", "## Steps\n\nRun `a`.\n\n## Rollback\n\nRun `b`.\n"],
    ["a link whose text is code, moved", "Run [`drain`](drain.md) first.\n", "First, run [`drain`](drain.md).\n"],
    ["a reference whose label holds code, moved", "See [`x`][].\n\n[`x`]: https://a.example\n", "Read [`x`][] first.\n\n[`x`]: https://a.example\n"],
    ["a definition whose title closes on its line, its use reworded", "See [r][x].\n\n[x]: safe.md \"Run it\"\n", "Read [r][x].\n\n[x]: safe.md \"Run it\"\n"],
    ["a definition-like line inside a paragraph whose quote closes later", "He said [x]: a.md \"no\nway\" and left.\n", "He said [x]: a.md \"no\nway\" and then left.\n"],
    ["a definition with balanced parentheses, its use reworded", "See [r][rb].\n\n[rb]: safe(md) \"Do not deploy\"\n", "Read [r][rb].\n\n[rb]: safe(md) \"Do not deploy\"\n"],
  ])("passes %s", (_what, a, b) => {
    expect(polishChanges(fm + a, fm + b)).toEqual([]);
  });

  it.each(NEGATIONS)("counts every %s: dropped, added, capitalised", (w) => {
    const page = `${fm}Step one: ${w} restart it.\n`;
    expect(polishChanges(page, `${fm}Step one: restart it.\n`)).toEqual([expect.stringMatching(new RegExp(`"${w}" appears \\(1 → 0\\)`))]);
    expect(polishChanges(page, `${page}Also ${w} page anyone.\n`)).toEqual([expect.stringMatching(new RegExp(`"${w}" appears \\(1 → 2\\)`))]);
    const cap = w[0]!.toUpperCase() + w.slice(1);
    expect(polishChanges(page, `${fm}${cap} restart it, at step one.\n`)).toEqual([]);
  });
});

// Linear on hostile input: a page must check about as fast as a benign page of the same
// size, timed at the same moment, so a busy runner slows both alike (CI ran a linear
// shape at 521 ms beside the fuzz test). Within 10× of that, and 250 ms at least: every
// quadratic this guards against ran 50 to 1,000 times slower (1.8 s to 22 s at the cap).
// Best of up to three each: a stall hits one run, a quadratic every run.
const BENIGN_LINE = "Wait 5 minutes, then run `make deploy` and read [the guide](g.md). Don't skip it.\n";
function timeBest(page: string): number {
  let best = Infinity;
  for (let r = 0; r < 3; r++) {
    const t0 = performance.now();
    polishChanges(page, page);
    best = Math.min(best, performance.now() - t0);
    if (best < 50) break;
  }
  return best;
}
function expectLinear(page: string, what: string) {
  const hostile = timeBest(page);
  if (hostile < 250) return;
  const benign = timeBest(`${fm}${BENIGN_LINE.repeat(Math.ceil(page.length / BENIGN_LINE.length))}`.slice(0, page.length));
  expect(hostile, `${what}: ${Math.round(hostile)} ms against ${Math.round(benign)} ms for a benign page`).toBeLessThan(Math.max(250, 10 * benign));
}

describe("polish guard: input size", () => {
  it("checks hostile block structures at the cap quickly", () => {
    // Each was quadratic once: blank lines under deep nesting walked every container
    // (15 s), opening thousands of containers on one line copied the rest of the line
    // each time (2 s), and a URL's tail of parentheses was recounted per character (2.4 s).
    for (const page of [
      `${"- ".repeat(16000)}x\n${"\n".repeat(30000)}`,
      `${"> ".repeat(15000)}x\n`.repeat(2),
      `${"- ".repeat(10000)}x\n`.repeat(3),
      `https://example.com/${")".repeat(60000)}\n`,
      `https://example.com/${";".repeat(60000)}\n`,
      `https://example.com/${"&a;".repeat(20000)}\n`,
      `https://example.com/${"&#46;".repeat(12000)}\n`,
    ]) {
      expectLinear(`${fm}${page}`, page.slice(0, 40));
    }
  });

  it("refuses a page over the cap, and checks a hostile one at the cap quickly", () => {
    const big = `${fm}${"x".repeat(POLISH_MAX_CHARS)}\n`;
    expect(polishChanges(big, big)).toEqual(["is over 64 KB, too large to check as a polish; propose specific changes with `edits` instead"]);
    // Unclosed openers that a lazy pattern would rescan to the end for, each repeated up
    // to the cap. Every one measured quadratic before (7 s at 256 KB for `<a b `).
    const nested = (n: number) => `[a${"](".repeat(n)}${")".repeat(n)}\n`;
    // Nested `](` to the cap: quadratic (4.7 s at 30 KB) without the depth cap and the
    // skip past a parsed link (merge gate, PR 3, round 30); either alone keeps it linear.
    for (const unit of [nested(Math.floor((POLISH_MAX_CHARS - 200) / 3)), nested(20), "# a `x`\n", "# a\n## a `x`\n", "](a) ", "[a](b) ", "<a b ", "<?a ", "<!--a ", "<![CDATA[a ", "<!a ", "<s>a ", "``a ", "[a ", "\n[a ", "~~a ", "](a \"",
      // Container markers that can split their spaces two ways backtracked exponentially
      // (found alongside merge gate round 32).
      `${"> ".repeat(40)}\n`, `${">  ".repeat(30)}[a]\n`, `${"-  ".repeat(30)}[a]\n`, `${"> ".repeat(30)}[a]: b\n${"> ".repeat(30)}"t\n`, '[a]: b "x\n', "[a]:\n", "[a]: b\n(x\n", `${"- > ".repeat(30)}\n`, "a\n-\n", "\t\t\t\t#x\n", `${"- ".repeat(40)}[ ] x\n`, `${"> - ".repeat(30)}x\n`, "3. x\n", "      x\n3. y\n", "- ~~~\nx\n",
      // Links that don't parse, each `](` scanning to the line's end (1.9 GB of heap before).
      "[a](b ", "[a](<b ", '[a](b "t ', "[[a](b ",
      // Titles that never close, each scanned to the paragraph's end (1.8 s before).
      "[a](b (t ", "[a](<b> (t "]) {
      const hostile = `${fm}${unit.repeat(Math.floor((POLISH_MAX_CHARS - 100) / unit.length))}\n`;
      expectLinear(hostile, JSON.stringify(unit));
    }
  });
});

describe("replaceBody", () => {
  it.each([
    ["LF", "---\nid: x\n---\nold\n", "new\n", "---\nid: x\n---\nnew\n"],
    ["CRLF frontmatter", "---\r\nid: x\r\n---\r\nold\r\n", "new\r\n", "---\r\nid: x\r\n---\r\nnew\r\n"],
    ["a block that ends the file", "---\nid: x\n---", "Hello\n", "---\nid: x\n---\nHello\n"],
    ["an empty body", "---\nid: x\n---\nold\n", "", "---\nid: x\n---\n"],
    ["no trailing newline, kept as given", "---\nid: x\n---\nold\n", "new", "---\nid: x\n---\nnew"],
  ])("%s", (_what, text, body, want) => {
    expect(replaceBody(text, body)).toBe(want);
  });
});

// The seeded mutation corpus: every covered class, applied to every acme page it can be.
// The guard must catch all of them. A class that applies to no page is a broken corpus.
const acme = loadRepo(ACME);
// acme has no fenced blocks or bare URLs, so two fixture pages carry those classes.
const URL_PAGE = `---
id: rb-y
title: Y
---
# Rotate the key

Open https://vault.example.com/ui/keys and rotate it. It must not be shared.

\`\`\`sh
vault rotate transit/key-a
\`\`\`

\`\`\`sh
vault read transit/key-a
\`\`\`
`;
// And the rarer markdown forms, with CRLF line endings.
const FORMS_PAGE = [
  "---", "id: rb-z", "title: Z", "---", "# Fail over", "",
  "Use [the console][console] and [docs](docs/fail(over).md). See [console].", "",
  "1. Drain the primary:", "   ~~~sh", "   pgctl drain --primary db-1", "   ~~~", "",
  "````", "pgctl promote db-2", "`````", "",
  "[console]: https://console.example.com/db", "",
].join("\r\n");
const texts = [
  ...acme.pages.map((p) => ({ id: p.id, text: readFileSync(join(acme.root, p.path), "utf8") })),
  { id: "fixture:rb-x", text: PAGE },
  { id: "fixture:rb-y", text: URL_PAGE },
  { id: "fixture:rb-z", text: FORMS_PAGE },
];
const bodyStart = (t: string) => t.indexOf("\n---", 3) + 4;
const inBody = (t: string, re: RegExp, f: (m: RegExpExecArray) => string): string | undefined => {
  const start = bodyStart(t);
  re.lastIndex = 0;
  const body = t.slice(start);
  const m = re.exec(body);
  if (!m) return undefined;
  return t.slice(0, start) + body.slice(0, m.index) + f(m) + body.slice(m.index + m[0].length);
};

const MUTATIONS: Record<string, (t: string) => string | undefined> = {
  "drop a negation": (t) => inBody(t, /\b(not|never|no|must|should|only) /i, () => ""),
  "add a negation": (t) => inBody(t, /\b(is|are|can|will) /, (m) => `${m[1]} not `),
  "change a number": (t) => inBody(t, /(?<![\w.`])(\d+)(?=[ %])/, (m) => String(Number(m[1]) + 1)),
  "change a unit": (t) => inBody(t, /(?<![\w.`])(\d+) (minutes|hours|days|seconds|percent|times|replicas|pods)\b/, (m) => `${m[1]} ${m[2] === "hours" ? "minutes" : "hours"}`),
  "swap two numbers": (t) => {
    const body = t.slice(bodyStart(t));
    const nums = [...body.matchAll(/(?<![\w.`/-])(\d+) ([a-z]+)/g)];
    const pair = nums.find((a) => nums.some((b) => b[1] !== a[1] && b[2] !== a[2]));
    const other = pair && nums.find((b) => b[1] !== pair[1] && b[2] !== pair[2]);
    if (!pair || !other) return undefined;
    return t.slice(0, bodyStart(t)) + body.replace(`${pair[1]} ${pair[2]}`, `\u0000 ${pair[2]}`).replace(`${other[1]} ${other[2]}`, `${pair[1]} ${other[2]}`).replace("\u0000", other[1]!);
  },
  "edit a command": (t) => inBody(t, /`([^`\n]*[a-z]-?-?[a-z][^`\n]*)`/, (m) => `\`${m[1]!.replace(/[a-z](?=[^a-z]*$)/, "x")}\``),
  "edit a code block": (t) => inBody(t, /^([ \t]*(?:`{3,}|~{3,})[^\n]*\n)([^\n]+)/m, (m) => m[1]! + m[2]!.replace(/[a-z0-9]/, "Z")),
  "edit the last code block": (t) => {
    const at = [...t.matchAll(/^[ \t]*(?:`{3,}|~{3,})[^\n]*\r?\n([^\n`~]+)/gm)].pop();
    return at ? t.slice(0, at.index! + at[0].length - at[1]!.length) + at[1]!.replace(/[a-z]/, "Z") + t.slice(at.index! + at[0].length) : undefined;
  },
  "repoint a reference": (t) => inBody(t, /^(\[[^\]]+\]:[ \t]*)(\S+)/m, (m) => `${m[1]}${m[2]}-old`),
  "change a link": (t) => inBody(t, /\]\(([^)\s]+)\)/, (m) => `](${m[1]!.replace(/(\.md)?$/, "-old$1")})`),
  "change a URL": (t) => inBody(t, /https?:\/\/[^\s)>\]]+/, (m) => `${m[0]}x`),
  "touch the frontmatter": (t) => t.replace(/^(title: .*)$/m, "$1 "),
};

describe("polish guard: seeded mutation corpus over every acme page", () => {
  for (const [name, mutate] of Object.entries(MUTATIONS)) {
    it(`catches every "${name}"`, () => {
      let applied = 0;
      const missed: string[] = [];
      for (const { id, text } of texts) {
        const after = mutate(text);
        if (after === undefined || after === text) continue;
        applied++;
        if (polishChanges(text, after).length === 0) missed.push(id);
      }
      expect(applied, `"${name}" applied to no page`).toBeGreaterThan(0);
      expect(missed).toEqual([]);
    });
  }
});

// The other half of a gate's score: what it refuses that it shouldn't. These are the
// rewrites a polish is for, applied to every acme page. Each must pass.
const BENIGN: Record<string, (t: string) => string> = {
  "unchanged": (t) => t,
  "rewrapped paragraphs": (t) =>
    t.slice(0, bodyStart(t)) +
    t
      .slice(bodyStart(t))
      .split(/(^```[\s\S]*?^```$)/m)
      .map((part, i) => (i % 2 ? part : part.replace(/([a-z,])\n(?=[a-z(])/g, "$1 ")))
      .join(""),
  "emphasis added": (t) => t.slice(0, bodyStart(t)) + t.slice(bodyStart(t)).replace(/(?<![\w.`])(\d+ (?:minutes|hours|days))/g, "**$1**"),

  "numbered list to bullets": (t) => t.slice(0, bodyStart(t)) + t.slice(bodyStart(t)).replace(/^(\s*)\d+\. /gm, "$1- "),
};

describe("polish guard: benign rewrites of every acme page pass", () => {
  for (const [name, rewrite] of Object.entries(BENIGN)) {
    it(`passes "${name}"`, () => {
      const results = texts.map(({ id, text }) => ({ id, changed: rewrite(text) !== text, changes: polishChanges(text, rewrite(text)) }));
      if (name !== "unchanged") expect(results.filter((r) => r.changed).length, `"${name}" changed no page`).toBeGreaterThan(0);
      expect(results.filter((r) => r.changes.length).map(({ id, changes }) => ({ id, changes }))).toEqual([]);
    });
  }
});

describe("propose_edit with polish: true", () => {
  let repo: ReturnType<typeof acmeOnGitHub>;
  let gh: FakeGitHub;
  beforeEach(() => {
    repo = acmeOnGitHub();
    gh = new FakeGitHub("acme/knowledge", "acme", { alice: { login: "alice", teams: ["platform"], push: true } }, repo.root);
  });
  afterEach(() => {
    repo.cleanup();
    expect(gh.violations).toEqual([]);
  });
  const service = () => new KnowledgeService(repo.root, new IdentityProvider(loadConfig(repo.root), new GitHubClient("alice", { fetch: gh.fetch })), () => NOW);
  const DEPLOY = "knowledge/runbooks/deploy-production.md";

  it("opens a polish PR whose body says what was checked and asks for a read of the diff", async () => {
    const current = gh.file(DEPLOY)!;
    const polished = current.replace("canary\n([ADR-0002]", "canary ([ADR-0002]").replace("## Checks", "## Checks\n");
    const r = await service().proposeEdit({ id: "rb-deploy-prod", content: polished, reason: "Rewrapped the intro.", polish: true });
    expect(gh.pulls[0]).toMatchObject({ head: r.branch, title: "polish(rb-deploy-prod): Deploy to production" });
    expect(gh.pulls[0]?.body).toContain(`**Polish guard:** ${polishSummary(current)}.`);
    expect(gh.pulls[0]?.body).toMatch(/please read the diff before approving/);
    expect(gh.file(DEPLOY, r.branch)).toBe(polished);
  });

  it("refuses a polish that changes a number, naming it, before any branch exists", async () => {
    const err = await service()
      .proposeEdit({ id: "rb-deploy-prod", edits: [{ old: "for 10 minutes", new: "for 5 minutes" }], reason: "tidy", polish: true })
      .catch((e: { code: string; message: string }) => e);
    expect(err).toMatchObject({ code: "invalid" });
    expect((err as { message: string }).message).toMatch(/^a polish must not change what the page says, but this one removed number `10 minutes`; added number `5 minutes`/);
    expect(gh.createdBranches.size).toBe(0);
  });

  it("takes the body as `read` returns it, and keeps the frontmatter byte for byte", async () => {
    const s = service();
    const { content } = await s.read({ id: "rb-deploy-prod" });
    const polished = content.replace("canary\n([ADR-0002]", "canary ([ADR-0002]");
    const r = await s.proposeEdit({ id: "rb-deploy-prod", body: polished, reason: "Rewrapped the intro.", polish: true });
    const current = gh.file(DEPLOY)!;
    expect(gh.file(DEPLOY, r.branch)).toBe(current.slice(0, current.indexOf("\n---\n") + 5) + polished);
  });

  const WHOLE = "this page links to pages you can't see (`[restricted page]` in `read`), so a whole new `body` or `content` written from your view would overwrite or drop those links; propose specific changes with `edits` instead";

  it("on a page with links the caller can't see, refuses a whole body or file, placeholder or not", async () => {
    const s = service();
    const { content } = await s.read({ id: "index" });
    expect(content).toContain("[restricted page]");
    const file = gh.file("knowledge/index.md")!;
    for (const args of [
      { body: `${content}\nOne more line.\n` }, // keeps the placeholders: would write them over the links
      { body: content.replaceAll("[restricted page]", "") }, // drops them: would delete links unseen (review round 2)
      { content: file.slice(0, file.indexOf("\n---\n") + 5) + content },
    ]) {
      const err = await s.proposeEdit({ id: "index", reason: "r", ...args }).catch((e) => e);
      expect(err).toMatchObject({ code: "invalid", message: WHOLE });
    }
    expect(gh.createdBranches.size).toBe(0);
  });

  it("refuses an edit that writes the placeholder, before any branch exists", async () => {
    const err = await service()
      .proposeEdit({ id: "index", edits: [{ old: "See also the [glossary]", new: "[restricted page] See also the [glossary]" }], reason: "r" })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "invalid" });
    expect(err.message).toBe(
      "the proposal contains `[restricted page]`, which `read` shows in place of a link you can't see; writing it would replace that link. Leave those parts out: use `edits` and change only the text around them",
    );
    expect(gh.createdBranches.size).toBe(0);
  });

  it("refuses an edit that writes the placeholder even when another removes a literal one", async () => {
    // Merge gate, PR 3: the total stays the same, so only a per-edit check sees it.
    const path = join(repo.root, "knowledge/index.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("See also the", "A [restricted page] marks a hidden link. See also the"));
    gh = new FakeGitHub("acme/knowledge", "acme", { alice: { login: "alice", teams: ["platform"], push: true } }, repo.root);
    const err = await service()
      .proposeEdit({
        id: "index",
        edits: [
          { old: "A [restricted page] marks a hidden link. ", new: "" },
          { old: "[Secrets handling policy](security/index.md)", new: "[restricted page]" },
        ],
        reason: "r",
      })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "invalid", message: expect.stringMatching(/^the proposal contains `\[restricted page\]`/) });
    expect(gh.createdBranches.size).toBe(0);
  });

  it("counts links to hidden mirrored pages too, when the mirror is served", async () => {
    // A link only to a security-space Confluence page: read shows [restricted page].
    await writeMirror(repo.root, ALL_SPACES);
    serveMirror(repo.root);
    const path = join(repo.root, DEPLOY);
    writeFileSync(path, readFileSync(path, "utf8").replace("## Checks", `Keys: [rotation](${SEC_PAGE.url}).\n\n## Checks`));
    gh = new FakeGitHub("acme/knowledge", "acme", { alice: { login: "alice", teams: ["platform"], push: true } }, repo.root);
    const s = service();
    const { content } = await s.read({ id: "rb-deploy-prod" });
    expect(content).toContain("Keys: [restricted page].");
    const err = await s.proposeEdit({ id: "rb-deploy-prod", body: content.replace("Production deploys", "All production deploys"), reason: "r", polish: true }).catch((e) => e);
    expect(err).toMatchObject({ code: "invalid", message: expect.stringMatching(/^this page links to pages you can't see/) });
    expect(gh.createdBranches.size).toBe(0);
  });

  it("answers a polish of such a page the same whether or not an edit would match hidden text", async () => {
    // Review round 2: checked after applyEdits, "not found" vs this refusal was an oracle.
    const attempt = (old: string) => service().proposeEdit({ id: "index", edits: [{ old, new: "x" }], reason: "r", polish: true }).catch((e) => `${e.code}: ${e.message}`);
    const hit = await attempt("security/rotate-db-credentials.md");
    expect(hit).toBe(await attempt("no-such-text-anywhere.md"));
    expect(hit).toMatch(/^invalid: this page links to pages you can't see/);
  });

  it("refuses to polish a page that links to pages the caller can't see, without naming them", async () => {
    const err = await service()
      .proposeEdit({ id: "index", edits: [{ old: "See also the [glossary]", new: "See the [glossary]" }], reason: "tidy", polish: true })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "invalid" });
    expect(err.message).toBe("this page links to pages you can't see (`[restricted page]` in `read`), so it can't be polished from your view; propose specific changes with `edits` instead");
    expect(gh.createdBranches.size).toBe(0);
    // The same edit is fine as an ordinary one: only polish names what changed.
    await expect(service().proposeEdit({ id: "index", edits: [{ old: "See also the [glossary]", new: "See the [glossary]" }], reason: "tidy" })).resolves.toMatchObject({ pr_number: 1 });
  });

  it("leaves an ordinary edit alone: the same change without polish opens a normal PR", async () => {
    const r = await service().proposeEdit({ id: "rb-deploy-prod", edits: [{ old: "for 10 minutes", new: "for 5 minutes" }], reason: "Canary step shortened." });
    expect(gh.pulls[0]).toMatchObject({ head: r.branch, title: "Proposed edit: Deploy to production" });
    expect(gh.pulls[0]?.body).not.toMatch(/Polish guard/);
  });
});
