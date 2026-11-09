import { describe, expect, it } from "vitest";
import { splitFrontmatter } from "../src/core/frontmatter.js";
import { extractLinks, isPage, parsePage } from "../src/core/repo.js";

const VALID = `---
title: Deploying to production
id: rb-deploy-prod
type: runbook
status: canonical
owner_team: platform
last_verified: 2026-10-15
review_every: 90d
supersedes: [rb-deploy-legacy]
applies_to: [service:payments]
---
# Deploy

See [the ADR](../decisions/ADR-0001-x.md#why), [external](https://x.io) and [anchor](#top).
`;

describe("frontmatter", () => {
  it("keeps dates as strings (core schema)", () => {
    const doc = splitFrontmatter(VALID);
    expect(doc.data?.last_verified).toBe("2026-10-15");
    expect(doc.data?.review_every).toBe("90d");
  });

  it("reports a missing or unterminated block", () => {
    expect(splitFrontmatter("# just markdown").error).toMatch(/missing/);
    expect(splitFrontmatter("---\ntitle: x\n").error).toMatch(/unterminated/);
  });

  it("parses a valid page with defaults applied", () => {
    const page = parsePage("knowledge/runbooks/deploy.md", VALID);
    expect(isPage(page)).toBe(true);
    if (!isPage(page)) return;
    expect(page.acl).toBe("internal");
    expect(page.headings).toEqual(["Deploy"]);
    expect(page.links).toEqual(["../decisions/ADR-0001-x.md"]);
  });

  it("extracts only relative links", () => {
    expect(extractLinks("[a](b.md) [c](http://x) [d](mailto:a@b) [e](#f) [g](./h.md \"title\")")).toEqual([
      "b.md",
      "./h.md",
    ]);
  });
});
