import { afterEach, expect, test } from "bun:test";
import { itemDocument } from "../src/blyg";
import { handleDraftRequest } from "../src/drafts";
import { NOTE_MODEL, reproducesRemoved, writeNote } from "../src/notes";
import { changelog, getItem } from "../src/store";
import { handleUpdate, type TgMessage } from "../src/telegram";
import { d1 } from "./d1";

const SITE = { origin: "https://me.example/blyg/", title: "me", subtitle: "", author: { name: "me", url: "https://me.example/" } };
const KEY = "sk-test";
const HAIKU = "https://api.anthropic.com/v1/messages";

// Telegram (numbering the bot's messages from 900) and, when answer is given, the Anthropic API answering with it
function network(answer?: string | (() => Response | Promise<Response>)) {
  const sent: string[] = [];
  const asked: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  let next = 900;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === HAIKU) {
      asked.push({ headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      if (typeof answer === "function") return answer();
      return Response.json({ content: [{ type: "text", text: answer ?? "" }] });
    }
    if (url.endsWith("/sendMessage")) sent.push(JSON.parse(String(init?.body)).text);
    return Response.json({ ok: true, result: { message_id: next++ } });
  }) as typeof fetch;
  return { sent, asked };
}
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

let nextId = 1;
async function pub(db: ReturnType<typeof d1>, key: string | undefined, text: string, extra: Partial<TgMessage> = {}, edit?: number) {
  const cfg = { anthropicKey: key, token: "t", chatId: -100, pubTopicId: 2, subTopicId: 3, ownerId: 1 };
  const message: TgMessage = { message_id: edit ?? nextId++, message_thread_id: 2, from: { id: 1 }, chat: { id: -100 }, text, ...extra };
  const after = await handleUpdate(edit ? { update_id: nextId++, edited_message: message } : { update_id: nextId++, message }, db, SITE, cfg);
  await after?.();
  return message.message_id;
}
const replyTo = (message_id: number, from = 1) => ({ reply_to_message: { message_id, chat: { id: -100 }, from: { id: from } } });
const only = (db: ReturnType<typeof d1>) => (db.sqlite.query("SELECT id FROM items").get() as { id: string }).id;
const doc = async (db: ReturnType<typeof d1>) => itemDocument(SITE, (await getItem(db, only(db)))!, await changelog(db, only(db)));
const notes = async (db: ReturnType<typeof d1>) => (await changelog(db, only(db))).map((v) => v.note);

test("with a key, an edit with no note of yours publishes with one Haiku wrote, marked generated", async () => {
  const db = d1();
  const { sent, asked } = network("Reworded the opening.");
  const post = await pub(db, KEY, "first take on feeds");
  expect(asked).toHaveLength(0); // v1 has nothing to describe
  await pub(db, KEY, "a second take on feeds", {}, post);
  expect((await doc(db)).changelog[1]).toEqual({ version: 2, at: expect.any(String), note: "Reworded the opening.", generated: true });
  expect(sent.at(-1)).toContain("note (written by the model): Reworded the opening.");
  // Haiku, by key, sees what changed rather than the whole post
  expect(asked[0].headers["x-api-key"]).toBe(KEY);
  expect(asked[0].body.model).toBe(NOTE_MODEL);
  expect(JSON.stringify(asked[0].body.messages)).toContain("Removed lines:\\nfirst take on feeds");
});

