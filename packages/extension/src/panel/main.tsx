import "@docsworth/ui/theme.css";
import { DocsworthClient } from "@docsworth/ui";
import { render } from "preact";
import { PENDING_PREFIX } from "../contract.js";
import { donePending, takePending } from "../pending.js";
import { loadSettings, sessionKey } from "../settings.js";
import { Panel } from "./app.js";

// The side panel's wiring to Chrome. One panel document per window; its MCP session is kept
// under the window, so reopening the panel resumes it rather than opening another.

async function main() {
  const windowId = (await chrome.windows.getCurrent()).id!;
  const { server, token } = await loadSettings(chrome.storage);
  const key = sessionKey(windowId);
  const kept = (await chrome.storage.session.get(key))[key];
  const client = token
    ? new DocsworthClient({
        url: server,
        token,
        name: "docsworth-extension",
        session: typeof kept === "string" ? kept : null,
        onSession: (id) => void chrome.storage.session.set({ [key]: id }),
        // The session ended after it answered: the reload that follows starts a new one.
        onSessionLost: () => void chrome.storage.session.remove(key),
      })
    : null;

  const seen = new Set<string>();
  const captures: Parameters<typeof Panel>[0]["env"]["captures"] = (cb, gone) => {
    // A pull that failed gave nothing: the next change, or the next open, gives them.
    const pull = () => void takePending(chrome.storage.session, windowId, Date.now(), seen).then((batch) => batch.length && cb(batch), () => undefined);
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== "session") return;
      const mine = Object.entries(changes).filter(([k]) => k.startsWith(PENDING_PREFIX));
      const removed = mine.filter(([, c]) => c.newValue === undefined).map(([k]) => k);
      if (removed.length) gone(removed);
      if (mine.some(([, c]) => c.newValue !== undefined)) pull();
    };
    chrome.storage.onChanged.addListener(onChanged);
    pull();
    return () => chrome.storage.onChanged.removeListener(onChanged);
  };

  // Connected again from the options page (another token or server): start over.
  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === "session" && "token" in changes) || (area === "local" && "server" in changes)) location.reload();
  });

  render(
    <Panel
      env={{
        client,
        captures,
        // A remove that failed leaves the capture to its alarm; until then a reload shows it again.
        done: (k) => void donePending(chrome.storage.session, k).catch(() => undefined),
        openOptions: () => void chrome.runtime.openOptionsPage(),
        newSession: () => {
          void (async () => {
            await client?.close();
            await chrome.storage.session.remove(key);
            location.reload();
          })();
        },
        extensionId: chrome.runtime.id,
      }}
    />,
    document.getElementById("app")!,
  );
}

void main();
