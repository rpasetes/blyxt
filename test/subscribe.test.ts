import { afterEach, expect, test } from "bun:test";
import { addSubscription, listSubscriptions, pollDue, removeSubscription } from "../src/subscribe";
import { d1 } from "./d1";

const ORIGIN = "https://b.example/blyg/";
const A = "0a000000000000000000000000";
const B = "0b000000000000000000000000";
const BOT = { token: "t", chatId: -100 };
const MANIFEST = { blyg: "0.3", title: "B", items: "items/index.json" };

// a followed blyg plus a Telegram that records every call
function world(items: Record<string, { version: number; created: string }>) {
  const fetched: string[] = [];
  const telegram: { method: string; body: Record<string, unknown> }[] = [];
  let nextMessage = 100;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.telegram.org/")) {
      const body = JSON.parse(String(init?.body));
      telegram.push({ method: url.split("/").pop()!, body });
      return Response.json({ ok: true, result: { message_id: nextMessage++ } });
    }
    fetched.push(url);
    if (url === ORIGIN + "items/index.json") {
      return Response.json({ items: Object.entries(items).map(([id, i]) => ({ id, kind: "fragment", ...i })) });
    }
    const id = url.match(/items\/(\w+)\.json$/)?.[1];
    if (id && items[id]) return Response.json({ id, kind: "fragment", version: items[id].version, content_html: `<p>${id} v${items[id].version}</p>` });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { items, fetched, telegram };
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const due = (db: ReturnType<typeof d1>) => db.sqlite.exec("UPDATE subscriptions SET next_poll = '1970-01-01T00:00:00Z'");

test("migration moves existing subscriptions into the configured Sub topic", async () => {
  const db = d1("0004");
  db.sqlite.exec(`
    INSERT INTO subscriptions (origin, title, index_url, created, next_poll) VALUES ('${ORIGIN}', 'B', '${ORIGIN}items/index.json', '2026-10-07T00:00:00Z', '2026-10-07T00:15:00Z');
    INSERT INTO imported (origin, item_id, version, kind, content_hash, tg_message_id) VALUES ('${ORIGIN}', '${A}', 2, 'fragment', 'sha256:x', 42);
  `);
  db.migrate();
  expect(db.sqlite.query("SELECT topic_id, name FROM sub_topics").all()).toEqual([{ topic_id: 3, name: "Sub" }]);
  expect(await listSubscriptions(db, 3)).toMatchObject([{ origin: ORIGIN, title: "B" }]);
  expect(db.sqlite.query("SELECT topic_id, item_id, version, tg_message_id, posted_at FROM imported").all())
    .toEqual([{ topic_id: 3, item_id: A, version: 2, tg_message_id: 42, posted_at: null }]);
});

test("a fresh database migrates with no Sub topics", () => {
  expect(d1().sqlite.query("SELECT * FROM sub_topics").all()).toEqual([]);
});

test("two topics following one blyg: fetched once, shown in both", async () => {
  const db = d1();
  const w = world({ [A]: { version: 1, created: "2026-10-01T00:00:00Z" } });
  await addSubscription(db, { ...BOT, topicId: 3 }, ORIGIN, MANIFEST);
  await addSubscription(db, { ...BOT, topicId: 7 }, ORIGIN, MANIFEST, "Friends");
  // each topic previews the newest item in its own message
  expect(w.telegram.map((t) => [t.method, t.body.message_thread_id])).toEqual([["sendMessage", 3], ["sendMessage", 7]]);
  expect(await listSubscriptions(db, 7)).toHaveLength(1);
  expect(db.sqlite.query("SELECT COUNT(*) AS n FROM subscriptions").get()).toEqual({ n: 1 });

  w.items[A].version = 2;
  w.items[B] = { version: 1, created: "2026-10-02T00:00:00Z" };
  w.fetched.length = w.telegram.length = 0;
  due(db);
  await pollDue(db, BOT);

  expect(w.fetched).toEqual([ORIGIN + "items/index.json", ORIGIN + `items/${A}.json`, ORIGIN + `items/${B}.json`]);
  // the edit lands on each topic's own message; the new item posts into each topic
  expect(w.telegram.map((t) => [t.method, t.body.message_id ?? t.body.message_thread_id])).toEqual([
    ["editMessageText", 100], ["editMessageText", 101], ["sendMessage", 3], ["sendMessage", 7],
  ]);
  expect(db.sqlite.query("SELECT topic_id, item_id, version FROM imported ORDER BY topic_id, item_id").all()).toEqual([
    { topic_id: 3, item_id: A, version: 2 }, { topic_id: 3, item_id: B, version: 1 },
    { topic_id: 7, item_id: A, version: 2 }, { topic_id: 7, item_id: B, version: 1 },
  ]);
});

test("a topic that follows later only catches up on what it hasn't shown", async () => {
  const db = d1();
  const w = world({ [A]: { version: 1, created: "2026-10-01T00:00:00Z" } });
  await addSubscription(db, { ...BOT, topicId: 3 }, ORIGIN, MANIFEST);
  w.items[A].version = 2;
  due(db);
  await pollDue(db, BOT);
  await addSubscription(db, { ...BOT, topicId: 7 }, ORIGIN, MANIFEST);
  w.telegram.length = 0;
  due(db);
  await pollDue(db, BOT);
  expect(w.telegram).toEqual([]);
});

test("unfollowing in one topic keeps the blyg polled for the other", async () => {
  const db = d1();
  world({ [A]: { version: 1, created: "2026-10-01T00:00:00Z" } });
  await addSubscription(db, { ...BOT, topicId: 3 }, ORIGIN, MANIFEST);
  await addSubscription(db, { ...BOT, topicId: 7 }, ORIGIN, MANIFEST);

  await removeSubscription(db, 3, ORIGIN);
  expect(await listSubscriptions(db, 3)).toEqual([]);
  expect(await listSubscriptions(db, 7)).toHaveLength(1);
  expect(db.sqlite.query("SELECT DISTINCT topic_id FROM imported").all()).toEqual([{ topic_id: 7 }]);

  await removeSubscription(db, 7, ORIGIN);
  expect(db.sqlite.query("SELECT COUNT(*) AS n FROM subscriptions").get()).toEqual({ n: 0 });
});
