import { expect, test } from "bun:test";
import { contentHash, directives, textContent, excerpt, feed, ID_RE, itemDocument, itemPage, indexPage, linkIds, manifest, newId, pagePath, pinnedDocument, render, type Item, type Site } from "../src/blyg";

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
  expect(doc).toMatchObject({ blyg: "0.4", id: item.id, origin: site.origin, page: "f/7c9wk2mhq0v3xj8tn5rzfd41bg/", version: 1 });
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
  expect(directives(`intro\n![[${A}]]\n\n\`\`\`\n![[${B}]]\n\`\`\`\n\n  ![[${B}@v2]]  `)).toEqual([
    { id: A, versioned: false, selection: undefined },
    { id: B, versioned: true, selection: undefined },
  ]);
  expect(directives(`text ![[${A}]] text`)).toEqual([]);
  expect(directives(`> ![[${A}]]\n\n- ![[${B}]]`)).toEqual([]);
});

test("a link's label is its anchor text; an empty label is none, and the label may hold a pipe", () => {
  const links = new Map([[A, { url: `https://example.com/blyg/f/${A}/`, label: "a post" }]]);
  expect(linkIds(`see [[${A} | the opening fragment]]`)).toEqual([A]);
  expect(render(`see [[${A} | the opening fragment]]`, site.origin, links)).toContain(`<a href="https://example.com/blyg/f/${A}/">the opening fragment</a>`);
  expect(render(`see [[${A}|a | b]]`, site.origin, links)).toContain(`>a | b</a>`);
  expect(render(`see [[${A} | ]]`, site.origin, links)).toContain(`>a post</a>`);
  // text in brackets that doesn't open with an id is literal (§10.1)
  expect(linkIds(`[[not an id | x]]`)).toEqual([]);
});

test("a caption reads a labelled link as its label", () => {
  expect(excerpt(`see [[${A} | the opening fragment]] here`)).toBe("see the opening fragment here");
});

test("a directive's label bakes as data-blyg-label and changes nothing else (§10.2, #81)", () => {
  const quotes = new Map([[A, { version: 2, html: "<p>quoted</p>" }]]);
  const bare = render(`![[${A}]]\n\nmine`, site.origin, new Map(), quotes);
  const labelled = render(`![[${A} | a "fine" <post>]]\n\nmine`, site.origin, new Map(), quotes);
  expect(labelled).toBe(bare.replace(`data-blyg-version="2"`, `data-blyg-version="2" data-blyg-label="a &quot;fine&quot; &lt;post&gt;"`));
  expect(directives(`![[${A} | a note]]\n> quoted`)).toEqual(directives(`![[${A}]]\n> quoted`));
  expect(directives(`![[${A}@v2 | x]]`)).toEqual([{ id: A, versioned: true, selection: undefined }]);
});

test("an attached blockquote is a selection; a blank line detaches it", () => {
  expect(directives(`![[${A}]]\n> quoted *bit*\n> line two\n\nmine`)).toEqual([{ id: A, versioned: false, selection: "quoted bit\nline two" }]);
  expect(directives(`![[${A}]]\n\n> my own quote`)).toEqual([{ id: A, versioned: false, selection: undefined }]);
});

test("directives bake snapshots; nested and inert ones stay text", () => {
  const quotes = new Map([[A, { version: 3, html: "<p>source <em>text</em></p>\n" }]]);
  const whole = render(`![[${A}]]\nafter`, "https://example.com/", undefined, quotes);
  expect(whole).toContain(`<blockquote class="blyg-transclusion" data-blyg-id="${A}" data-blyg-version="3"><p>source <em>text</em></p>\n</blockquote>`);
  expect(whole).toContain("<p>after</p>");
  const partial = render(`![[${A}]]\n> source *text*`, "https://example.com/", undefined, quotes);
  expect(partial).toContain(`<blockquote class="blyg-transclusion blyg-partial" data-blyg-id="${A}" data-blyg-version="3">\n<p>source text</p>\n</blockquote>`);
  expect(render(`> ![[${A}]]`, "https://example.com/", undefined, quotes)).not.toContain("blyg-transclusion");
});

test("text content keeps block boundaries as line breaks", () => {
  expect(textContent("<p>one  <b>two</b>\nthree</p><ul><li>a &amp; b</li></ul>")).toBe("one two three\na & b");
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

test("documents declare 0.4; the manifest leaves item and pin out, since absent means the default (§6.1)", () => {
  const m = manifest(site, "2026-10-29T00:00:00Z");
  expect(m).toMatchObject({ blyg: "0.4", feed: "feed.xml", items: "items/index.json" });
  expect("item" in m || "pin" in m).toBe(false);
  expect(itemDocument(site, item, []).blyg).toBe("0.4");
});

test("the masthead carries the author's avatar, absolute, on every page; the manifest names it origin-relative (§6.1)", () => {
  const s: Site = { ...site, author: { ...site.author, avatar: "media/avatar.jpg", links: [{ label: "example.com", url: "https://example.com/" }] } };
  expect(manifest(s, "2026-11-02T00:00:00Z").author).toEqual({ name: "a", url: "https://example.com/", avatar: "media/avatar.jpg", links: [{ label: "example.com", url: "https://example.com/" }] });
  for (const html of [indexPage(s, [item]), itemPage(s, item)]) {
    expect(html).toContain(`<img class="avatar" src="https://example.com/blyg/media/avatar.jpg"`);
    expect(html).toContain(`<a href="https://example.com/" rel="me">example.com</a>`);
  }
  expect(indexPage(s, [item])).toContain(`<meta property="og:image" content="https://example.com/blyg/media/avatar.jpg">`);
  expect(itemPage(site, item)).not.toContain("avatar");
});

test("items keep the {name, url} byline (§5.5): the masthead's bio, avatar and links stay in the manifest", () => {
  const s: Site = { ...site, author: { ...site.author, bio: "b", avatar: "media/avatar.jpg", links: [{ label: "x", url: "https://x.example/" }] } };
  expect(itemDocument(s, item, []).author).toEqual({ name: "a", url: "https://example.com/" });
  expect(pinnedDocument(s, { ...item, item_id: item.id, at: item.created, note: null, pinned: 1 } as never).author).toEqual({ name: "a", url: "https://example.com/" });
});

test("a directive line ends the selection above it, never continuing the quote (§10.1, ninth revision)", () => {
  const A = "0000000000000000000000000a", B = "0000000000000000000000000b";
  expect(directives(`![[${A}]]\n> sel line\n![[${B}]]\n`)).toEqual([{ id: A, versioned: false, selection: "sel line" }, { id: B, versioned: false, selection: undefined }]);
  expect(directives(`![[${A}]]\n> sel\nlazy\n![[${B}]]\n`)).toEqual([{ id: A, versioned: false, selection: "sel\nlazy" }, { id: B, versioned: false, selection: undefined }]);
  // the reserved form is read as a directive too, to be refused, never swallowed into the quote
  expect(directives(`![[${A}]]\n> sel\n![[${B}@v2]]\n`)).toEqual([{ id: A, versioned: false, selection: "sel" }, { id: B, versioned: true, selection: undefined }]);
  // a quoted line is never a directive line, so a nested quote's lazy line stays nested, as markdown has it
  expect(render(`> > nested\n> ![[${B}]]`)).toBe(`<blockquote>\n<blockquote>\n<p>nested</p>\n<p>![[${B}]]</p>\n</blockquote>\n</blockquote>\n`);
  // code stays code: a directive in a fence after a quote is text
  expect(directives("> q\n```\n![[" + A + "]]\n```\n")).toEqual([]);
});
