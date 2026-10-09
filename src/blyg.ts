// Blygger 0.3 wire surface: ids, rendering, and the static documents.
// Spec: https://blygger.org/spec/0.3/2026-09-28/
import { Marked } from "marked";

export type Kind = "fragment" | "thread" | "withdrawn";

export type Site = {
  origin: string;
  title: string;
  subtitle: string;
  author: { name: string; url: string };
};

export type Item = {
  id: string;
  kind: Kind;
  created: string;
  updated: string;
  version: number;
  content_md: string;
  content_html: string;
  content_hash: string;
};

export type Version = {
  item_id: string;
  version: number;
  kind: Kind;
  at: string;
  note: string | null;
  pinned: number;
};

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export const ID_RE = /^[0-9a-hjkmnp-tv-z]{26}$/;
export const FEED_WINDOW = 50;

export const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

// 26 chars of Crockford base32 over 128 random bits (§5.1)
export function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let id = "";
  for (let i = 0; i < 26; i++) {
    id = ALPHABET[Number(n & 31n)] + id;
    n >>= 5n;
  }
  return id;
}

export async function contentHash(md: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(md));
  return "sha256:" + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// chat text is plain text: raw HTML is shown, never interpreted; line breaks are kept
const md = new Marked({ breaks: true, renderer: { html: ({ text }) => esc(text) } });
export const render = (src: string) => md.parse(src, { async: false }) as string;
const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
const rfc822 = (iso: string) => new Date(iso).toUTCString();

export const pagePath = (i: Pick<Item, "id" | "kind">) => `${i.kind === "thread" ? "t" : "f"}/${i.id}/`;

export function excerpt(md: string, n = 80) {
  const s = md.replace(/!\[\[[^\]]+\]\]/g, "").replace(/^\s*>+/gm, "").replace(/[#*_`\[\]()!]/g, "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n).trimEnd() + "…" : s;
}

export function manifest(site: Site, updated: string) {
  return {
    blyg: "0.3",
    level: 1,
    generator: "blyxt/0.1.0",
    generator_url: "https://github.com/rpasetes/blyxt",
    site: site.origin,
    title: site.title,
    author: site.author,
    feed: "feed.xml",
    items: "items/index.json",
    updated,
  };
}

export function itemDocument(site: Site, item: Item, changelog: Version[]) {
  return {
    blyg: "0.3",
    id: item.id,
    kind: item.kind,
    origin: site.origin,
    page: pagePath(item),
    author: site.author,
    created: item.created,
    updated: item.updated,
    version: item.version,
    content_md: item.content_md,
    content_html: item.content_html,
    content_hash: item.content_hash,
    media: [],
    changelog: changelog.map((c) => ({
      version: c.version,
      at: c.at,
      note: c.note,
      ...(c.pinned ? { pinned: true } : {}),
    })),
  };
}

export function archiveIndex(items: Item[], updated: string) {
  return {
    updated,
    items: items.map(({ id, kind, created, updated, version }) => ({ id, kind, created, updated, version })),
  };
}

// one <item> per publish event, newest first; description carries the item's latest HTML (§7)
export function feed(site: Site, events: Version[], latest: Map<string, Item>, updated: string) {
  const entries = events.map((e) => {
    const item = latest.get(e.item_id)!;
    const link = site.origin + pagePath(item);
    const title = e.kind === "withdrawn" ? "withdrawn" : e.note ? `${e.note} — ${excerpt(item.content_md)}` : excerpt(item.content_md);
    return `    <item>
      <guid isPermaLink="false">blyg:${e.item_id}:v${e.version}</guid>
      <link>${esc(link)}</link>
      <title>${esc(title)}</title>
      <description>${cdata(absolutize(item.content_html, site.origin))}</description>
      <pubDate>${rfc822(e.at)}</pubDate>
      <dc:creator>${esc(site.author.name)}</dc:creator>
      <blyg:id>${e.item_id}</blyg:id>
      <blyg:kind>${e.kind}</blyg:kind>
      <blyg:version>${e.version}</blyg:version>
      <blyg:created>${item.created}</blyg:created>
      <blyg:item>${esc(site.origin)}items/${e.item_id}.json</blyg:item>
    </item>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:blyg="https://blygger.org/ns/0.1" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${esc(site.title)}</title>
    <link>${esc(site.origin)}</link>
    <description>${esc(site.subtitle)}</description>
    <lastBuildDate>${rfc822(updated)}</lastBuildDate>
    <blyg:level>1</blyg:level>
    <blyg:manifest>${esc(site.origin)}blyg.json</blyg:manifest>
${entries.join("\n")}
  </channel>
</rss>
`;
}

function absolutize(html: string, origin: string) {
  return html.replace(/(src|href)="(?![a-z]+:|#|\/\/)([^"]*)"/g, (_, attr, url) => `${attr}="${new URL(url, origin).href}"`);
}

function layout(site: Site, title: string, head: string, body: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <link rel="blyg" href="${esc(site.origin)}">
  <link rel="alternate" type="application/rss+xml" title="${esc(site.title)}" href="${esc(site.origin)}feed.xml">
${head}
  <style>
    body { max-width: 38rem; margin: 2rem auto; padding: 0 1rem; font: 17px/1.55 Georgia, serif; color: #222; background: #fdfcf8; }
    a { color: #a0451f; } .meta { font: 13px/1.4 ui-monospace, monospace; color: #777; }
    article { border-bottom: 1px solid #e5e0d5; padding: 1rem 0; }
    blockquote { margin: 0; padding-left: 1rem; border-left: 3px solid #e5e0d5; }
    @media (prefers-color-scheme: dark) { body { color: #ddd; background: #161512; } a { color: #e08a5f; } article { border-color: #333; } }
  </style>
</head>
<body>
${body}
</body>
</html>
`;
}

export function itemPage(site: Site, item: Item) {
  const url = site.origin + pagePath(item);
  const desc = esc(excerpt(item.content_md, 200));
  const head = `  <link rel="alternate" type="application/json" href="${esc(site.origin)}items/${item.id}.json">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="${esc(site.title)}">
  <meta property="og:title" content="${desc}">
  <meta property="og:url" content="${esc(url)}">
  <meta name="description" content="${desc}">`;
  const body = item.kind === "withdrawn"
    ? `<p class="meta">withdrawn · v${item.version}</p>`
    : `<article>${item.content_html}<p class="meta">${item.kind} · v${item.version} · ${item.updated}</p></article>`;
  return layout(site, excerpt(item.content_md, 60) || site.title, head, `<p class="meta"><a href="${esc(site.origin)}">${esc(site.title)}</a></p>\n${body}`);
}

export function indexPage(site: Site, items: Item[]) {
  const list = items
    .filter((i) => i.kind !== "withdrawn")
    .map((i) => `<article>${i.content_html}<p class="meta"><a href="${esc(site.origin + pagePath(i))}">v${i.version} · ${i.updated}</a></p></article>`)
    .join("\n");
  return layout(site, site.title, `  <meta name="description" content="${esc(site.subtitle)}">`, `<h1>${esc(site.title)}</h1>\n<p><em>${esc(site.subtitle)}</em></p>\n<p class="meta"><a href="feed.xml">rss</a> · <a href="blyg.json">blyg.json</a></p>\n${list}`);
}
