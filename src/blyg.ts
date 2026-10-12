// Blygger 0.3 wire surface: ids, rendering, and the static documents.
// Spec: https://blygger.org/spec/0.3/2026-09-28/
import { Marked, type Token, type Tokens } from "marked";
import { decode } from "./tghtml";

export type Kind = "fragment" | "thread" | "withdrawn";
export type AuthoredKind = Exclude<Kind, "withdrawn">;

export type Site = {
  origin: string;
  title: string;
  subtitle: string;
  author: { name: string; url: string };
};

export type Item = {
  id: string;
  kind: Kind;
  authored_kind: AuthoredKind;
  created: string;
  updated: string;
  version: number;
  content_md: string;
  content_html: string;
  content_hash: string;
  // threads only: JSON of the transclusions baked into this version (§10.3)
  transclusions?: string | null;
};

// a reference to the exact version a thread baked (§10.3); origin only for remote sources
export type Transclusion = {
  id: string;
  version: number;
  origin?: string;
  selector?: { exact: string; prefix?: string; suffix?: string };
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

// [[id]] is a plain internal link; ![[id]] and [[id@vN]] inline are inert text (§10.1)
const LINK = /^(!?)\[\[([0-9a-z]{26})(@v\d+)?\]\]/;
// a line that is only ![[id]] is a transclusion directive; blank lines after it detach a following blockquote
const DIRECTIVE = /^[ \t]*!\[\[([0-9a-z]{26})(@v\d+)?\]\][ \t]*(?:\n|$)((?:[ \t]*\n)*)/;
type LinkToken = { type: "blygLink"; raw: string; id: string; live: boolean };
type DirectiveToken = { type: "blygDirective"; raw: string; id: string; versioned: boolean; detached: boolean; live?: boolean; selection?: string };
export type LinkTarget = { url: string; label: string };
// what a directive bakes: the source's html at the version the publisher holds (§10.2)
export type Snapshot = { version: number; html: string; origin?: string };
type Context = { links: Map<string, LinkTarget>; quotes: Map<string, Snapshot> };

// set synchronously around each parse, so concurrent requests never see each other's context
let context: Context = { links: new Map(), quotes: new Map() };

// chat text is plain text: raw HTML is shown, never interpreted; line breaks are kept
const md = new Marked({
  breaks: true,
  renderer: { html: ({ text }) => esc(text) },
  extensions: [{
    name: "blygLink",
    level: "inline",
    start: (src: string) => { const i = src.search(/!?\[\[/); return i < 0 ? undefined : i; },
    tokenizer(src: string): LinkToken | undefined {
      const m = LINK.exec(src);
      if (m) return { type: "blygLink", raw: m[0], id: m[2], live: !m[1] && !m[3] };
    },
    renderer(token) {
      const t = token as LinkToken;
      const target = t.live ? context.links.get(t.id) : undefined;
      return target ? `<a href="${esc(target.url)}">${esc(target.label)}</a>` : esc(t.raw);
    },
  }, {
    name: "blygDirective",
    level: "block",
    // lets a directive line interrupt a paragraph
    start: (src: string) => { const m = /(^|\n)[ \t]*!\[\[[0-9a-z]{26}(@v\d+)?\]\][ \t]*(\n|$)/.exec(src); return m ? m.index + m[1].length : undefined; },
    tokenizer(src: string): DirectiveToken | undefined {
      const m = DIRECTIVE.exec(src);
      if (m) return { type: "blygDirective", raw: m[0], id: m[1], versioned: !!m[2], detached: !!m[3] };
    },
    renderer(token) {
      const t = token as DirectiveToken;
      const snap = t.live ? context.quotes.get(t.id) : undefined;
      // only top-level lines are directives; one inside a quote or list is text
      if (!snap) return `<p>${esc(t.raw.trim())}</p>\n`;
      const attrs = `data-blyg-id="${t.id}" data-blyg-version="${snap.version}"${snap.origin ? ` data-blyg-origin="${esc(snap.origin)}"` : ""}`;
      if (t.selection === undefined) return `<blockquote class="blyg-transclusion" ${attrs}>${snap.html}</blockquote>\n`;
      return `<blockquote class="blyg-transclusion blyg-partial" ${attrs}>\n${t.selection.split("\n").map((l) => `<p>${esc(l)}</p>`).join("\n")}\n</blockquote>\n`;
    },
  }],
});

// top-level directives, in order; a blockquote attached to one (no blank line) becomes its selection
function lex(src: string) {
  const tokens = md.lexer(src);
  const directives: DirectiveToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token | DirectiveToken;
    if (t.type !== "blygDirective") continue;
    const d = t as DirectiveToken;
    d.live = true;
    const next = tokens[i + 1];
    if (!d.detached && next?.type === "blockquote") {
      d.selection = textContent(md.parser((next as Tokens.Blockquote).tokens));
      tokens.splice(i + 1, 1);
    }
    directives.push(d);
  }
  return { tokens, directives };
}

// every URL in content_html must be absolute: it travels to feeds, readers and other blygs (§5.2)
export function render(src: string, origin = "https://invalid./", links = new Map<string, LinkTarget>(), quotes = new Map<string, Snapshot>()) {
  context = { links, quotes };
  try {
    return absolutize(md.parser(lex(src).tokens), origin);
  } finally {
    context = { links: new Map(), quotes: new Map() };
  }
}

// ids named by [[id]] links outside code
export function linkIds(src: string) {
  const ids = new Set<string>();
  md.walkTokens(lex(src).tokens, (t) => { if (t.type === "blygLink" && (t as LinkToken).live) ids.add((t as LinkToken).id); });
  return [...ids];
}

// transclusion directives outside code, in order (§10.1)
export function directives(src: string) {
  return lex(src).directives.map(({ id, versioned, selection }) => ({ id, versioned, selection }));
}

// §10.2's text content: tags stripped, whitespace collapsed within a block, block boundaries as line breaks
export function textContent(html: string) {
  return decode(html.replace(/\s+/g, " ").replace(/<\/?(p|div|h[1-6]|li|ul|ol|blockquote|pre|tr|table|hr|br|figure|figcaption|section|article)\b[^>]*>/gi, "\n").replace(/<[^>]*>/g, ""))
    .split("\n").map((l) => l.replace(/[^\S\n]+/g, " ").trim()).filter(Boolean).join("\n");
}
const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
const rfc822 = (iso: string) => new Date(iso).toUTCString();

// the page lives where the item was authored, through withdrawal and back (§5.8, §9)
export const pagePath = (i: Pick<Item, "id" | "authored_kind">) => `${i.authored_kind === "thread" ? "t" : "f"}/${i.id}/`;

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
    // threads always carry it, a withdrawn thread's endcap as []; fragments omit it (§10.3)
    ...(item.authored_kind === "thread" ? { transclusions: item.kind === "withdrawn" ? [] : JSON.parse(item.transclusions ?? "[]") } : {}),
    changelog: changelog.map((c) => ({
      version: c.version,
      at: c.at,
      note: c.note,
      ...(c.pinned ? { pinned: true } : {}),
    })),
  };
}

