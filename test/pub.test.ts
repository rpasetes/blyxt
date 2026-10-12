import { afterEach, expect, test } from "bun:test";
import { handleUpdate, type TgMessage } from "../src/telegram";
import { d1 } from "./d1";

const SITE = { origin: "https://me.example/blyg/", title: "me", subtitle: "", author: { name: "me", url: "https://me.example/" } };
const CFG = { token: "t", chatId: -100, pubTopicId: 2, subTopicId: 3, ownerId: 1 };

// a Telegram that records the bot's replies
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
async function send(db: ReturnType<typeof d1>, text: string, edit?: number) {
  const message: TgMessage = { message_id: edit ?? nextId++, message_thread_id: 2, from: { id: 1 }, chat: { id: -100 }, text };
  const after = await handleUpdate(edit ? { update_id: nextId++, edited_message: message } : { update_id: nextId++, message }, db, SITE, CFG);
  await after?.();
  return message.message_id;
}
const kinds = (db: ReturnType<typeof d1>) => db.sqlite.query("SELECT kind, version FROM items ORDER BY created, rowid").all();

test("a message over the fragment cap publishes as a thread", async () => {
  const db = d1();
  const replies = bot();
  await send(db, "é".repeat(2000)); // characters, not bytes or UTF-16 units
  await send(db, "x".repeat(2001));
  expect(kinds(db)).toEqual([{ kind: "fragment", version: 1 }, { kind: "thread", version: 1 }]);
  expect(replies[1]).toStartWith("published thread v1 (over 2,000 characters) → https://me.example/blyg/t/");
});

test("a fragment edited past the cap is refused; a thread has no cap", async () => {
  const db = d1();
  const replies = bot();
  const fragment = await send(db, "short");
  const thread = await send(db, "x".repeat(2500));
  await send(db, "y".repeat(2001), fragment);
  await send(db, "y".repeat(3000), thread);
  expect(kinds(db)).toEqual([{ kind: "fragment", version: 1 }, { kind: "thread", version: 2 }]);
  expect(replies[2]).toBe("edit not published: fragments stay within 2,000 characters, and this is 2,001. trim it, or send it as a new message to publish a thread");
});
