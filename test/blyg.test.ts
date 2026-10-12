import { expect, test } from "bun:test";
import { contentHash, directiveLines, excerpt, feed, ID_RE, itemDocument, itemPage, linkIds, newId, pagePath, pinnedDocument, render, type Item, type Site } from "../src/blyg";

const site: Site = { origin: "https://example.com/blyg/", title: "t", subtitle: "s", author: { name: "a", url: "https://example.com/" } };
const item: Item = {
  id: "7c9wk2mhq0v3xj8tn5rzfd41bg", kind: "fragment", authored_kind: "fragment", created: "2026-10-02T00:00:00Z", updated: "2026-10-02T00:00:00Z",
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

test("page paths by authored kind", () => {
  expect(pagePath(item)).toBe("f/7c9wk2mhq0v3xj8tn5rzfd41bg/");
  expect(pagePath({ ...item, authored_kind: "thread" })).toBe("t/7c9wk2mhq0v3xj8tn5rzfd41bg/");
  expect(pagePath({ ...item, kind: "withdrawn" } as Item)).toBe("f/7c9wk2mhq0v3xj8tn5rzfd41bg/");
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

const A = "7c9wk2mhq0v3xj8tn5rzfd41bg";
const B = "1vgtgz0gq5b2c9k7d3m8r4n6xy";

test("[[id]] links resolve to absolute anchors; code and directive forms stay inert", () => {
  const src = `see [[${A}]] and \`[[${B}]]\` and ![[${B}]] inline`;
  expect(linkIds(src)).toEqual([A]);
  const html = render(src, "https://example.com/blyg/", new Map([[A, { url: `https://example.com/blyg/f/${A}/`, label: "a post" }]]));
  expect(html).toContain(`<a href="https://example.com/blyg/f/${A}/">a post</a>`);
  expect(html).toContain(`<code>[[${B}]]</code>`);
  expect(html).toContain(`![[${B}]] inline`);
});

test("directive lines are found outside code only", () => {
  expect(directiveLines(`intro\n![[${A}]]\n\n\`\`\`\n![[${B}]]\n\`\`\`\n\n  ![[${B}@v2]]  `)).toEqual([
    { id: A, versioned: false },
    { id: B, versioned: true },
  ]);
  expect(directiveLines(`text ![[${A}]] text`)).toEqual([]);
});

test("relative URLs in content_html become absolute", () => {
  const html = render("[home](/) [rel](notes/x?a=1&b=2) [abs](https://x.example/) [mail](mailto:a@b.c)", "https://example.com/blyg/");
  expect(html).toContain('href="https://example.com/"');
  expect(html).toContain('href="https://example.com/blyg/notes/x?a=1&amp;b=2"');
  expect(html).toContain('href="https://x.example/"');
  expect(html).toContain('href="mailto:a@b.c"');
});

test("a withdrawal entry is titled withdrawn with an empty description", () => {
  const gone: Item = { ...item, kind: "withdrawn", version: 2, content_md: "", content_html: "" };
  const xml = feed(site, [{ item_id: item.id, version: 2, kind: "withdrawn", at: item.updated, note: "oops", pinned: 0 }], new Map([[item.id, gone]]), item.updated);
  expect(xml).toContain("<title>withdrawn</title>");
  expect(xml).toContain("<description><![CDATA[]]></description>");
  expect(xml).toContain("<link>https://example.com/blyg/f/7c9wk2mhq0v3xj8tn5rzfd41bg/</link>");
});

test("a pinned version document is frozen and absolute", () => {
  const v = { item_id: item.id, version: 1, kind: "fragment" as const, at: item.created, note: null, pinned: 1, content_md: "x", content_html: '<p><a href="/a">a</a></p>', content_hash: "sha256:y" };
  expect(pinnedDocument(site, v)).toMatchObject({ id: item.id, version: 1, pinned: true, content_html: '<p><a href="https://example.com/a">a</a></p>' });
});

test("the live page cites only its pins", () => {
  const html = itemPage(site, { ...item, version: 3 }, [1]);
  expect(html).toContain('pinned: <a href="https://example.com/blyg/f/7c9wk2mhq0v3xj8tn5rzfd41bg/v1/">v1</a>');
  expect(html).not.toContain("v2");
});