test("without a key, an edit is held until you reply with a note; a re-edit updates the hold, and the note publishes it", async () => {
  const db = d1();
  const { sent, asked } = network();
  const post = await pub(db, undefined, "first take");
  await pub(db, undefined, "second take", {}, post);
  expect(asked).toHaveLength(0);
  expect(await notes(db)).toEqual([null]);
  expect(sent.at(-1)).toStartWith("held v2: what changed? reply to this with a changelog note");
  const ask = 901; // first reply 900 ("published v1"), then the question
  // editing again changes what's held, and doesn't ask twice
  await pub(db, undefined, "second, sharper take", {}, post);
  expect(sent).toHaveLength(2);
  // the reply to the question is the note, never a post of its own
  await pub(db, undefined, "sharpened the claim", replyTo(ask, 0));
  expect(await notes(db)).toEqual([null, "sharpened the claim"]);
  expect((await getItem(db, only(db)))!.content_md).toBe("second, sharper take");
  expect(db.sqlite.query("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 1 });
  // a retried or late reply to the same question does nothing
  await pub(db, undefined, "sharpened the claim", replyTo(ask, 0));
  expect(db.sqlite.query("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 1 });
  expect((await doc(db)).changelog).toHaveLength(2);
});

test("a held edit also publishes with /note; editing it back to the published text drops the hold", async () => {
  const db = d1();
  network();
  const post = await pub(db, undefined, "first take");
  await pub(db, undefined, "second take", {}, post);
  await pub(db, undefined, "/note fixed the verb", replyTo(post));
  expect(await notes(db)).toEqual([null, "fixed the verb"]);
  await pub(db, undefined, "third take", {}, post);
  await pub(db, undefined, "second take", {}, post);
  expect(db.sqlite.query("SELECT state FROM held_edits ORDER BY id").all()).toEqual([{ state: "published" }, { state: "dropped" }]);
  expect(await notes(db)).toEqual([null, "fixed the verb"]);
});

test("a failed, slow, empty or too-long answer is no note, so the edit is held", async () => {
  const db = d1();
  network(() => new Response("overloaded", { status: 529 }));
  const post = await pub(db, KEY, "first take");
  await pub(db, KEY, "second take", {}, post);
  expect(await notes(db)).toEqual([null]);
  for (const answer of ["", "x".repeat(201), () => { throw new Error("down"); }]) {
    network(answer as never);
    expect(await writeNote(KEY, "a", "b")).toBeNull();
  }
  globalThis.fetch = ((_: unknown, init?: RequestInit) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timeout"))))) as typeof fetch;
  expect(await writeNote(KEY, "a", "b", 10)).toBeNull();
  expect(await writeNote(undefined, "a", "b")).toBeNull();
});

test("a note may not repeat removed words (§5.2): Haiku's is refused, and the edit is held", async () => {
  // short withheld text counts: a removed name, a fixed misspelling
  expect(reproducesRemoved("Removed the mention of Bob.", "thanks to Bob and Ann for reading", "thanks to Ann for reading")).toBe(true);
  expect(reproducesRemoved("Changed 'teh' to 'the'.", "teh feed is chatty", "the feed is chatty")).toBe(true);
  expect(reproducesRemoved("Reworded the opening.", "feeds are noisy by design", "feeds are chatty by design")).toBe(false);
  const db = d1();
  const { sent } = network("Removed the mention of Bob.");
  const post = await pub(db, KEY, "thanks to Bob and Ann");
  await pub(db, KEY, "thanks to Ann", {}, post);
  expect(await notes(db)).toEqual([null]);
  expect(sent.at(-1)).toStartWith("held v2: what changed?");
});

test("/republish with new words and no note is refused without a key; the same words need none", async () => {
  const db = d1();
  const { sent } = network();
  const post = await pub(db, undefined, "words");
  await pub(db, undefined, "/withdraw", replyTo(post));
  await pub(db, undefined, "/republish", replyTo(post));
  expect(await notes(db)).toEqual([null, null, null]);
  await pub(db, undefined, "/withdraw", replyTo(post));
  // the message was edited while the post was withdrawn: bringing back its new words is a revision
  const edited = { reply_to_message: { message_id: post, chat: { id: -100 }, from: { id: 1 }, text: "new words" } };
  await pub(db, undefined, "/republish", edited);
  expect(sent.at(-1)).toBe("not republished: the words differ from what it last published, so it needs a changelog note. reply /republish <what changed>");
  await pub(db, undefined, "/republish trimmed it", edited);
  expect((await getItem(db, only(db)))!.content_md).toBe("new words");
  expect((await notes(db)).at(-1)).toBe("trimmed it");
});

test("a revision draft with no note asks for one at /publish, takes it there, or gets Haiku's", async () => {
  for (const key of [undefined, KEY]) {
    const db = d1();
    const { sent, asked } = network("Added an afternoon section.");
    const cfg = { anthropicKey: key, token: "t", chatId: -100, pubTopicId: 2, subTopicId: 3, ownerId: 1 };
    await pub(db, key, "the morning");
    const req = new Request("https://w.example/api/drafts", { method: "POST", headers: { authorization: "Bearer k" }, body: JSON.stringify({ content_md: "the morning\n\nthe afternoon", update: only(db) }) });
    const { message_id } = (await (await handleDraftRequest(req, db, SITE, cfg, "k")).json()) as { message_id: number };
    await pub(db, key, "/publish", replyTo(message_id, 500));
    if (key) {
      expect(asked).toHaveLength(1);
      expect((await doc(db)).changelog[1]).toEqual({ version: 2, at: expect.any(String), note: "Added an afternoon section.", generated: true });
      continue;
    }
    expect(sent.at(-1)).toBe("not published: this revision has no changelog note. reply /publish <what changed> to publish it with yours");
    await pub(db, key, "/publish added the afternoon", replyTo(message_id, 500));
    expect((await doc(db)).changelog[1]).toEqual({ version: 2, at: expect.any(String), note: "added the afternoon" });
  }
});
