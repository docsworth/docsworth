// A link as a capture keeps it: absolute, without the parameters that only say who clicked,
// and only where a reader can safely follow it. The live element's `href` is already
// absolute; this decides what's left of it.

/** Query parameters that track the click and say nothing about the page. */
const TRACKING = /^(?:utm_[a-z0-9_]+|fbclid|gclid|gbraid|wbraid|dclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|igshid|yclid|twclid|ttclid|li_fat_id)$/i;

/**
 * `href` without its tracking parameters or credentials, or null when it isn't an http, https
 * or mailto address (a `javascript:` link, `data:`, a relative or unparsable one). An address
 * with nothing to drop comes back exactly as given: re-serializing a query can change it.
 */
export function cleanUrl(href: string): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol === "mailto:") return href;
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const tracked = [...u.searchParams.keys()].filter((k) => TRACKING.test(k));
  if (!tracked.length && !u.username && !u.password) return href;
  for (const k of tracked) u.searchParams.delete(k);
  u.username = "";
  u.password = "";
  return u.href;
}
