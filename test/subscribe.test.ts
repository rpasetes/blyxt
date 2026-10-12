import { afterEach, describe, expect, test } from "bun:test";
import { addSubscription, getSubTopic, listSubscriptions, pollDue, removeSubscription } from "../src/subscribe";
import { handleUpdate, type TgMessage } from "../src/telegram";
import { d1 } from "./d1";

const ORIGIN = "https://b.example/blyg/";
const A = "0a000000000000000000000000";
const B = "0b000000000000000000000000";
const BOT = { token: "t", chatId: -100 };
const MANIFEST = { blyg: "0.3", title: "B", items: "items/index.json" };

// a followed blyg plus a Telegram that records every call
function world(items: Record<string, { version: number; created: string; kind?: string }>) {
  const fetched: string[] = [];
  const telegram: { method: string; body: Record<string, unknown> }[] = [];
  let nextMessage = 100;
  const goneTopics = new Set<number>();
  const deletedMessages = new Set<number>();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.telegram.org/")) {
      const body = JSON.parse(String(init?.body));
      const method = url.split("/").pop()!;
      telegram.push({ method, body });
      if (goneTopics.has(body.message_thread_id)) return Response.json({ ok: false, error_code: 400, description: "Bad Request: message thread not found" });
      if (method === "editMessageText" && deletedMessages.has(body.message_id)) return Response.json({ ok: false, error_code: 400, description: "Bad Request: message to edit not found" });
      if (method === "createForumTopic") return Response.json({ ok: true, result: { message_thread_id: 50, name: body.name } });
      // an edit keeps its message id; only a send makes a new one
      return Response.json({ ok: true, result: { message_id: method === "sendMessage" ? nextMessage++ : body.message_id } });
    }
    fetched.push(url);
    if (url === ORIGIN + "blyg.json") {
      const res = Response.json(MANIFEST);
      Object.defineProperty(res, "url", { value: url });
      return res;
    }
    if (url === ORIGIN + "items/index.json") {
      return Response.json({ items: Object.entries(items).map(([id, i]) => ({ id, kind: "fragment", ...i })) });
    }
    const id = url.match(/items\/(\w+)\.json$/)?.[1];
    if (id && items[id]) return Response.json({ id, kind: items[id].kind ?? "fragment", version: items[id].version, content_html: `<p>${id} v${items[id].version}</p>` });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { items, fetched, telegram, goneTopics, deletedMessages };
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

test("a deleted topic drops its grouping and the others keep going", async () => {
  const db = d1();
  const w = world({ [A]: { version: 1, created: "2026-10-01T00:00:00Z" } });
  await addSubscription(db, { ...BOT, topicId: 3 }, ORIGIN, MANIFEST);
  await addSubscription(db, { ...BOT, topicId: 7 }, ORIGIN, MANIFEST, "Friends");
  w.goneTopics.add(3);
  w.items[B] = { version: 1, created: "2026-10-02T00:00:00Z" };
  w.telegram.length = 0;
  due(db);
  await pollDue(db, BOT);

  expect(await getSubTopic(db, 3)).toBeNull();
  expect(await listSubscriptions(db, 7)).toHaveLength(1);
  expect(w.telegram.filter((t) => t.method === "sendMessage").map((t) => t.body.message_thread_id)).toEqual([3, 7]);
  // the item was applied for the topic that still exists, so the next poll is quiet
  w.telegram.length = 0;
  due(db);
  await pollDue(db, BOT);
  expect(w.telegram).toEqual([]);
});

// the webhook side: who may run Sub commands where
const SITE = { origin: "https://me.example/blyg/", title: "me", subtitle: "", author: { name: "me", url: "https://me.example/" } };
const CFG = { token: "t", chatId: -100, pubTopicId: 2, subTopicId: 3, ownerId: 1 };
let nextUpdate = 1;
const say = async (db: ReturnType<typeof d1>, topic: number, text: string, extra: Partial<TgMessage> = {}) => {
  const message = { message_id: nextUpdate, message_thread_id: topic, is_topic_message: true, from: { id: 1 }, chat: { id: -100 }, text, ...extra };
  const after = await handleUpdate({ update_id: nextUpdate++, message }, db, SITE, CFG);
  await after?.();
  return !!after;
};
const replies = (w: ReturnType<typeof world>) => w.telegram.filter((t) => t.body.reply_parameters).map((t) => t.body.text as string);

