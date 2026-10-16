import { afterEach, expect, test } from "bun:test";
import { itemDocument } from "../src/blyg";
import { deliverDue } from "../src/mentions";
import { changelog, getItem } from "../src/store";
import { handleUpdate, type TgMessage } from "../src/telegram";
import { d1 } from "./d1";

const SITE = { origin: "https://me.example/blyg/", title: "me", subtitle: "", author: { name: "me", url: "https://me.example/" } };
const CFG = { token: "t", chatId: -100, pubTopicId: 2, subTopicId: 3, ownerId: 1 };
const THEM = "https://them.example/blyg/";
const POST = "47ejtj76c1j7j9b0adp6tr3cee";

// a followed blyg with one post, shown in Sub as message 77
function followed() {
  const db = d1();
  db.sqlite.exec(`
    INSERT INTO subscriptions (origin, title, index_url, created, next_poll, failures, lossy, legacy) VALUES ('${THEM}', 'Their Blyg', '${THEM}items/index.json', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', 0, 0, 0);
    INSERT INTO sub_topics (topic_id, name, created) VALUES (3, 'Sub', '2026-10-01T00:00:00Z');
    INSERT INTO follows (topic_id, origin, created) VALUES (3, '${THEM}', '2026-10-01T00:00:00Z');
    INSERT INTO imported (topic_id, origin, item_id, version, kind, tg_message_id) VALUES (3, '${THEM}', '${POST}', 1, 'thread', 77);
    INSERT INTO snapshots (origin, item_id, version, kind, content_html, page, author, fetched)
      VALUES ('${THEM}', '${POST}', 1, 'thread', '<p>This seems like an important piece so maybe we can do a blygging party around it.</p>', 't/${POST}/', 'Them', '2026-10-16T03:00:00Z');
  `);
  return db;
}

// Telegram and the followed blyg, recorded; the blyg accepts mentions unless told otherwise
type Call = { url: string; body: string };
function network(webmention = () => new Response("", { status: 202 })) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, body: String(init?.body ?? "") });
    if (url.startsWith("https://api.telegram.org/")) return Response.json({ ok: true, result: { message_id: 900 } });
    if (url === `${THEM}blyg.json`) return Response.json({ blyg: "0.3", webmention: "webmention" });
    if (url === `${THEM}webmention`) return webmention();
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return calls;
}
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const replies = (calls: Call[]) => calls.filter((c) => c.url.endsWith("/sendMessage")).map((c) => JSON.parse(c.body).text as string);
const mentions = (calls: Call[]) => calls.filter((c) => c.url === `${THEM}webmention`).map((c) => Object.fromEntries(new URLSearchParams(c.body)));

let nextId = 1;
async function pub(db: ReturnType<typeof d1>, text: string, extra: Partial<TgMessage> = {}, edit?: number) {
  const message: TgMessage = { message_id: edit ?? nextId++, message_thread_id: 2, from: { id: 1 }, chat: { id: -100 }, text, ...extra };
  const after = await handleUpdate(edit ? { update_id: nextId++, edited_message: message } : { update_id: nextId++, message }, db, SITE, CFG);
  await after?.();
  return message.message_id;
}
const only = (db: ReturnType<typeof d1>) => db.sqlite.query("SELECT id FROM items").get() as { id: string };
const doc = async (db: ReturnType<typeof d1>, id: string) => itemDocument(SITE, (await getItem(db, id))!, await changelog(db, id));

test("replying from Pub to a followed post in Sub publishes a stub of it, and tells its blyg", async () => {
  const db = followed();
  const calls = network();
  await pub(db, "Agreed, and here's why.", { reply_to_message: { message_id: 2, chat: { id: -100 } }, external_reply: { message_id: 77, chat: { id: -100 } }, quote: { text: "an important piece" } });
  const { id } = only(db);
  const d = await doc(db, id);
  expect(d.kind).toBe("thread");
  expect(d.stub_of).toEqual({
    origin: THEM, id: POST, version: 1,
    cited: { source: "Their Blyg", author: "Them", excerpt: "This seems like an important piece so maybe we can do a blygging party around it.", url: `${THEM}t/${POST}/`, retrieved: "2026-10-16T03:00:00Z" },
  });
  expect(d.transclusions).toEqual([{ id: POST, version: 1, origin: THEM, selector: { exact: "an important piece", prefix: "This seems like ", suffix: " so maybe we can do a blygging p" } }]);
  expect(d.content_html).toStartWith(`<blockquote class="blyg-transclusion blyg-partial" data-blyg-id="${POST}" data-blyg-version="1" data-blyg-origin="${THEM}">`);
  expect(replies(calls).at(-1)).toBe(`published thread v1 (stub of Their Blyg; they've been told) → https://me.example/blyg/t/${id}/`);
  expect(mentions(calls)).toEqual([{ source: `https://me.example/blyg/t/${id}/`, target: `${THEM}t/${POST}/` }]);
  expect(db.sqlite.query("SELECT status, relation FROM mentions_out").get()).toEqual({ status: "sent", relation: "stub" });

  // an unchanged reference isn't re-sent on edit
  await pub(db, "Agreed, and here's why, at more length.", {}, 1);
  expect(mentions(calls)).toHaveLength(1);
});

