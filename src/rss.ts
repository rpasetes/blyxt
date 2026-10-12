// Plain RSS 2.0 and Atom feeds, read as legacy (L0) entries (§13.6): summary + link, nothing more.
import { decode } from "./tghtml";

export type LegacyEntry = { key: string; link: string | null; title: string; summary: string };
export type LegacyFeed = { title: string | null; entries: LegacyEntry[] };

// an element's text: CDATA verbatim, otherwise entity-escaped
const content = (raw: string) => {
  const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return cdata ? cdata[1] : decode(raw);
};
const element = (xml: string, ...names: string[]) => {
  for (const name of names) {
    const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
    if (m) return content(m[1]).trim();
  }
  return null;
};
const plain = (html: string) => decode(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

export function parseFeed(xml: string, base: string): LegacyFeed {
  const head = xml.replace(/<(item|entry)\b[\s\S]*$/i, "");
  const entries: LegacyEntry[] = [];
  for (const [, body] of xml.matchAll(/<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi)) {
    // Atom links are attributes; RSS links are text
    const atomLink = [...body.matchAll(/<link\b([^>]*)>/gi)]
      .map(([, attrs]) => ({ href: attrs.match(/\bhref="([^"]*)"/i)?.[1], rel: attrs.match(/\brel="([^"]*)"/i)?.[1] ?? "alternate" }))
      .find((l) => l.href && l.rel === "alternate")?.href;
    const href = atomLink ? decode(atomLink) : element(body, "link");
    let link: string | null = null;
    try { link = href ? new URL(href, base).href : null; } catch {}
    const key = element(body, "guid", "id") || link;
    // an entry with nothing to identify it is skipped, never the feed (§13.2)
    if (!key) continue;
    const title = plain(element(body, "title") ?? "");
    const summary = element(body, "description", "summary", "content:encoded", "content") ?? "";
    entries.push({ key, link, title, summary });
  }
  return { title: plain(element(head, "title") ?? "") || null, entries };
}

// origin-scoped synthetic ids that can never be mistaken for a blyg id: those are 26 Crockford base32 characters (§13.6)
export async function syntheticId(key: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return "l0:" + [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}
