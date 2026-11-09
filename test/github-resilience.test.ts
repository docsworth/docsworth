import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/core/config.js";
import { type FetchLike, GitHubClient, GitHubError } from "../src/core/github.js";
import { IdentityError, IdentityProvider } from "../src/core/identity.js";
import { branchName } from "../src/core/writes.js";
import { FakeGitHub } from "./fake-github.js";

// What happens when GitHub doesn't answer, answers 5xx, or rate-limits: reads retry what
// passes, writes never retry, and a rate limit is named as one.

const NOW_MS = Date.UTC(2026, 10, 2, 12);
type Step = { status: number; body?: unknown; headers?: Record<string, string> } | "network" | "hang";

/** A fetch that plays `steps` in order, recording each call's method and path. */
function scripted(steps: Step[]): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(`${init?.method} ${new URL(url).pathname}`);
    const step = steps.shift() ?? { status: 200, body: {} };
    if (step === "network") throw new TypeError("fetch failed");
    if (step === "hang")
      return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    return new Response(step.body === undefined ? "" : JSON.stringify(step.body), { status: step.status, headers: step.headers });
  };
  return { fetch, calls };
}

const client = (steps: Step[], timeoutMs = 30_000) => {
  const s = scripted(steps);
  const waits: number[] = [];
  const gh = new GitHubClient("ghp_test", { fetch: s.fetch, sleep: async (ms) => void waits.push(ms), now: () => NOW_MS, timeoutMs });
  return { gh, calls: s.calls, waits };
};