test("/sub adopts a topic, then subscriptions there are its own", async () => {
  const db = d1();
  const w = world({ [A]: { version: 1, created: "2026-10-01T00:00:00Z" } });
  // an unregistered topic ignores everything but /sub
  expect(await say(db, 9, "/subscribe b.example/blyg")).toBe(false);
  expect(await say(db, 9, "/sub Friends", { is_topic_message: false })).toBe(false);
  await say(db, 9, "/sub Friends");
  expect(await getSubTopic(db, 9)).toMatchObject({ name: "Friends" });

  await say(db, 9, `/subscribe ${ORIGIN}`);
  expect(await listSubscriptions(db, 9)).toHaveLength(1);
  expect(await listSubscriptions(db, 3)).toEqual([]);

  w.telegram.length = 0;
  await say(db, 9, "/sub Close friends");
  await say(db, 3, "/subscriptions");
  expect(replies(w)).toEqual(["renamed Friends to Close friends", `Close friends\n• B — ${ORIGIN}`]);
});

test("/newsub creates and registers a topic; Pub and strangers can't run Sub commands", async () => {
  const db = d1();
  const w = world({});
  await say(db, 3, "/newsub Reading list");
  expect(w.telegram[0]).toMatchObject({ method: "createForumTopic", body: { name: "Reading list" } });
  expect(await getSubTopic(db, 50)).toMatchObject({ name: "Reading list" });
  expect(w.telegram.some((t) => t.method === "sendMessage" && t.body.message_thread_id === 50)).toBe(true);

  expect(await say(db, 2, "/sub Nope")).toBe(true); // Pub handles its own commands
  expect(await getSubTopic(db, 2)).toBeNull();
  expect(await say(db, 50, "/subscriptions", { from: { id: 666 } })).toBe(false);
});

// Sub-side edits: older posts get a reply when a later version arrives
describe("later versions of an older Sub post", () => {
  const age = (db: ReturnType<typeof d1>, column: "posted_at" | "replied_at", minutes: number) =>
    db.sqlite.exec(`UPDATE imported SET ${column} = '${new Date(Date.now() - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z")}' WHERE ${column} IS NOT NULL`);
  const bump = async (db: ReturnType<typeof d1>, w: ReturnType<typeof world>, change: Partial<{ version: number; kind: string }> = {}) => {
    Object.assign(w.items[A], { version: w.items[A].version + 1, ...change });
    w.telegram.length = 0;
    due(db);
    await pollDue(db, BOT);
    return w.telegram.map((t) => [t.method, t.body.message_id ?? (t.body.reply_parameters as { message_id: number } | undefined)?.message_id]);
  };
  async function setup() {
    const db = d1();
    const w = world({ [A]: { version: 1, created: "2026-10-01T00:00:00Z" } });
    await addSubscription(db, { ...BOT, topicId: 3 }, ORIGIN, MANIFEST); // posts message 100
    return { db, w };
  }

  test("within the hour, the original is edited and nothing else", async () => {
    const { db, w } = await setup();
    expect(await bump(db, w)).toEqual([["editMessageText", 100]]);
  });

  test("after the hour, a reply under the original carries the new version; a burst edits that reply", async () => {
    const { db, w } = await setup();
    age(db, "posted_at", 61);
    expect(await bump(db, w)).toEqual([["editMessageText", 100], ["sendMessage", 100]]);
    expect(w.telegram[1].body).toMatchObject({ message_thread_id: 3, text: expect.stringContaining(`${A} v2`) });
    expect(await bump(db, w)).toEqual([["editMessageText", 100], ["editMessageText", 101]]);
    expect(w.telegram[1].body.text).toContain(`${A} v3`);
  });

  test("a reply older than the hour, or deleted, gets a new reply", async () => {
    const { db, w } = await setup();
    age(db, "posted_at", 61);
    await bump(db, w); // reply 101
    age(db, "replied_at", 61);
    expect(await bump(db, w)).toEqual([["editMessageText", 100], ["sendMessage", 100]]); // reply 102
    w.deletedMessages.add(102);
    expect(await bump(db, w)).toEqual([["editMessageText", 100], ["editMessageText", 102], ["sendMessage", 100]]);
  });

  test("a withdrawal after the hour blanks the original and says so underneath", async () => {
    const { db, w } = await setup();
    age(db, "posted_at", 61);
    expect(await bump(db, w, { kind: "withdrawn" })).toEqual([["editMessageText", 100], ["sendMessage", 100]]);
    expect(w.telegram[1].body.text).toBe("<b>B</b> · withdrawn");
  });

  test("migrated posts have no posted_at and count as old", async () => {
    const { db, w } = await setup();
    db.sqlite.exec("UPDATE imported SET posted_at = NULL");
    expect(await bump(db, w)).toEqual([["editMessageText", 100], ["sendMessage", 100]]);
  });
});
