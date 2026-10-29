import { afterEach, expect, test } from "bun:test";
import { changelog } from "../src/store";
import { handleUpdate, type TgMessage } from "../src/telegram";
import { d1 } from "./d1";

const SITE = { origin: "https://me.example/blyg/", title: "me", subtitle: "", author: { name: "me", url: "https://me.example/" } };
const CFG = { token: "t", chatId: -100, pubTopicId: 2, subTopicId: 3, ownerId: 1 };

// Telegram, recorded
function network() {
  const sent: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/sendMessage")) sent.push(JSON.parse(String(init?.body)).text);
    return Response.json({ ok: true, result: { message_id: 900 } });
  }) as typeof fetch;
  return sent;
}
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

let nextId = 1;
async function pub(db: ReturnType<typeof d1>, text: string, extra: Partial<TgMessage> = {}, edit?: number) {
  const message: TgMessage = { message_id: edit ?? nextId++, message_thread_id: 2, from: { id: 1 }, chat: { id: -100 }, text, ...extra };
  const after = await handleUpdate(edit ? { update_id: nextId++, edited_message: message } : { update_id: nextId++, message }, db, SITE, CFG);
  await after?.();
  return message.message_id;
}
const replyTo = (message_id: number) => ({ reply_to_message: { message_id, chat: { id: -100 } } });
const notes = async (db: ReturnType<typeof d1>) => {
  const { id } = db.sqlite.query("SELECT id FROM items").get() as { id: string };
  return (await changelog(db, id)).map((v) => v.note);
};

test("/note before an edit publishes the edit's version with that note, once", async () => {
  const db = d1();
  const sent = network();
  const post = await pub(db, "first take");
  await pub(db, "/note sharpened the claim", replyTo(post));
  expect(sent.at(-1)).toContain(`your next edit publishes v2 with "sharpened the claim"`);
  await pub(db, "second take", {}, post);
  expect(sent.at(-1)).toEndWith("\nnote: sharpened the claim");
  // the queued note was used once: the next edit is held until it gets its own
  await pub(db, "third take", {}, post);
  expect(sent.at(-1)).toStartWith("held v3: what changed?");
  expect(await notes(db)).toEqual([null, "sharpened the claim"]);
  await pub(db, "tightened the ending", replyTo(900));
  expect(sent.at(-1)).toEndWith("\nnote: tightened the ending");
  expect(await notes(db)).toEqual([null, "sharpened the claim", "tightened the ending"]);
});

test("/note alone drops a queued note; a stale one lapses", async () => {
  const db = d1();
  const sent = network();
  const post = await pub(db, "first take");
  await pub(db, "/note oops", replyTo(post));
  await pub(db, "/note", replyTo(post));
  expect(sent.at(-1)).toBe(`dropped the note "oops"; the next edit will ask for one`);
  await pub(db, "/note too early", replyTo(post));
  db.sqlite.exec("UPDATE pending_notes SET at = '2000-01-01T00:00:00Z'");
  await pub(db, "second take", {}, post);
  expect(await notes(db)).toEqual([null]);
  expect(sent.at(-1)).toStartWith("held v2: what changed?");
  expect(db.sqlite.query("SELECT COUNT(*) AS n FROM pending_notes").get()).toEqual({ n: 0 });
});

test("a withdrawn post points /note at /republish", async () => {
  const db = d1();
  const sent = network();
  const post = await pub(db, "first take");
  await pub(db, "/withdraw", replyTo(post));
  await pub(db, "/note back again", replyTo(post));
  expect(sent.at(-1)).toContain("/republish <note>");
  expect(db.sqlite.query("SELECT COUNT(*) AS n FROM pending_notes").get()).toEqual({ n: 0 });
});
