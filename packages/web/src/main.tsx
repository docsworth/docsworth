import "@docsworth/ui/theme.css";
import { DocsworthClient } from "@docsworth/ui";
import { render } from "preact";
import { App } from "./app.js";
import { forgetSession, keepSession, keptSession, reloadOnNewToken, takeToken } from "./auth.js";

const token = takeToken(location, sessionStorage, history);
const client = token
  ? new DocsworthClient({
      url: location.origin,
      token,
      name: "docsworth-web",
      session: keptSession(sessionStorage),
      onSession: (id) => keepSession(sessionStorage, id),
      // The session ended after it answered: the reload that follows starts a new one.
      onSessionLost: () => forgetSession(sessionStorage),
    })
  : null;
render(<App client={client} />, document.getElementById("app")!);

reloadOnNewToken(window);
