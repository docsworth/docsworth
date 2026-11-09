import { useEffect, useState } from "preact/hooks";

// A small history router: the server answers every extensionless path with the app, so
// /p/<id>, /t/<team> and the rest are real URLs that survive a reload or a new tab.

export type Route =
  | { name: "overview" }
  | { name: "search"; q: string }
  | { name: "page"; id: string }
  | { name: "team"; team: string }
  | { name: "graph" }
  | { name: "capture" }
  | { name: "settings" }
  | { name: "missing" };

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export function parseRoute(pathname: string, search: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return { name: "overview" };
  const [head, arg] = parts;
  if (head === "search" && parts.length === 1) return { name: "search", q: new URLSearchParams(search).get("q") ?? "" };
  if (head === "p" && arg && parts.length === 2) return { name: "page", id: decode(arg) };
  if (head === "t" && arg && parts.length === 2) return { name: "team", team: decode(arg) };
  if (parts.length === 1 && (head === "graph" || head === "capture" || head === "settings")) return { name: head };
  return { name: "missing" };
}

/** The current route, and a navigate() that pushes history without a reload. */
export function useRoute(): [Route, (href: string) => void] {
  const where = () => parseRoute(location.pathname, location.search);
  const [route, setRoute] = useState<Route>(where);
  useEffect(() => {
    const onPop = () => setRoute(where());
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const navigate = (href: string) => {
    if (href === `${location.pathname}${location.search}`) return;
    history.pushState(null, "", href);
    setRoute(where());
    scrollTo(0, 0);
  };
  return [route, navigate];
}
