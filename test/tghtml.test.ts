import { expect, test } from "bun:test";
import { toTelegramHtml } from "../src/tghtml";

const base = "https://b.example/blyg/";

test("blocks become line breaks, inline formatting survives", () => {
  expect(toTelegramHtml("<h1>Title</h1>\n<p>one <em>two</em> <strong>three</strong></p>\n<p>four</p>", base))
    .toBe("<b>Title</b>\n\none <i>two</i> <b>three</b>\n\nfour");
});

test("baked transclusions are quotes, nested ones fold into one level", () => {
  const html = `<p>mine</p><blockquote class="blyg-transclusion" data-blyg-id="x"><p>theirs</p><blockquote class="blyg-transclusion"><p>deeper</p></blockquote></blockquote>`;
  expect(toTelegramHtml(html, base)).toBe("mine\n\n<blockquote>theirs\n\ndeeper</blockquote>");
});

test("relative links and images resolve against the origin; text is escaped", () => {
  expect(toTelegramHtml(`<p><a href="f/x/">a &amp; b</a> <img src="media/p.png" alt="pic"> 1 &lt; 2</p>`, base))
    .toBe(`<a href="https://b.example/blyg/f/x/">a &amp; b</a> <a href="https://b.example/blyg/media/p.png">[image: pic]</a> 1 &lt; 2`);
});

test("lists get bullets and numbers", () => {
  expect(toTelegramHtml("<ul><li>a</li><li>b</li></ul><ol><li>c</li><li>d</li></ol>", base)).toBe("• a\n• b\n\n1. c\n2. d");
});

test("truncation counts visible text and closes open tags", () => {
  const out = toTelegramHtml(`<blockquote><p><b>${"x".repeat(50)}</b></p></blockquote>`, base, 10);
  expect(out).toBe(`<blockquote><b>${"x".repeat(10)}…</b></blockquote>`);
});

test("code blocks keep their whitespace", () => {
  expect(toTelegramHtml("<pre><code>a  &lt;b&gt;\n  c</code></pre>", base)).toBe("<pre>a  &lt;b&gt;\n  c</pre>");
});

test("a baked quote is followed by a link to what it quotes; nested quotes fold into the outer one's", () => {
  const html = '<p>mine</p>\n<blockquote class="blyg-transclusion" data-blyg-id="abc" data-blyg-version="2" data-blyg-origin="https://them.example/blyg/"><p>theirs</p><blockquote class="blyg-transclusion" data-blyg-id="def" data-blyg-version="1"><p>deeper</p></blockquote></blockquote>\n<p>after</p>';
  const seen: unknown[] = [];
  const out = toTelegramHtml(html, "https://me.example/blyg/", 3500, (q) => (seen.push(q), { url: `${q.origin}t/${q.id}/`, label: "Them & co" }));
  expect(out).toBe('mine\n\n<blockquote>theirs\n\ndeeper</blockquote>\n↳ <a href="https://them.example/blyg/t/abc/">Them &amp; co</a>\n\nafter');
  expect(seen).toEqual([{ id: "abc", version: 2, origin: "https://them.example/blyg/" }]);
  // without a resolver, nothing changes
  expect(toTelegramHtml(html, "https://me.example/blyg/")).toBe("mine\n\n<blockquote>theirs\n\ndeeper</blockquote>\n\nafter");
});
