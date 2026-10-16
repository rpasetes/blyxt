import { expect, test } from "bun:test";
import { sanitize } from "../src/sanitize";

const BASE = "https://them.example/blyg/";

test("scripts, handlers and unsafe links never survive", () => {
  expect(sanitize('<p onclick="x()">hi<script>alert(1)</script></p><a href="javascript:alert(1)">x</a><img src=x onerror=alert(1)>', BASE))
    .toBe('<p>hi</p><a>x</a><img src="https://them.example/blyg/x">');
  expect(sanitize("<style>p{}</style><iframe src='//evil'></iframe><svg><script>1</script></svg>ok", BASE)).toBe("ok");
  expect(sanitize('<a href=" JaVaScRiPt:alert(1)">x</a><a href="&#106;avascript:alert(1)">y</a>', BASE)).toBe("<a>x</a><a>y</a>");
});

test("wire tokens and ordinary markup pass through, links made absolute", () => {
  const quote = '<blockquote class="blyg-transclusion blyg-partial" data-blyg-id="abc" data-blyg-version="2" data-blyg-origin="https://x.example/"><p>q</p></blockquote>';
  expect(sanitize(quote, BASE)).toBe(quote);
  expect(sanitize('<p><a href="f/abc/" title="t">l</a> <em>e</em> &amp; 1 &lt; 2</p>', BASE)).toBe('<p><a href="https://them.example/blyg/f/abc/" title="t">l</a> <em>e</em> &amp; 1 &lt; 2</p>');
  expect(sanitize('<div class="blyg-tk-gen"><p>gen</p></div><custom>text</custom>', BASE)).toBe('<div class="blyg-tk-gen"><p>gen</p></div>text');
});
