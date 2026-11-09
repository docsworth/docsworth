import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { DocsworthError } from "../client.js";
import { ErrorNotice } from "./basics.js";

// Tool calls in a view, shared by the web app and the extension's side panel.

export type Call<T> = { data?: T; error?: unknown; loading: boolean };

/**
 * A tool call that reruns when `key` changes; the latest answer wins. A view whose session
 * ended reloads the page, so every view is read again in a new session (the client refuses
 * everything until then). A write form shows that error instead, keeping what was typed.
 */
export function useCall<T>(run: () => Promise<T>, key: string): Call<T> {
  const [state, setState] = useState<Call<T>>({ loading: true });
  useEffect(() => {
    let live = true;
    setState({ loading: true });
    run().then(
      (data) => live && setState({ data, loading: false }),
      (error: unknown) => {
        if (error instanceof DocsworthError && error.code === "session_expired") location.reload();
        if (live) setState({ error, loading: false });
      },
    );
    return () => {
      live = false;
    };
  }, [key]);
  return state;
}

export function Loaded<T>({ call, children }: { call: Call<T>; children: (data: T) => ComponentChildren }) {
  if (call.error) return <ErrorNotice error={call.error} />;
  if (call.loading || call.data === undefined) return <p class="dw-muted">Loading…</p>;
  return <>{children(call.data)}</>;
}
