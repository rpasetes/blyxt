import { afterEach, expect, test } from "bun:test";
import { itemDocument } from "../src/blyg";
import { handleDraftRequest } from "../src/drafts";
import { reproducesRemoved, writeNote, type NoteModel } from "../src/notes";
import { changelog, getItem } from "../src/store";
import { handleUpdate, type TgMessage } from "../src/telegram";
import { d1 } from "./d1";

const SITE = { origin: "https://me.example/blyg/", title: "me", subtitle: "", author: { name: "me", url: "https://me.example/" } };

// a Workers AI that answers with `response` and counts what it was asked
function model(response: unknown = "Reworded the opening.") {
  const asked: unknown[] = [];
  const ai: NoteModel = { run: async (_model, input) => { asked.push(input); return typeof response === "function" ? response() : { response }; } };
  return { ai, asked };
}

function network() {
  const sent: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/sendMessage")) sent.push(JSON.parse(String(init?.body)).text);
    return Response.json({ ok: true, result: { message_id: 900 } });
  }) as typeof fetch;
  return sent;
}
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

let nextId = 1;
async function pub(db: ReturnType<typeof d1>, ai: NoteModel | undefined, text: string, extra: Partial<TgMessage> = {}, edit?: number) {
  const cfg = { ai, token: "t", chatId: -100, pubTopicId: 2, subTopicId: 3, ownerId: 1 };
  const message: TgMessage = { message_id: edit ?? nextId++, message_thread_id: 2, from: { id: 1 }, chat: { id: -100 }, text, ...extra };
  const after = await handleUpdate(edit ? { update_id: nextId++, edited_message: message } : { update_id: nextId++, message }, db, SITE, cfg);
  await after?.();
  return message.message_id;
}
const replyTo = (message_id: number) => ({ reply_to_message: { message_id, chat: { id: -100 }, from: { id: 1 } } });
const only = (db: ReturnType<typeof d1>) => (db.sqlite.query("SELECT id FROM items").get() as { id: string }).id;
const doc = async (db: ReturnType<typeof d1>) => itemDocument(SITE, (await getItem(db, only(db)))!, await changelog(db, only(db)));

test("an edit with no note of yours publishes with one the model wrote, marked generated", async () => {
  const db = d1();
  const sent = network();
  const { ai, asked } = model();
  const post = await pub(db, ai, "first take on feeds");
  expect(asked).toHaveLength(0); // v1 has nothing to describe
  await pub(db, ai, "a second take on feeds", {}, post);
  expect((await doc(db)).changelog[1]).toEqual({ version: 2, at: expect.any(String), note: "Reworded the opening.", generated: true });
  expect(sent.at(-1)).toContain("note (written by the model): Reworded the opening.");
  // the model sees what changed, not the whole post
  expect(JSON.stringify(asked[0])).toContain("Removed lines:\\nfirst take on feeds");
});

test("a /note of yours wins, and the model isn't asked", async () => {
  const db = d1();
  network();
  const { ai, asked } = model();
  const post = await pub(db, ai, "first take");
  await pub(db, ai, "/note sharpened the claim", replyTo(post));
  await pub(db, ai, "second take", {}, post);
  expect(asked).toHaveLength(0);
  expect((await doc(db)).changelog[1]).toEqual({ version: 2, at: expect.any(String), note: "sharpened the claim" });
});

test("a failed, slow, long or copying answer publishes with no note; a withdrawal or the same words back ask nothing", async () => {
  const db = d1();
  network();
  for (const answer of [() => { throw new Error("down"); }, { nope: 1 }, "x".repeat(201)]) {
    expect(await writeNote(model(answer as never).ai, "a", "b")).toBeNull();
  }
  expect(await writeNote({ run: () => new Promise(() => {}) }, "a", "b", 10)).toBeNull();
  // a changelog note must not reproduce withheld prior text (§5.2)
  const before = "the old claim was that feeds should never be read by machines at all";
  expect(await writeNote(model("Removed that feeds should never be read by machines.").ai, before, "something else")).toBeNull();
  // short withheld text counts too: a removed name, a fixed misspelling
  expect(reproducesRemoved("Removed the mention of Bob.", "thanks to Bob and Ann for reading", "thanks to Ann for reading")).toBe(true);
  expect(reproducesRemoved("Changed 'teh' to 'the'.", "teh feed is chatty", "the feed is chatty")).toBe(true);
  expect(reproducesRemoved("Reworded the opening.", "feeds are noisy by design", "feeds are chatty by design")).toBe(false);
  expect(await writeNote(model("Removed the mention of Bob.").ai, "thanks to Bob and Ann", "thanks to Ann")).toBeNull();

  const { ai, asked } = model();
  const post = await pub(db, ai, "words");
  await pub(db, ai, "/withdraw", replyTo(post));
  await pub(db, ai, "/republish", replyTo(post));
  expect(asked).toHaveLength(0);
  expect((await changelog(db, only(db))).map((v) => v.note)).toEqual([null, null, null]);
  // without Workers AI there are no notes and nothing changes
  await pub(db, undefined, "other words", {}, post);
  expect((await changelog(db, only(db))).at(-1)!.note).toBeNull();
});

test("a revision draft sent without a note gets one written from the version it revises", async () => {
  const db = d1();
  network();
  const { ai, asked } = model("Added an afternoon section.");
  const cfg = { ai, token: "t", chatId: -100, pubTopicId: 2, subTopicId: 3, ownerId: 1 };
  await pub(db, ai, "the morning");
  const req = new Request("https://w.example/api/drafts", { method: "POST", headers: { authorization: "Bearer k" }, body: JSON.stringify({ content_md: "the morning\n\nthe afternoon", update: only(db) }) });
  const { message_id } = (await (await handleDraftRequest(req, db, SITE, cfg, "k")).json()) as { message_id: number };
  await pub(db, ai, "/publish", { reply_to_message: { message_id, chat: { id: -100 }, from: { id: 500 } } });
  expect(asked).toHaveLength(1);
  expect((await doc(db)).changelog[1]).toEqual({ version: 2, at: expect.any(String), note: "Added an afternoon section.", generated: true });
});
