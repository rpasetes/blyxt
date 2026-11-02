import { afterEach, expect, test } from "bun:test";
import { serveBlyg } from "../src/serve";
import { handleUpdate, type TgMessage } from "../src/telegram";
import { d1 } from "./d1";

const SITE = { origin: "https://me.example/blyg/", title: "me", subtitle: "", author: { name: "me", url: "https://me.example/" } };
const CFG = { token: "t", chatId: -100, pubTopicId: 2, subTopicId: 3, ownerId: 1 };

function bot() {
  const replies: string[] = [];
  globalThis.fetch = (async (_: unknown, init?: RequestInit) => {
    replies.push(JSON.parse(String(init?.body)).text);
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as typeof fetch;
  return replies;
}
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

let nextId = 1;
async function send(db: ReturnType<typeof d1>, text: string, replyTo?: number) {
  const message: TgMessage = { message_id: nextId++, message_thread_id: 2, from: { id: 1 }, chat: { id: -100 }, text,
    ...(replyTo ? { reply_to_message: { message_id: replyTo, chat: { id: -100 }, from: { id: 1 } } } : {}) };
  const after = await handleUpdate({ update_id: nextId++, message }, db, SITE, CFG);
  await after?.();
  return message.message_id;
}
const get = async (db: ReturnType<typeof d1>, path: string) => {
  const res = await serveBlyg(new Request(SITE.origin + path), db, SITE, path);
  return { status: res.status, body: await res.text() };
};

test("/file and /page shape the home page's menu and h/ pages, and publish nothing", async () => {
  const db = d1();
  const replies = bot();
  const about = await send(db, "I write here.");
  const post = await send(db, "feeds are chatty");
  const before = await get(db, "feed.xml");
  const versions = db.sqlite.query("SELECT COUNT(*) AS n FROM versions").get();

  await send(db, "/page About", about);
  await send(db, "/file Feed Theory", post);
  await send(db, "/file feed theory", post);
  expect(replies.slice(-3)).toEqual(['on the menu as "About" → https://me.example/blyg/', "filed in Feed Theory → https://me.example/blyg/h/feed-theory/", "already in Feed Theory → https://me.example/blyg/h/feed-theory/"]);

  const home = (await get(db, "")).body;
  expect(home).toContain(`<span class="label">pages:</span> <a href="https://me.example/blyg/f/`);
  expect(home).toContain(`>About</a>`);
  expect(home).toContain(`<a href="https://me.example/blyg/h/feed-theory/">Feed Theory</a> <span class="label">1</span>`);
  const page = await get(db, "h/feed-theory/");
  expect(page.body).toContain("<h2>Feed Theory</h2>");
  expect(page.body).toContain("feeds are chatty");
  expect(page.body).not.toContain("I write here.");
  expect(page.body).toContain(`<link rel="blyg" href="https://me.example/blyg/">`);
  expect((await get(db, "h/nothing/")).status).toBe(404);

  // presentation only: no version, no feed change, and documents carry no menu
  expect(db.sqlite.query("SELECT COUNT(*) AS n FROM versions").get()).toEqual(versions);
  expect((await get(db, "feed.xml")).body).toBe(before.body);

  // withdrawn posts leave the menu and the collection; unfile and unpage take them out
  await send(db, "/withdraw", post);
  expect((await get(db, "")).body).not.toContain("Feed Theory");
  expect((await get(db, "h/feed-theory/")).body).not.toContain("feeds are chatty");
  await send(db, "/unpage", about);
  expect((await get(db, "")).body).not.toContain(`<nav class="menu"`);
  await send(db, "/unfile Feed Theory", post);
  expect(replies.at(-1)).toBe("taken out of Feed Theory");
});

async function subCommand(db: ReturnType<typeof d1>, text: string) {
  const message: TgMessage = { message_id: nextId++, message_thread_id: 3, from: { id: 1 }, chat: { id: -100 }, text };
  const after = await handleUpdate({ update_id: nextId++, message }, db, SITE, CFG);
  await after?.();
}

test("the blogroll is opt-in per blyg (§11): /roll adds one, unrolling or unsubscribing the last empties it to a 404", async () => {
  const db = d1();
  const replies = bot();
  db.sqlite.exec(`
    INSERT INTO sub_topics (topic_id, name, created) VALUES (3, 'Sub', '2026-11-01T00:00:00Z');
    INSERT INTO subscriptions (origin, title, index_url, created, next_poll, feed_url) VALUES
      ('https://them.example/blyg/', 'Them & Co', 'https://them.example/blyg/items/index.json', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', 'https://them.example/blyg/rss'),
      ('https://old.example/feed.xml', 'Old Blog', 'https://old.example/feed.xml', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', 'https://old.example/feed.xml');
    UPDATE subscriptions SET legacy = 1 WHERE origin = 'https://old.example/feed.xml';
    INSERT INTO follows (topic_id, origin, created) VALUES (3, 'https://them.example/blyg/', '2026-11-01T00:00:00Z'), (3, 'https://old.example/feed.xml', '2026-11-01T00:00:00Z');
  `);
  // nothing is shown until the owner says so
  expect((await get(db, "blogroll.opml")).status).toBe(404);
  expect(JSON.parse((await get(db, "blyg.json")).body).blogroll).toBeUndefined();
  expect((await get(db, "")).body).not.toContain(`rel="blogroll"`);

  await subCommand(db, "/roll them.example/blyg");
  await subCommand(db, "/roll https://old.example/feed.xml");
  expect(replies.slice(-2)).toEqual(["Them & Co is in the blogroll", "Old Blog is in the blogroll"]);
  const opml = await serveBlyg(new Request(SITE.origin + "blogroll.opml"), db, SITE, "blogroll.opml");
  expect(opml.headers.get("access-control-allow-origin")).toBe("*");
  expect(opml.headers.get("etag")).toBeTruthy();
  expect(await opml.text()).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>me blogroll</title></head>
  <body>
    <outline type="rss" text="Old Blog" title="Old Blog" xmlUrl="https://old.example/feed.xml" />
    <outline type="rss" text="Them &amp; Co" title="Them &amp; Co" xmlUrl="https://them.example/blyg/rss" htmlUrl="https://them.example/blyg/" />
  </body>
</opml>
`);
  expect(JSON.parse((await get(db, "blyg.json")).body).blogroll).toBe("blogroll.opml");
  const home = (await get(db, "")).body;
  expect(home).toContain(`<link rel="blogroll" href="https://me.example/blyg/blogroll.opml">`);
  expect(home).toContain(`<a href="https://them.example/blyg/">Them &amp; Co</a>`);

  await subCommand(db, "/unroll https://old.example/feed.xml");
  await subCommand(db, "/unsubscribe https://them.example/blyg/");
  expect((await get(db, "blogroll.opml")).status).toBe(404);
  expect(JSON.parse((await get(db, "blyg.json")).body).blogroll).toBeUndefined();
  expect((await get(db, "")).body).not.toContain(`rel="blogroll"`);
});
