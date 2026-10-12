// Publish-time resolution of a message's markdown (§10.1–10.2): what it links, what it may not yet do.
import { directiveLines, excerpt, linkIds, pagePath, render, type LinkTarget } from "./blyg";
import { getItem } from "./store";

export type Composed = { ok: true; html: string } | { ok: false; error: string };

export async function compose(db: D1Database, origin: string, src: string): Promise<Composed> {
  const directives = directiveLines(src);
  if (directives.some((d) => d.versioned)) return { ok: false, error: "![[id@vN]] is reserved by the spec and can't be published" };
  if (directives.length) return { ok: false, error: "a line with only ![[id]] quotes that post, which makes this a thread; blyxt can't publish threads yet" };

  const targets = new Map<string, LinkTarget>();
  for (const id of linkIds(src)) {
    const target = await resolveLink(db, origin, id);
    if (typeof target === "string") return { ok: false, error: target };
    targets.set(id, target);
  }
  return { ok: true, html: render(src, origin, targets) };
}

// a local published item first, then exactly one followed blyg's item; anything else is a publish error
async function resolveLink(db: D1Database, origin: string, id: string): Promise<LinkTarget | string> {
  const local = await getItem(db, id);
  if (local && local.kind !== "withdrawn") return { url: origin + pagePath(local), label: excerpt(local.content_md, 40) || id };

  const { results } = await db
    .prepare("SELECT origin, kind FROM imported WHERE item_id = ? AND kind != 'withdrawn'")
    .bind(id)
    .all<{ origin: string; kind: string }>();
  if (results.length > 1) return `[[${id}]] matches posts in ${results.length} blygs you follow; the spec won't pick one`;
  if (results.length === 1) return { url: new URL(pagePath({ id, kind: results[0].kind as "fragment" }), results[0].origin).href, label: id };
  return `[[${id}]] doesn't match a post here or in a blyg you follow`;
}
