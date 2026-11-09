import { type Capabilities, DocsworthClient, DocsworthError, ErrorNotice } from "@docsworth/ui";
import type { TargetedEvent } from "preact";
import { useState } from "preact/hooks";
import { DEFAULT_SERVER, parsePairing, serverOrigin } from "../settings.js";

// Connecting the extension to `docsworth serve`: paste the link it printed (or its token).
// The token is kept until Chrome quits, in storage the page's content scripts can't read,
// and is never shown again here. The connection test opens a session and closes it.

export type OptionsEnv = {
  extensionId: string;
  server: string;
  connected: boolean;
  save: (server: string, token: string | null) => Promise<void>;
  /** For tests: the client the connection test uses. */
  client?: (server: string, token: string) => DocsworthClient;
};

/** What a failed connection test means, in the words a person needs. */
export function explain(error: unknown, server: string, extensionId: string): string {
  if (error instanceof DocsworthError) {
    if (error.code === "unauthorized") return "The server didn't accept that token. `docsworth serve --print-token` shows the current one.";
    if (error.code === "forbidden") return `The server doesn't answer this extension yet. Start it with: docsworth serve --allow-extension ${extensionId}`;
    return error.message;
  }
  return `No docsworth serve answered at ${server}. Is it running, on that port?`;
}

export function Options({ env }: { env: OptionsEnv }) {
  const [server, setServer] = useState(env.server || DEFAULT_SERVER);
  const [pasted, setPasted] = useState("");
  const [connected, setConnected] = useState(env.connected);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: true; caps: Capabilities } | { ok: false; message: string } | null>(null);
  const command = `docsworth serve --allow-extension ${env.extensionId}`;

  const submit = async (e: TargetedEvent<HTMLFormElement>) => {
    e.preventDefault();
    const pairing = parsePairing(pasted);
    const origin = serverOrigin(pairing?.server ?? server);
    if (!pairing || !origin) {
      setResult({ ok: false, message: !pairing ? "Paste the link docsworth serve printed, or its token (43 characters)." : "The server must be http://127.0.0.1:<port> or http://localhost:<port>." });
      return;
    }
    setBusy(true);
    setResult(null);
    const client = env.client?.(origin, pairing.token) ?? new DocsworthClient({ url: origin, token: pairing.token, name: "docsworth-extension" });
    try {
      let caps: Capabilities | null = null;
      let failure: unknown = null;
      try {
        caps = await client.call<Capabilities>("ui_capabilities");
      } catch (err) {
        failure = err;
      }
      await client.close(); // the test's session is closed before anything is saved or said
      if (!caps) {
        setResult({ ok: false, message: explain(failure, origin, env.extensionId) });
        return;
      }
      await env.save(origin, pairing.token);
      setServer(origin);
      setPasted(""); // the token isn't kept in the form
      setConnected(true);
      setResult({ ok: true, caps });
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    await env.save(server, null);
    setConnected(false);
    setResult(null);
  };

  return (
    <main class="dw-main">
      <h1>Connect Docsworth</h1>
      <p class="dw-sub">The extension talks only to docsworth serve on this machine, as you.</p>
      <ol>
        <li>
          Start the server so it answers this extension: <code>{command}</code>
        </li>
        <li>Paste the link it printed (or the token from <code>docsworth serve --print-token</code>) and connect.</li>
      </ol>
      <form class="dw-form" onSubmit={submit}>
        <label>
          <span>Server</span>
          <input value={server} onInput={(e) => setServer(e.currentTarget.value)} placeholder={DEFAULT_SERVER} />
        </label>
        <label>
          <span>Link or token</span>
          <input type="password" autocomplete="off" value={pasted} onInput={(e) => setPasted(e.currentTarget.value)} placeholder="http://127.0.0.1:4747/#t=…" />
        </label>
        <div>
          <button type="submit" disabled={busy || !pasted.trim()}>
            {busy ? "Connecting…" : "Connect"}
          </button>{" "}
          {connected && (
            <button type="button" class="secondary" onClick={forget}>
              Forget the token
            </button>
          )}
        </div>
      </form>
      {result?.ok && (
        <div class="dw-note" role="status">
          Connected to {result.caps.repo ?? `${result.caps.org} (local)`}, {result.caps.mode === "github" ? `as @${result.caps.login}` : "in local mode"}.
        </div>
      )}
      {result && !result.ok && <ErrorNotice error={result.message} />}
      <p class="dw-muted">
        {connected ? "Connected. " : ""}Chrome forgets the token when it quits; paste it again then. It's kept where pages and their scripts can't read it.
      </p>
    </main>
  );
}
