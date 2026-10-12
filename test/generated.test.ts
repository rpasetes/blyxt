import { expect, test } from "bun:test";
import { itemDocument, pinnedDocument, render } from "../src/blyg";
import { changelog, getItem, getPinned, pin, publishNew, withdraw } from "../src/store";
import { d1 } from "./d1";

const SITE = { origin: "https://me.example/blyg/", title: "me", subtitle: "", author: { name: "me", url: "https://me.example/" } };
const GEN = [{ sources: [], model: "claude-opus-5-5", at: "2026-10-13T00:00:00Z" }];

test("a generated body is disclosed in the document and marked in content_html (§5.7)", async () => {
  const db = d1();
  const md = "Today blyxt learned **drafts**.";
  const item = await publishNew(db, "fragment", { md, html: render(md, SITE.origin), transclusions: [], generated: GEN }, { chatId: -100, messageId: 1 });
  const doc = itemDocument(SITE, (await getItem(db, item.id))!, await changelog(db, item.id));
  expect(doc.generated).toEqual(GEN);
  expect(doc.content_html).toBe('<div class="blyg-tk-gen">\n<p>Today blyxt learned <strong>drafts</strong>.</p>\n</div>\n');
  expect(doc.content_md).toBe(md); // the hash covers exactly what readers read

  // a pinned file carries its provenance; the endcap never does
  await pin(db, item.id, 1);
  expect(pinnedDocument(SITE, (await getPinned(db, item.id, 1))!).generated).toEqual(GEN);
  await withdraw(db, item.id, null);
  expect("generated" in itemDocument(SITE, (await getItem(db, item.id))!, await changelog(db, item.id))).toBe(false);
});

test("an authored post carries no generated key", async () => {
  const db = d1();
  const item = await publishNew(db, "fragment", { md: "mine", html: "<p>mine</p>\n", transclusions: [] }, { chatId: -100, messageId: 1 });
  const doc = itemDocument(SITE, (await getItem(db, item.id))!, await changelog(db, item.id));
  expect("generated" in doc).toBe(false);
  expect(doc.content_html).toBe("<p>mine</p>\n");
});