// items/{id}/v{n}.json: one pinned version, frozen (§8)
export function pinnedDocument(site: Site, v: Version & Pick<Item, "content_md" | "content_html" | "content_hash" | "transclusions">) {
  return {
    blyg: "0.3",
    id: v.item_id,
    kind: v.kind,
    version: v.version,
    at: v.at,
    note: v.note,
    pinned: true,
    origin: site.origin,
    author: site.author,
    content_md: v.content_md,
    content_html: absolutize(v.content_html, site.origin),
    content_hash: v.content_hash,
    ...(v.kind === "thread" ? { transclusions: JSON.parse(v.transclusions ?? "[]") } : {}),
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
  return html.replace(/(src|href)="(?![a-z][a-z0-9+.-]*:|#)([^"]*)"/gi, (_, attr, url) => `${attr}="${esc(new URL(url.replace(/&amp;/g, "&"), origin).href)}"`);
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
    .blyg-transclusion { margin: 1rem 0; padding: .1rem 1rem; background: #f4f1e8; border-left-color: #a0451f; }
    .blyg-partial { font-style: italic; }
    @media (prefers-color-scheme: dark) { body { color: #ddd; background: #161512; } a { color: #e08a5f; } article { border-color: #333; } .blyg-transclusion { background: #1f1d19; border-left-color: #e08a5f; } }
  </style>
</head>
<body>
${body}
</body>
</html>
`;
}

// the live page cites only versions promised forever: itself and its pins (§8.4)
const pinCitations = (site: Site, item: Item, pins: number[]) =>
  pins.length ? ` · pinned: ${pins.map((n) => `<a href="${esc(site.origin + pagePath(item))}v${n}/">v${n}</a>`).join(", ")}` : "";

export function itemPage(site: Site, item: Item, pins: number[] = []) {
  const url = site.origin + pagePath(item);
  const desc = esc(excerpt(item.content_md, 200));
  const head = `  <link rel="alternate" type="application/json" href="${esc(site.origin)}items/${item.id}.json">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="${esc(site.title)}">
  <meta property="og:title" content="${desc}">
  <meta property="og:url" content="${esc(url)}">
  <meta name="description" content="${desc}">`;
  const body = item.kind === "withdrawn"
    ? `<p class="meta">withdrawn · v${item.version}${pinCitations(site, item, pins)}</p>`
    : `<article>${item.content_html}<p class="meta">${item.kind} · v${item.version} · ${item.updated}${pinCitations(site, item, pins)}</p></article>`;
  return layout(site, excerpt(item.content_md, 60) || site.title, head, `<p class="meta"><a href="${esc(site.origin)}">${esc(site.title)}</a></p>\n${body}`);
}

// {page}v{n}/: the human twin of a pin, visibly frozen, canonical to the live page (§8.4)
export function pinnedPage(site: Site, item: Item, v: Version & Pick<Item, "content_md" | "content_html">) {
  const live = site.origin + pagePath(item);
  const head = `  <link rel="canonical" href="${esc(live)}">
  <link rel="alternate" type="application/json" href="${esc(site.origin)}items/${item.id}/v${v.version}.json">
  <meta name="description" content="${esc(excerpt(v.content_md, 200))}">`;
  const body = `<p class="meta"><a href="${esc(site.origin)}">${esc(site.title)}</a></p>
<p class="meta">frozen: v${v.version} as pinned, published ${v.at} · <a href="${esc(live)}">live version</a> · <a href="${esc(site.origin)}items/${item.id}/v${v.version}.json">json</a></p>
<article>${absolutize(v.content_html, site.origin)}<p class="meta">${v.kind} · v${v.version}${v.note ? ` · ${esc(v.note)}` : ""}</p></article>`;
  return layout(site, `${excerpt(v.content_md, 60) || site.title} (v${v.version})`, head, body);
}

export function indexPage(site: Site, items: Item[]) {
  const list = items
    .filter((i) => i.kind !== "withdrawn")
    .map((i) => `<article>${i.content_html}<p class="meta"><a href="${esc(site.origin + pagePath(i))}">v${i.version} · ${i.updated}</a></p></article>`)
    .join("\n");
  return layout(site, site.title, `  <meta name="description" content="${esc(site.subtitle)}">`, `<h1>${esc(site.title)}</h1>\n<p><em>${esc(site.subtitle)}</em></p>\n<p class="meta"><a href="feed.xml">rss</a> · <a href="blyg.json">blyg.json</a></p>\n${list}`);
}
