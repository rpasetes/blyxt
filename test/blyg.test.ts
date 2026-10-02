import { expect, test } from "bun:test";
import { contentHash, excerpt, feed, ID_RE, itemDocument, newId, pagePath, render, type Item, type Site } from "../src/blyg";

const site: Site = { origin: "https://example.com/blyg/", title: "t", author: { name: "a", url: "https://example.com/" } };
const item: Item = {
  id: "7c9wk2mhq0v3xj8tn5rzfd41bg", kind: "fragment", created: "2026-10-02T00:00:00Z", updated: "2026-10-02T00:00:00Z",
  version: 1, content_md: "hi <there>", content_html: render("hi <there>"), content_hash: "sha256:x",
};

test("ids are 26-char Crockford base32", () => {
  for (let i = 0; i < 200; i++) expect(newId()).toMatch(ID_RE);
});

test("content_hash is sha256 of content_md", async () => {
  expect(await contentHash("")).toBe("sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("chat line breaks survive rendering", () => {
  expect(render("one\ntwo")).toContain("<br>");
});

test("page paths by kind", () => {
  expect(pagePath(item)).toBe("f/7c9wk2mhq0v3xj8tn5rzfd41bg/");
  expect(pagePath({ ...item, kind: "thread" })).toBe("t/7c9wk2mhq0v3xj8tn5rzfd41bg/");
});

test("item document carries the wire fields", () => {
  const doc = itemDocument(site, item, [{ item_id: item.id, version: 1, kind: "fragment", at: item.created, note: null, pinned: 0 }]);
  expect(doc).toMatchObject({ blyg: "0.3", id: item.id, origin: site.origin, page: "f/7c9wk2mhq0v3xj8tn5rzfd41bg/", version: 1 });
  expect(doc.changelog).toEqual([{ version: 1, at: item.created, note: null }]);
});

test("feed entry is per version with the blyg namespace", () => {
  const xml = feed(site, [{ item_id: item.id, version: 1, kind: "fragment", at: item.created, note: null, pinned: 0 }], new Map([[item.id, item]]), item.updated);
  expect(xml).toContain('xmlns:blyg="https://blygger.org/ns/0.1"');
  expect(xml).toContain(`<guid isPermaLink="false">blyg:${item.id}:v1</guid>`);
  expect(xml).toContain("<blyg:manifest>https://example.com/blyg/blyg.json</blyg:manifest>");
  expect(xml).toContain("<title>hi &lt;there&gt;</title>");
});

test("excerpt strips markup and truncates", () => {
  expect(excerpt("# Hello *world*")).toBe("Hello world");
  expect(excerpt("x".repeat(100)).length).toBe(81);
});

test("raw HTML in chat text is escaped", () => {
  expect(render("hi <script>x</script>")).not.toContain("<script>");
  expect(render("> quoted")).toContain("<blockquote>");
});
