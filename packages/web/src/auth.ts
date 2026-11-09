// The token and session handoff. `docsworth serve` prints a URL with the token in its
// fragment (#t=…), which the browser never sends to a server. On load the app moves it to
// sessionStorage (this tab only) and takes it out of the address bar and history.

const TOKEN = "docsworth-token";
const SESSION = "docsworth-session";

function read(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null; // storage blocked: the tab works until it is reloaded
  }
}

function write(storage: Storage, key: string, value: string | null): void {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    /* storage blocked */
  }
}

/** The token from the URL fragment (then cleared from it), or the one this tab kept. */
export function takeToken(loc: Pick<Location, "hash" | "pathname" | "search">, storage: Storage, history: Pick<History, "replaceState">): string | null {
  const m = /^#t=([A-Za-z0-9_-]{43})$/.exec(loc.hash);
  if (m) {
    // A new token means a new server, or a rotated token: its sessions are new too.
    if (read(storage, TOKEN) !== m[1]) write(storage, SESSION, null);
    write(storage, TOKEN, m[1]!);
    history.replaceState(null, "", `${loc.pathname}${loc.search}`);
    return m[1]!;
  }
  return read(storage, TOKEN);
}

export const keptSession = (storage: Storage) => read(storage, SESSION);
export const keepSession = (storage: Storage, id: string) => write(storage, SESSION, id);
export const forgetSession = (storage: Storage) => write(storage, SESSION, null);

/**
 * Opening the printed link in a tab already showing the app changes only the fragment,
 * which doesn't reload the page: reload so the new token is taken.
 */
export function reloadOnNewToken(target: Pick<Window, "addEventListener"> & { location: Pick<Location, "hash" | "reload"> }): void {
  target.addEventListener("hashchange", () => {
    if (/^#t=/.test(target.location.hash)) target.location.reload();
  });
}
