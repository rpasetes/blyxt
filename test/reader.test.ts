import { afterEach, expect, test } from "bun:test";
import { contentHash } from "../src/blyg";
import { addSubscription, pollDue } from "../src/subscribe";
import { d1 } from "./d1";

const ORIGIN = "https://r.example/blyg/";
const A = "0a000000000000000000000000";
const BOT = { token: "t", chatId: -100 };
const SUB = { ...BOT, topicId: 3 };
const MANIFEST = { blyg: "0.3", title: "R", items: "items/index.json", feed: "feed.xml" };

type Doc = { version: number; kind?: string; md?: string; hash?: string };

// a followed blyg whose index, documents and feed can each say something different, plus a recording Telegram
function world(index: Record<string, number> | null, docs: Record<string, Doc>) {
  const state = { index, docs, fetched: [] as string[], sent: [] as { method: string; body: Record<string, unknown> }[] };
  let next = 100;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.telegram.org/")) {
      const body = JSON.parse(String(init?.body));
      const method = url.split("/").pop()!;
      state.sent.push({ method, body });
      return Response.json({ ok: true, result: { message_id: method === "sendMessage" ? next++ : body.message_id } });
    }
    state.fetched.push(url);
    const ifNoneMatch = (init?.headers as Record<string, string> | undefined)?.["if-none-match"];
    const tagged = (body: string, type: string) => {
      const etag = `"${Bun.hash(body)}"`;
      return ifNoneMatch === etag ? new Response(null, { status: 304 }) : new Response(body, { headers: { etag, "content-type": type } });
    };
    if (url === ORIGIN + "items/index.json") {
      if (!state.index) return new Response("gone", { status: 404 });
      return tagged(JSON.stringify({ items: Object.entries(state.index).map(([id, version]) => ({ id, kind: state.docs[id]?.kind ?? "fragment", version })) }), "application/json");
    }
    if (url === ORIGIN + "feed.xml") {
      const items = Object.entries(state.docs).map(([id, d]) =>
        `<item><guid>blyg:${id}:v${d.version}</guid><blyg:id>${id}</blyg:id><blyg:kind>${d.kind ?? "fragment"}</blyg:kind><blyg:version>${d.version}</blyg:version></item>`);
      return tagged(`<?xml version="1.0"?><rss version="2.0" xmlns:blyg="https://blygger.org/ns/0.1"><channel>${items.join("")}</channel></rss>`, "application/rss+xml");
    }
    const id = url.match(/items\/(\w+)\.json$/)?.[1];
    const d = id && state.docs[id];
    if (!d) return new Response("nope", { status: 404 });
    const md = d.md ?? `${id} v${d.version}`;
    return Response.json({ id, kind: d.kind ?? "fragment", version: d.version, content_md: md, content_html: `<p>${md}</p>`, content_hash: d.hash ?? (await contentHash(md)) });
  }) as typeof fetch;
  return state;
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const due = (db: ReturnType<typeof d1>) => db.sqlite.exec("UPDATE subscriptions SET next_poll = '1970-01-01T00:00:00Z'");
const notices = (w: ReturnType<typeof world>) => w.sent.filter((s) => String(s.body.text).startsWith("⚠")).map((s) => String(s.body.text));

test("a version below the watermark is surfaced once, never adopted, and not refetched", async () => {
  const db = d1();
  const w = world({ [A]: 5 }, { [A]: { version: 5 } });
  await addSubscription(db, SUB, ORIGIN, MANIFEST);
  w.index = { [A]: 6 };
  w.docs[A] = { version: 3 };
  due(db);
  await pollDue(db, BOT);
  expect(notices(w)).toEqual(["⚠ R served v3 of this post after showing v5: its history went backwards. blyxt keeps v5."]);
  expect(db.sqlite.query("SELECT version FROM imported").get()).toEqual({ version: 5 });

  // the index hasn't changed, so the next poll stops at a 304
  w.fetched.length = 0;
  due(db);
  await pollDue(db, BOT);
  expect(w.fetched).toEqual([ORIGIN + "items/index.json"]);
  expect(notices(w)).toHaveLength(1);
});

test("a document lagging behind its index is fetched again next poll", async () => {
  const db = d1();
  const w = world({ [A]: 1 }, { [A]: { version: 1 } });
  await addSubscription(db, SUB, ORIGIN, MANIFEST);
  w.index = { [A]: 2 };
  due(db);
  await pollDue(db, BOT);
  w.docs[A] = { version: 2 };
  due(db);
  await pollDue(db, BOT);
  expect(db.sqlite.query("SELECT version FROM imported").get()).toEqual({ version: 2 });
  expect(notices(w)).toEqual([]);
});
