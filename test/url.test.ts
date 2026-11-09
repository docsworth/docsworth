import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/core/config.js";
import { GitHubClient } from "../src/core/github.js";
import { IdentityProvider } from "../src/core/identity.js";
import { insecureUrl } from "../src/core/url.js";

// A token sent over plain http is a token on the wire in clear. Every URL that carries a
// credential is https, or http on loopback only (local fakes and tests). Pro's connectors
// are held to the same rule in pro's tests.

const HTTP = /must use https:\/\/ \(plain http is allowed only on loopback\), since the token is sent to it/;

describe("credentialed URLs are https, or loopback", () => {
  it.each(["https://ghe.example.com/api/v3", "http://127.0.0.1:8080", "http://localhost:3000/api", "http://[::1]:9/", "http://localhost.:3000"])("allows %s", (u) => {
    expect(insecureUrl(u)).toBeNull();
  });
  it.each(["http://ghe.example.com/api/v3", "http://10.0.0.5/api/v3", "ftp://ghe.example.com", "http://localhost.evil.com/"])("refuses %s", (u) => {
    expect(insecureUrl(u)).toMatch(/must use https/);
  });

  it.each(["https://alice:secret@ghe.example.com/api/v3", "http://alice@127.0.0.1:9"])("refuses a user or password in %s", (u) => {
    expect(insecureUrl(u)).toMatch(/^must not carry a user name or password/);
  });

  it("names only the scheme and host in its errors, never a password or path", () => {
    let message = "";
    try {
      new GitHubClient("t", { baseUrl: "http://alice:s3cret@ghe.example.com/api/v3" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe("the GitHub API URL (http://ghe.example.com) must not carry a user name or password; give credentials through their own setting");
  });

  it("config refuses a plain-http GHES api_url, naming the field", () => {
    const r = ConfigSchema.safeParse({ github: { org: "acme", repo: "acme/k", api_url: "http://ghe.example.com/api/v3" } });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message)).toEqual([expect.stringMatching(new RegExp(`^github\\.api_url ${HTTP.source}`))]);
    expect(ConfigSchema.safeParse({ github: { org: "acme", api_url: "https://ghe.example.com/api/v3" } }).success).toBe(true);
  });

  it("config refuses a plain-http Confluence base_url, naming the field", () => {
    const source = (base_url: string) => ({ github: { org: "acme" }, mirror: { sources: [{ kind: "confluence", base_url, spaces: [{ key: "ENG" }] }] } });
    const r = ConfigSchema.safeParse(source("http://acme.atlassian.net/wiki"));
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message)).toEqual([expect.stringMatching(new RegExp(`^base_url ${HTTP.source}`))]);
    expect(ConfigSchema.safeParse(source("https://acme.atlassian.net/wiki")).success).toBe(true);
  });

  it("the GitHub client refuses one from DOCSWORTH_GITHUB_API_URL, which no schema sees", () => {
    expect(() => new GitHubClient("t", { baseUrl: "http://ghe.example.com/api/v3" })).toThrow(new RegExp(`^the GitHub API URL \\(http://ghe\\.example\\.com\\) ${HTTP.source}`));
    const config = ConfigSchema.parse({ github: { org: "acme", repo: "acme/k" } });
    expect(() => IdentityProvider.fromEnv(config, { GITHUB_TOKEN: "ghp_x", DOCSWORTH_GITHUB_API_URL: "http://ghe.example.com/api/v3" })).toThrow(HTTP);
    expect(() => new GitHubClient("t", { baseUrl: "http://127.0.0.1:9" })).not.toThrow();
  });
});
