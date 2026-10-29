// Resolution: from a shared URL to a blyg subscription (spec §12).
export const USER_AGENT = "blyxt/0.1.0 (+https://github.com/rpasetes/blyxt)";

export type Manifest = { blyg: string; site?: string; title?: string; feed?: string; items?: string; item?: string; pin?: string; [k: string]: unknown };

// The manifest locates the surface (§6.1): item and pin are RFC 6570 level-1 templates for where a blyg's
// documents live, defaulting to these. A value may carry a query string, because it is expanded and then
// fetched, never resolved against; a relative one is relative to the origin
export const ITEM_TEMPLATE = "items/{id}.json";
export const PIN_TEMPLATE = "items/{id}/v{n}.json";

export function expand(template: string, vars: Record<string, string | number>, origin: string) {
  return new URL(template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? encodeURIComponent(String(vars[k])) : m)), origin).href;
}

// a blyg's item document, by its own template when it has one
export const itemUrl = (origin: string, template: string | null | undefined, id: string) => expand(template || ITEM_TEMPLATE, { id }, origin);

// a manifest's template, kept only when it is a string naming its variables (else the default applies)
export const templateOf = (value: unknown, ...vars: string[]) =>
  typeof value === "string" && value.trim() && vars.every((v) => value.includes(`{${v}}`)) ? value.trim() : null;

// the item document of a post at any origin: through the template of a blyg blyxt follows, else the default.
// This is a post's one mentionable address when its page isn't known (§15.2): never a guessed f/ or t/ path
export async function itemDocUrl(db: D1Database, origin: string, id: string) {
  const sub = await db.prepare("SELECT item_tpl FROM subscriptions WHERE origin = ?").bind(origin).first<{ item_tpl: string | null }>();
  return itemUrl(origin, sub?.item_tpl, id);
}

export type Resolved =
  | { type: "blyg"; origin: string; manifest: Manifest; warnings: string[] }
  | { type: "legacy"; feedUrl: string; warnings: string[] }
  | { type: "failed"; tried: string[] };

type Fetch = typeof fetch;
type Got = { url: string; status: number; text: string } | null;

const MAX_FETCHES = 6;

export async function resolve(input: string, fetchImpl: Fetch = fetch): Promise<Resolved> {
  const tried: string[] = [];
  const warnings: string[] = [];
  const probed = new Set<string>();

  async function get(url: string): Promise<Got> {
    if (tried.length >= MAX_FETCHES) return null;
    tried.push(url);
    try {
      const res = await fetchImpl(url, {
        headers: { "user-agent": USER_AGENT, accept: "application/json, application/rss+xml, application/atom+xml, text/html;q=0.9, */*;q=0.5" },
        redirect: "follow",
        signal: AbortSignal.timeout(10_000),
      });
      return { url: res.url || url, status: res.status, text: await res.text() };
    } catch {
      return null;
    }
  }

  // parse success is the test, never Content-Type (§12.1 step 2)
  async function probe(base: string): Promise<Resolved | null> {
    const url = new URL("blyg.json", base).href;
    if (probed.has(url)) return null;
    probed.add(url);
    const got = await get(url);
    if (!got || got.status !== 200) return null;
    const manifest = parseManifest(got.text);
    if (!manifest) return null;
    // identity is where the bytes came from, after redirects (§12.2)
    const origin = got.url.replace(/blyg\.json$/, "");
    if (manifest.site && manifest.site !== origin) warnings.push(`manifest claims site ${manifest.site}; using fetch origin ${origin}`);
    return { type: "blyg", origin, manifest, warnings };
  }

  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return { type: "failed", tried };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { type: "failed", tried };
  if (url.protocol === "http:") warnings.push("not HTTPS");
  url.hash = "";
  const inputUrl = url.href;

  // 1. normalize to a candidate origin
  url.search = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  const candidate = url.href;

  // 2. direct probe
  const direct = await probe(candidate);
  if (direct) return direct;

  // 3–4. look at the input itself: a feed may name its manifest, a page may carry rel="blyg"
  let legacy: string | null = null;
  const page = await get(inputUrl);
  if (page && page.status === 200) {
    const body = page.text.trimStart();
    if (isFeed(body)) {
      const href = body.match(/<blyg:manifest>\s*([^<\s]+)\s*<\/blyg:manifest>/)?.[1];
      if (href) {
        const viaFeed = await probe(new URL(".", new URL(decodeXml(href), page.url)).href);
        if (viaFeed) return viaFeed;
      }
      legacy = page.url;
    } else if (/<html|<!doctype html/i.test(body.slice(0, 2000))) {
      const links = parseLinks(body);
      const rel = links.find((l) => l.rel.split(/\s+/).includes("blyg"));
      if (rel) {
        const base = new URL(rel.href, page.url);
        if (!base.pathname.endsWith("/")) base.pathname += "/";
        const viaRel = await probe(base.href);
        if (viaRel) return viaRel;
      }
      const alt = links.find((l) => l.rel.split(/\s+/).includes("alternate") && /application\/(rss|atom)\+xml/.test(l.type));
      if (alt) legacy = new URL(alt.href, page.url).href;
    }
  }

  // 5. conventional mounts at the host root, a courtesy only
  for (const base of ["/blyg/", "/"]) {
    const found = await probe(new URL(base, candidate).href);
    if (found) return found;
  }

  // 6. legacy RSS
  if (legacy) return { type: "legacy", feedUrl: legacy, warnings };
  return { type: "failed", tried };
}

export function parseManifest(text: string): Manifest | null {
  try {
    const data = JSON.parse(text);
    return data && typeof data === "object" && !Array.isArray(data) && typeof data.blyg === "string" ? data : null;
  } catch {
    return null;
  }
}

const isFeed = (body: string) => /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<(rss|feed|rdf:RDF)[\s>]/.test(body);

const decodeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");

function parseLinks(html: string) {
  const head = html.split(/<\/head>/i)[0];
  return [...head.matchAll(/<link\b([^>]*)>/gi)].map(([, attrs]) => {
    const attr = (name: string) => decodeXml(attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))?.slice(1).find((v) => v !== undefined) ?? "");
    return { rel: attr("rel").toLowerCase(), href: attr("href"), type: attr("type").toLowerCase() };
  }).filter((l) => l.href);
}
