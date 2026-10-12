// Read side of the blyg: every protocol surface, rendered from D1 on request.
import { archiveIndex, feed, FEED_WINDOW, ID_RE, indexPage, itemDocument, itemPage, manifest, pagePath, pinnedDocument, pinnedPage, type Item, type Site } from "./blyg";
import { changelog, getItem, getPinned, lastUpdated, listItems, recentEvents } from "./store";

const TYPES = {
  json: "application/json; charset=utf-8",
  xml: "application/rss+xml; charset=utf-8",
  html: "text/html; charset=utf-8",
};

// permissive CORS (§4) and conditional GETs so pollers get cheap 304s (§12.4)
async function respond(req: Request, body: string, type: keyof typeof TYPES) {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(body));
  const etag = `"${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
  const headers = {
    "content-type": TYPES[type],
    "access-control-allow-origin": "*",
    "cache-control": "public, max-age=60",
    etag,
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(body, { headers });
}

const json = (req: Request, data: unknown) => respond(req, JSON.stringify(data, null, 2) + "\n", "json");
const notFound = (path = "") => new Response(`not found: /${path}\n`, { status: 404, headers: { "access-control-allow-origin": "*" } });

export async function serveBlyg(req: Request, db: D1Database, site: Site, path: string) {
  if (path === "" || path === "index.html") return respond(req, indexPage(site, await listItems(db)), "html");
  if (path === "blyg.json") return json(req, manifest(site, await lastUpdated(db)));
  if (path === "items/index.json") {
    const items = await listItems(db);
    return json(req, archiveIndex(items, items[0]?.updated ?? (await lastUpdated(db))));
  }
  if (path === "feed.xml") {
    const events = await recentEvents(db, FEED_WINDOW);
    const latest = new Map<string, Item>();
    for (const i of await listItems(db)) latest.set(i.id, i);
    return respond(req, feed(site, events, latest, await lastUpdated(db)), "xml");
  }

  let m = path.match(/^items\/([0-9a-z]{26})\.json$/);
  if (m && ID_RE.test(m[1])) {
    const item = await getItem(db, m[1]);
    return item ? json(req, itemDocument(site, item, await changelog(db, item.id))) : notFound();
  }

  // pinned versions: 404 unless that exact version is pinned, 200 forever once it is (§8)
  m = path.match(/^items\/([0-9a-z]{26})\/v([1-9]\d*)\.json$/);
  if (m && ID_RE.test(m[1])) {
    const v = await getPinned(db, m[1], Number(m[2]));
    return v ? json(req, pinnedDocument(site, v)) : notFound();
  }

  m = path.match(/^([ft])\/([0-9a-z]{26})\/(?:v([1-9]\d*)\/)?$/);
  if (m && ID_RE.test(m[2])) {
    const item = await getItem(db, m[2]);
    if (!item) return notFound();
    // a fragment/thread page lives at one canonical path
    const canonical = pagePath(item) + (m[3] ? `v${m[3]}/` : "");
    if (canonical !== path) return Response.redirect(site.origin + canonical, 301);
    if (m[3]) {
      const v = await getPinned(db, item.id, Number(m[3]));
      return v ? respond(req, pinnedPage(site, item, v), "html") : notFound();
    }
    const pins = (await changelog(db, item.id)).filter((c) => c.pinned).map((c) => c.version);
    return respond(req, itemPage(site, item, pins), "html");
  }

  return notFound(path);
}
