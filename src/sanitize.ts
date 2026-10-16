// Another blyg's content_html, made safe to bake into this blyg's pages: an allowlist of tags and
// attributes, no scripts or event handlers, and only http(s) and mailto links, absolute against its origin.

const TAGS = new Set([
  "p", "br", "hr", "a", "em", "strong", "b", "i", "u", "s", "del", "ins", "mark", "small", "sub", "sup", "code", "pre", "kbd",
  "blockquote", "q", "cite", "ul", "ol", "li", "dl", "dt", "dd", "h1", "h2", "h3", "h4", "h5", "h6",
  "img", "figure", "figcaption", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "span", "div", "abbr", "time",
]);
// dropped with everything inside them
const DROP = new Set(["script", "style", "iframe", "object", "embed", "template", "noscript", "svg", "math", "form", "textarea", "select", "button", "frame", "frameset", "head", "title"]);
const ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "title"]),
  img: new Set(["src", "alt", "title", "width", "height"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan"]),
  ol: new Set(["start"]),
  time: new Set(["datetime"]),
  abbr: new Set(["title"]),
};
// classes and data-blyg-* attributes carry wire tokens (blyg-transclusion, blyg-partial, blyg-tk-gen) through nesting
const ANY = new Set(["class"]);
const URL_ATTRS = new Set(["href", "src"]);

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (_, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
      : ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" } as Record<string, string>)[e.toLowerCase()]);

function safeUrl(value: string, base: string) {
  try {
    const url = new URL(decode(value).trim(), base);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function sanitize(html: string, base: string) {
  let out = "";
  let dropping: string | null = null;
  let depth = 0;
  for (const [token, closing, rawName, rest, text, comment] of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|([^<]+)|(<!--[\s\S]*?-->|<[^>]*>?)/g)) {
    if (comment !== undefined) continue;
    if (text !== undefined) {
      if (!dropping) out += text.replace(/>/g, "&gt;");
      continue;
    }
    const name = rawName.toLowerCase();
    if (dropping) {
      if (name === dropping) depth += closing ? -1 : 1;
      if (depth === 0) dropping = null;
      continue;
    }
    if (DROP.has(name)) {
      if (!closing && !/\/\s*$/.test(rest)) { dropping = name; depth = 1; }
      continue;
    }
    if (!TAGS.has(name)) continue; // unknown tags go; their text stays
    if (closing) { out += `</${name}>`; continue; }
    let attrs = "";
    for (const [, key, , dq, sq, bare] of rest.matchAll(/([^\s"'=<>\/]+)(\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      const k = key.toLowerCase();
      if (!(ANY.has(k) || ATTRS[name]?.has(k) || k.startsWith("data-blyg-"))) continue;
      let v = dq ?? sq ?? bare ?? "";
      if (URL_ATTRS.has(k)) {
        const url = safeUrl(v, base);
        if (!url) continue;
        v = url;
      } else v = decode(v);
      attrs += ` ${k}="${escAttr(v)}"`;
    }
    out += `<${name}${attrs}>`;
  }
  return out;
}
