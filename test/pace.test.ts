import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { paceHistory, paceLayered } from "../src/pace";
import { serveBlyg } from "../src/serve";
import { d1 } from "./d1";

// Blygger Studio's conformance fixtures for the pace-layered feed (MIT, licenses/blygger-studio.txt)
const DIR = new URL("./fixtures/pace/", import.meta.url).pathname;
for (const name of readdirSync(DIR).filter((f) => f.endsWith(".json")).sort()) {
  const { description, history, expected } = JSON.parse(readFileSync(DIR + name, "utf8"));
  test(`pace-layered matches the reference: ${name} (${description})`, () => {
    expect(paceLayered(history.items).map((r) => r.id)).toEqual(expected);
  });
}

const SITE = { origin: "https://me.example/blyg/", title: "me", subtitle: "", author: { name: "me", url: "https://me.example/" } };
const ids = ["0000000000000000000000000a", "0000000000000000000000000b", "0000000000000000000000000c", "0000000000000000000000000d"];
function seed(db: ReturnType<typeof d1>) {
  const at = (n: number) => `2026-10-0${n}T00:00:00Z`;
  const insert = (id: string, n: number, v: number, extra: { pinned?: number; transclusions?: string; kind?: string } = {}) =>
    db.sqlite.query("INSERT INTO versions (item_id, version, kind, at, pinned, content_md, content_html, content_hash, transclusions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, v, extra.kind ?? "fragment", at(n), extra.pinned ?? 0, id, `<p>${id}</p>`, "sha256:x", extra.transclusions ?? null);
  ids.forEach((id, n) => db.sqlite.query("INSERT INTO items (id, kind, authored_kind, created, updated, version, content_md, content_html, content_hash) VALUES (?, 'fragment', 'fragment', ?, ?, 1, ?, ?, 'sha256:x')")
    .run(id, at(n + 1), at(n + 1), id, `<p>${id}</p>`));
  ids.forEach((id, n) => insert(id, n + 1, 1, n === 0 ? { pinned: 1 } : {}));
  return insert;
}

test("blyxt's history reads into the model: pins, same-origin quotes, endcaps left out", async () => {
  const db = d1();
  const insert = seed(db);
  insert(ids[2], 5, 2, { transclusions: JSON.stringify([{ id: ids[1] }, { id: "zz", origin: "https://them.example/" }]), pinned: 1 });
  const history = await paceHistory(db);
  expect(history.map((i) => i.id)).toEqual(ids);
  expect(history[0].versions).toEqual([{ at: "2026-10-01T00:00:00Z", pinned: true, quotes: [] }]);
  expect(history[2].versions[1]).toEqual({ at: "2026-10-05T00:00:00Z", pinned: true, quotes: [ids[1]] });
  db.sqlite.query("UPDATE items SET kind = 'withdrawn' WHERE id = ?").run(ids[1]);
  insert(ids[1], 6, 2, { kind: "withdrawn" });
  expect((await paceHistory(db))[1]).toEqual({ id: ids[1], withdrawn: true, versions: [{ at: "2026-10-02T00:00:00Z", pinned: false, quotes: [] }] });
});

test("the home page follows the pace-layered order and names each layer; archive/ stays newest first", async () => {
  const db = d1();
  seed(db);
  const page = async (path: string) => (await serveBlyg(new Request(SITE.origin + path), db, SITE, path)).text();
  const home = await page("");
  const at = (html: string, id: string) => html.indexOf(`<p>${id}</p>`);
  // a sinks at half speed (one pin, layer 1): after three newer posts it's 1.5 deep, above b at 2
  const order = [ids[3], ids[2], ids[0], ids[1]].map((id) => at(home, id));
  expect(order).toEqual([...order].sort((x, y) => x - y));
  expect(home).toContain("· commerce</p>");
  expect(home).toContain(`<a href="https://me.example/blyg/archive/">`);
  const archive = await page("archive/");
  expect(archive.indexOf(ids[3])).toBeLessThan(archive.indexOf(ids[2]));
  expect(archive.indexOf(ids[2])).toBeLessThan(archive.indexOf(ids[1]));
  expect(archive.indexOf(ids[1])).toBeLessThan(archive.indexOf(ids[0]));
});
