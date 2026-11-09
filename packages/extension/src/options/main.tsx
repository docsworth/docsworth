import "@docsworth/ui/theme.css";
import { render } from "preact";
import { loadSettings, saveSettings } from "../settings.js";
import { Options } from "./app.js";

async function main() {
  const { server, token } = await loadSettings(chrome.storage);
  render(
    <Options
      env={{
        extensionId: chrome.runtime.id,
        server,
        connected: token !== null,
        save: (next, nextToken) => saveSettings(chrome.storage, next, nextToken),
      }}
    />,
    document.getElementById("app")!,
  );
}

void main();
