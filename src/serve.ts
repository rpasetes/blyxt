// Read side of the blyg: every protocol surface, rendered from D1 on request.
import { archiveIndex, feed, FEED_WINDOW, ID_RE, indexPage, itemDocument, itemPage, manifest, pagePath, type Item, type Site } from "./blyg";
import { changelog, getItem, lastUpdated, listItems, recentEvents } from "./store";

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
const notFound = () => new Response("not found\n", { status: 404, headers: { "access-control-allow-origin": "*" } });

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

  m = path.match(/^([ft])\/([0-9a-z]{26})\/$/);
  if (m && ID_RE.test(m[2])) {
    const item = await getItem(db, m[2]);
    if (!item) return notFound();
    // a fragment/thread page lives at one canonical path
    if (pagePath(item) !== path) return Response.redirect(site.origin + pagePath(item), 301);
    return respond(req, itemPage(site, item), "html");
  }

  return notFound();
}
