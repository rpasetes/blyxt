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
