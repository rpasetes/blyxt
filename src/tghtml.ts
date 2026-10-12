// content_html → the HTML subset Telegram renders (Bot API "HTML style"), within a length budget.
// Telegram has no paragraphs, headings, lists, images or nested blockquotes, so those
// become line breaks, bold, bullets, links and a single quote level.

const INLINE: Record<string, string> = {
  b: "b", strong: "b", i: "i", em: "i", u: "u", ins: "u", s: "s", strike: "s", del: "s", code: "code", pre: "pre", a: "a",
};
const BLOCK = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "table", "tr", "pre", "blockquote", "figure", "figcaption", "section", "article"]);
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e.toLowerCase()] ?? m));
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (tag: string, name: string) => decode(tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"))?.[1] ?? "");

export function toTelegramHtml(html: string, base: string, limit = 3500) {
  let out = "";
  let length = 0; // visible characters, as Telegram counts them
  let truncated = false;
  let quoteDepth = 0;
  let pre = false;
  const open: string[] = []; // emitted Telegram tags, innermost last
  const listCounters: (number | null)[] = [];

  // line breaks are deferred so they land before the next tag or text, never inside an empty element
  let pending = 0;
  let lineStart = true;
  const newline = (n = 1) => { if (!/<(blockquote|pre)>$/.test(out)) pending = Math.max(pending, n); };
  const flush = () => {
    if (pending && out) { out += "\n".repeat(pending); length += pending; lineStart = true; }
    pending = 0;
  };
  const text = (t: string) => {
    if (truncated || !t) return;
    // whitespace between blocks is layout, not text
    if (!pre && !t.trim() && (pending || lineStart)) return;
    if (pending && out) { flush(); t = t.replace(/^ /, ""); } else pending = 0;
    if (lineStart) t = t.replace(/^ /, "");
    if (!t) return;
    lineStart = false;
    if (length + t.length > limit) { t = t.slice(0, Math.max(0, limit - length)).trimEnd() + "…"; truncated = true; }
    out += escape(t);
    length += t.length;
  };
  const push = (tag: string, openTag = `<${tag}>`) => { flush(); out += openTag; open.push(tag); };
  const pop = (tag: string) => {
    const i = open.lastIndexOf(tag);
    if (i < 0) return;
    for (const t of open.splice(i).reverse()) out += `</${t}>`;
  };

  for (const [, closing, name, rest, data] of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)/g)) {
    if (truncated) break;
    if (data !== undefined) {
      text(pre ? decode(data) : decode(data).replace(/\s+/g, " "));
      continue;
    }
    const tag = name.toLowerCase();
    const tg = INLINE[tag];

    if (!closing) {
      if (tag === "br") { newline(); continue; }
      if (tag === "hr") { newline(2); text("———"); newline(2); continue; }
      if (tag === "img") {
        const src = attr(rest, "src");
        if (src) { push("a", `<a href="${escape(new URL(src, base).href)}">`); text(`[image${attr(rest, "alt") ? `: ${attr(rest, "alt")}` : ""}]`); pop("a"); }
        continue;
      }
      if (BLOCK.has(tag)) newline(tag === "li" ? 1 : 2);
      if (/^h[1-6]$/.test(tag)) push("b");
      else if (tag === "ul" || tag === "ol") listCounters.push(tag === "ol" ? 1 : null);
      else if (tag === "li") { const n = listCounters.at(-1); text(n == null ? "• " : `${n}. `); if (n != null) listCounters[listCounters.length - 1] = n + 1; }
      // Telegram allows one quote level; inner quotes (nested transclusions) fold into it
      else if (tag === "blockquote") { if (quoteDepth++ === 0) push("blockquote"); }
      else if (tag === "pre") { pre = true; push("pre"); }
      else if (tag === "a") {
        const href = attr(rest, "href");
        if (href && !href.startsWith("#")) push("a", `<a href="${escape(new URL(href, base).href)}">`);
      } else if (tg && !(tag === "code" && pre)) push(tg);
    } else {
      if (/^h[1-6]$/.test(tag)) pop("b");
      else if (tag === "ul" || tag === "ol") listCounters.pop();
      else if (tag === "blockquote") { if (--quoteDepth === 0) pop("blockquote"); }
      else if (tag === "pre") { pre = false; pop("pre"); }
      else if (tg && !(tag === "code" && pre)) pop(tg);
      if (BLOCK.has(tag)) newline(tag === "li" ? 1 : 2);
    }
  }
  pop(open[0] ?? "");
  return out.trim();
}