describe("GitHub reads retry what passes", () => {
  it("retries a 502 and returns the answer", async () => {
    const { gh, calls, waits } = client([{ status: 502, body: { message: "Bad Gateway" } }, { status: 200, body: { login: "alice" } }]);
    await expect(gh.getUser()).resolves.toEqual({ login: "alice" });
    expect(calls).toEqual(["GET /user", "GET /user"]);
    expect(waits).toEqual([500]);
  });

  it("retries a dropped connection", async () => {
    const { gh, calls } = client(["network", { status: 200, body: { login: "alice" } }]);
    await expect(gh.getUser()).resolves.toEqual({ login: "alice" });
    expect(calls).toHaveLength(2);
  });

  it("waits out a secondary rate limit GitHub says lifts in seconds", async () => {
    const { gh, waits } = client([
      { status: 403, body: { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." }, headers: { "retry-after": "3" } },
      { status: 200, body: { login: "alice" } },
    ]);
    await expect(gh.getUser()).resolves.toEqual({ login: "alice" });
    expect(waits).toEqual([3000]);
  });

  it("doesn't retry a rate limit that comes without a time (retrying soon prolongs it)", async () => {
    for (const step of [
      { status: 403, body: { message: "You have exceeded a secondary rate limit." } },
      { status: 429, body: { message: "Too Many Requests" } },
    ]) {
      const { gh, calls, waits } = client([step, { status: 200, body: { login: "alice" } }]);
      await expect(gh.getUser()).rejects.toMatchObject({ rateLimited: true, retryAfter: null });
      expect(calls).toHaveLength(1);
      expect(waits).toEqual([]);
    }
  });

  it("takes a 403 with retry-after for a rate limit, whatever its message says", async () => {
    const { gh, waits } = client([{ status: 403, body: { message: "Forbidden" }, headers: { "retry-after": "2" } }, { status: 200, body: { login: "alice" } }]);
    await expect(gh.getUser()).resolves.toEqual({ login: "alice" });
    expect(waits).toEqual([2000]);
  });

  it("doesn't retry a fault of its own as if GitHub hadn't answered", async () => {
    let calls = 0;
    const gh = new GitHubClient("ghp_test", { fetch: async () => { calls++; throw new RangeError("bug"); }, sleep: async () => {}, now: () => NOW_MS });
    await expect(gh.getUser()).rejects.toThrow(RangeError);
    expect(calls).toBe(1);
  });

  it("throws a body it can't serialize as is, without calling GitHub", async () => {
    const { gh, calls } = client([]);
    await expect(gh.request("POST", "/x", { n: 1n })).rejects.toThrow(TypeError);
    expect(calls).toEqual([]);
  });

  it("gives up after three tries, with GitHub's error", async () => {
    const { gh, calls } = client([{ status: 503 }, { status: 503 }, { status: 503 }, { status: 200, body: {} }]);
    const err = await gh.getUser().catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.status).toBe(503);
    expect(calls).toHaveLength(3);
  });

  it("doesn't wait out a primary rate limit that lifts in half an hour, and says when it does", async () => {
    const reset = String(NOW_MS / 1000 + 1800);
    const { gh, calls, waits } = client([{ status: 403, body: { message: "API rate limit exceeded for user ID 1." }, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } }]);
    const err = await gh.getUser().catch((e) => e);
    expect(err).toMatchObject({ status: 403, rateLimited: true, retryAfter: 1800 });
    expect(err.message).toBe("GitHub GET /user → 403: API rate limit exceeded for user ID 1. (rate limited; retry in 1800 s)");
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it("times out a request GitHub never answers, and retries it", async () => {
    const { gh, calls } = client(["hang", "hang", "hang"], 20);
    const err = await gh.getUser().catch((e) => e);
    expect(err).toMatchObject({ status: 0 });
    expect(err.message).toBe("GitHub GET /user → no answer: no answer within 0.02 s");
    expect(calls).toHaveLength(3);
  });

  it("doesn't retry a 404 or a plain 403", async () => {
    for (const status of [404, 403]) {
      const { gh, calls } = client([{ status, body: { message: "Not Found" } }]);
      await expect(gh.getUser()).rejects.toMatchObject({ status, rateLimited: false });
      expect(calls).toHaveLength(1);
    }
  });
});

describe("GitHub writes never retry", () => {
  it("doesn't retry a POST that got a 502 (a second try could open a second PR)", async () => {
    const { gh, calls } = client([{ status: 502 }, { status: 201, body: { number: 1 } }]);
    await expect(gh.createPull("acme/knowledge", { title: "t", head: "docsworth/x", base: "main", body: "" })).rejects.toMatchObject({ status: 502 });
    expect(calls).toEqual(["POST /repos/acme/knowledge/pulls"]);
  });

  it("doesn't retry a write that got no answer", async () => {
    const { gh, calls } = client(["network", { status: 201, body: {} }]);
    await expect(gh.createBranch("acme/knowledge", "docsworth/x", "abc")).rejects.toMatchObject({ status: 0 });
    expect(calls).toHaveLength(1);
  });
});

describe("identity under GitHub's limits", () => {
  const config = ConfigSchema.parse({ github: { org: "acme", repo: "acme/knowledge" } });
  const fakeGh = () => new FakeGitHub("acme/knowledge", "acme", { alice: { login: "alice", teams: ["platform"], push: true } });
  /** The fake, with `path` answering `step` the first `times` times it's asked. */
  const failing = (gh: FakeGitHub, path: string, step: { status: number; body: unknown; headers?: Record<string, string> }, times = 99): FetchLike => {
    let left = times;
    return async (url, init) => {
      if (new URL(url).pathname === path && left-- > 0) return new Response(JSON.stringify(step.body), { status: step.status, headers: step.headers });
      return gh.fetch(url, init);
    };
  };
  const provider = (fetch: FetchLike, log?: (m: string) => void) =>
    new IdentityProvider(config, new GitHubClient("alice", { fetch, sleep: async () => {}, now: () => NOW_MS }), undefined, log);

  it("names a rate limit as one, not as no access to the repo", async () => {
    const reset = String(NOW_MS / 1000 + 1800);
    const fetch = failing(fakeGh(), "/repos/acme/knowledge", { status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } });
    const err = await provider(fetch).get().catch((e) => e);
    expect(err).toBeInstanceOf(IdentityError);
    expect(err.message).toBe("GitHub's rate limit for this token is reached; it lifts in 30 min, so access can't be checked until then");
  });

  it("still says no access for a 403 that isn't a rate limit", async () => {
    const fetch = failing(fakeGh(), "/repos/acme/knowledge", { status: 403, body: { message: "Resource not accessible" } });
    await expect(provider(fetch).get()).rejects.toThrow("no access to acme/knowledge with this token (GitHub said 403)");
  });

  it("doesn't take a rate limit on team lookup for a missing read:org scope", async () => {
    const logs: string[] = [];
    const fetch = failing(fakeGh(), "/user/teams", { status: 403, body: { message: "You have exceeded a secondary rate limit" }, headers: { "retry-after": "120" } });
    const err = await provider(fetch, (m) => logs.push(m)).get().catch((e) => e);
    expect(err).toBeInstanceOf(IdentityError);
    expect(err.message).toMatch(/^GitHub's rate limit for this token is reached; it lifts in 2 min/);
    expect(logs.join("\n")).not.toMatch(/read:org/);
  });

  it("rides out a brief outage when the cache refreshes", async () => {
    const fetch = failing(fakeGh(), "/user", { status: 502, body: { message: "Bad Gateway" } }, 1);
    await expect(provider(fetch).get()).resolves.toMatchObject({ login: "alice", teams: new Set(["platform"]) });
  });
});

describe("concurrent proposals", () => {
  it("give two proposals on one page in the same second different branches", () => {
    const at = new Date(NOW_MS);
    const names = new Set(Array.from({ length: 50 }, () => branchName("propose", "rb-deploy-prod", at)));
    expect(names.size).toBe(50);
    expect([...names][0]).toMatch(/^docsworth\/propose\/rb-deploy-prod-20261102T120000-[0-9a-f]{6}$/);
  });
});