test("a message opening with a followed post's link stubs it, and edits keep the link as the quote", async () => {
  const db = followed();
  const calls = network();
  const msg = await pub(db, `${THEM}t/${POST}/\nMy comments.`);
  const { id } = only(db);
  expect((await getItem(db, id))!.content_md).toBe(`![[${POST}]]\n\nMy comments.`);
  await pub(db, `${THEM}t/${POST}/\nMy longer comments.`, {}, msg);
  const d = await doc(db, id);
  expect([d.version, d.content_md, d.stub_of.id]).toEqual([2, `![[${POST}]]\n\nMy longer comments.`, POST]);
  expect(mentions(calls)).toHaveLength(1);
});

test("a stub needs words of its own", async () => {
  const db = followed();
  const calls = network();
  await pub(db, `${THEM}t/${POST}/`);
  expect(db.sqlite.query("SELECT COUNT(*) n FROM items").get()).toEqual({ n: 0 });
  expect(replies(calls).at(-1)).toBe("not published: say something about it. a stub is a response, so it needs your words after the quote");
});

test("withdrawing a stub drops stub_of and re-sends the mention; republishing restores both", async () => {
  const db = followed();
  const calls = network();
  const msg = await pub(db, `${THEM}t/${POST}/\nMy comments.`);
  const { id } = only(db);
  await pub(db, "/withdraw", { reply_to_message: { message_id: msg, chat: { id: -100 }, from: { id: 1 } } });
  expect("stub_of" in (await doc(db, id))).toBe(false);
  expect(mentions(calls)).toHaveLength(2);
  await pub(db, "/republish", { reply_to_message: { message_id: msg, chat: { id: -100 }, from: { id: 1 } } });
  const d = await doc(db, id);
  expect([d.version, d.stub_of.id]).toEqual([3, POST]);
  expect(mentions(calls)).toHaveLength(3);
});

test("quoting a followed post needs a kept copy of it, and a withdrawn one can't be quoted", async () => {
  const db = followed();
  const calls = network();
  db.sqlite.exec(`DELETE FROM snapshots`);
  await pub(db, `![[${POST}]]\n\nhm`);
  expect(replies(calls).at(-1)).toBe(`not published: ![[${POST}]] is from a blyg you follow, but blyxt hasn't kept a copy of it yet. try again after the next poll. fix it and send it again`);
  db.sqlite.exec(`INSERT INTO snapshots (origin, item_id, version, kind, content_html, fetched) VALUES ('${THEM}', '${POST}', 2, 'withdrawn', '', '2026-10-16T04:00:00Z')`);
  await pub(db, `![[${POST}]]\n\nhm`);
  expect(replies(calls).at(-1)).toBe(`not published: ![[${POST}]] is withdrawn at Their Blyg. fix it and send it again`);
});

test("replying in Pub to your own post is a stub of it, with no mention to send", async () => {
  const db = followed();
  const calls = network();
  const first = await pub(db, "an idea");
  await pub(db, "more on it", { reply_to_message: { message_id: first, chat: { id: -100 }, from: { id: 1 } } });
  const ids = db.sqlite.query("SELECT id FROM items ORDER BY rowid").all() as { id: string }[];
  const d = await doc(db, ids[1].id);
  expect(d.stub_of).toMatchObject({ origin: SITE.origin, id: ids[0].id, version: 1 });
  expect(mentions(calls)).toEqual([]);
});

test("mentions retry on 5xx with backoff, stop on 4xx, and record a blyg with no endpoint", async () => {
  const db = followed();
  network(() => new Response("busy", { status: 503 }));
  await pub(db, `${THEM}t/${POST}/\nMy comments.`);
  const row = () => db.sqlite.query("SELECT status, attempts, next_try IS NOT NULL AS scheduled, last_error FROM mentions_out").get();
  expect(row()).toEqual({ status: "pending", attempts: 1, scheduled: 1, last_error: "503 busy" });

  network(() => new Response("bad target", { status: 400 }));
  db.sqlite.exec("UPDATE mentions_out SET next_try = '2000-01-01T00:00:00Z'");
  await deliverDue(db);
  expect(row()).toEqual({ status: "failed", attempts: 2, scheduled: 0, last_error: "400 bad target" });
});
