// Telegram webhook: Pub topic publishes, Sub topics manage subscriptions.
// Bot API: https://core.telegram.org/bots/api
import { FRAGMENT_CAP, ID_RE, overCap, pagePath, textContent, type Site, type StubOf } from "./blyg";
import { compose, labelFor } from "./compose";
import { deleteDraft, draftForMessage } from "./drafts";
import { blogroll, file, setPage, setRolled, unfile } from "./home";
import { mention } from "./mentions";
import { writeNote } from "./notes";
import { resolve } from "./resolve";
import { askedAbout, clearNote, dropHeld, expireHolds, getItem, heldFor, heldForAsk, HOLD_MINUTES, publishHeld, type Held, itemForMessage, lastContent, NOTE_MINUTES, pendingNote, pin, publishEdit, publishNew, queueNote, republish, revise, withdraw } from "./store";
import {
  addLegacySubscription,
  addSubscription,
  getSubscription,
  getSubTopic,
  listAllSubscriptions,
  listSubscriptions,
  nameSubTopic,
  POLL_MINUTES,
  removeSubscription,
} from "./subscribe";

export type TgMessage = {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: { id: number };
  chat: { id: number };
  text?: string;
  reply_to_message?: TgMessage;
  // a reply to a message in another chat or forum topic: in Pub, to a followed post in Sub
  external_reply?: { message_id?: number; chat?: { id: number } };
  // the part of the replied-to message the user selected, if any
  quote?: { text: string };
  pinned_message?: TgMessage;
};
export type TgUpdate = { update_id: number; message?: TgMessage; edited_message?: TgMessage };

export type Config = {
  // Anthropic API key: Haiku writes the changelog notes the owner didn't; unset, blyxt asks for them instead
  anthropicKey?: string;
  token: string;
  chatId: number;
  pubTopicId: number;
  // the home Sub topic; more are registered with /newsub and /sub
  subTopicId: number;
  ownerId: number;
};

export async function tg(token: string, method: string, body: unknown) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; result?: unknown; description?: string; error_code?: number; parameters?: { retry_after?: number } };
  if (!data.ok) console.error(`telegram ${method}: ${data.description}`);
  return data;
}

const reply = (cfg: Config, to: TgMessage, text: string) =>
  tg(cfg.token, "sendMessage", {
    chat_id: to.chat.id,
    message_thread_id: to.message_thread_id,
    reply_parameters: { message_id: to.message_id },
    link_preview_options: { is_disabled: true },
    text,
  });

// only the owner acts, and only in the configured group's topics
const inTopic = (cfg: Config, m: TgMessage, topicId: number) =>
  m.chat.id === cfg.chatId && m.message_thread_id === topicId && m.from?.id === cfg.ownerId;
const inPub = (cfg: Config, m: TgMessage) => inTopic(cfg, m, cfg.pubTopicId);

const commandName = (text: string) => text.trim().split(/\s+/)[0].slice(1).split("@")[0].toLowerCase();

// Sub commands work in the home Sub topic and any registered grouping; /sub adopts any other topic but Pub
async function inSub(db: D1Database, cfg: Config, m: TgMessage) {
  const topicId = m.message_thread_id;
  if (m.chat.id !== cfg.chatId || m.from?.id !== cfg.ownerId || !topicId || topicId === cfg.pubTopicId) return false;
  if (topicId === cfg.subTopicId || (await getSubTopic(db, topicId))) return true;
  return !!m.is_topic_message && commandName(m.text!) === "sub";
}

export async function handleUpdate(update: TgUpdate, db: D1Database, site: Site, cfg: Config) {
  if (update.edited_message) return handleEdit(update.edited_message, db, site, cfg);
  const m = update.message;
  if (m?.text?.startsWith("/") && (await inSub(db, cfg, m))) return () => handleSubCommand(m, db, cfg);
  if (m?.pinned_message && inPub(cfg, m)) return handlePin(m, m.pinned_message, null, db, site, cfg);
  if (!m?.text || !inPub(cfg, m)) return null;
  if (m.text.startsWith("/")) return handlePubCommand(m, db, site, cfg);

  // Telegram retries webhooks; a message publishes at most once
  if (await itemForMessage(db, m.chat.id, m.message_id)) return null;

  // a reply to blyxt's "what changed?" is the note for the edit it holds, never a post of its own
  const held = m.reply_to_message && (await heldForAsk(db, m.chat.id, m.reply_to_message.message_id));
  if (held) {
    if (held.state === "held") return publishHeldEdit(m, held, m.text.trim(), db, site, cfg);
    // a note that came too late is lost, so say so; a retried one for a published edit needs nothing
    if (held.state === "dropped") return () => reply(cfg, m, `that edit was dropped, so the post stays at v${held.base_version}. edit it again to revise it`);
    return null;
  }

  const prefix = (await quotePrefix(db, site, m)) ?? (await linkPrefix(db, site, m));
  const md = (prefix?.md ?? "") + (prefix?.rest ?? m.text).trim();
  const composed = await compose(db, site.origin, md);
  if (!composed.ok) return () => reply(cfg, m, `not published: ${composed.error}. fix it and send it again`);
  // a stub is a response, and one with nothing to say is a misuse (§10.6)
  if (composed.stub && !md.replace(/^!\[\[[^\]]*\]\]\n(?:>.*\n)*/, "").trim()) {
    return () => reply(cfg, m, "not published: say something about it. a stub is a response, so it needs your words after the quote");
  }
  // a message too long for a fragment becomes a thread, which has no cap
  const long = !composed.thread && overCap(md);
  const kind = composed.thread || long ? "thread" : "fragment";
  const item = await publishNew(db, kind, { md, html: composed.html, transclusions: composed.transclusions, links: composed.links, stubOf: composed.stub }, { chatId: m.chat.id, messageId: m.message_id, prefix: prefix?.md });
  return async () => {
    await mention(db, site, item);
    await reply(cfg, m, `published ${kind === "thread" ? "thread " : ""}v1${long ? ` (over ${FRAGMENT_CAP.toLocaleString("en")} characters)` : ""}${await stubNote(db, composed.stub, site, item.id)} → ${site.origin}${pagePath(item)}`);
  };
}

// "(stub of …)" when a thread responds to another blyg's post, and how telling that blyg went (§15.2)
async function stubNote(db: D1Database, stub: StubOf | undefined, site: Site, itemId: string) {
  if (!stub || stub.origin === site.origin) return "";
  const row = await db.prepare("SELECT status FROM mentions_out WHERE item_id = ? AND relation = 'stub'").bind(itemId).first<{ status: string }>();
  const told = { sent: "they've been told", pending: "telling them is retrying", failed: "their blyg refused the mention", "no-endpoint": "their blyg takes no mentions" }[row?.status ?? ""] ?? "not told";
  return ` (stub of ${stub.cited?.source ?? new URL(stub.origin).host}; ${told})`;
}

// replying in Pub to one of your posts, or (from Pub) to a followed post in Sub, quotes it: the reply becomes a thread
// that opens with ![[id]], or with the part you selected as a partial quote (§10.1), and so is a stub of it
async function quotePrefix(db: D1Database, site: Site, m: TgMessage): Promise<{ md: string; rest?: string } | undefined> {
  // (in a topic every message replies to the topic's first message, so check both)
  const external = m.external_reply && (!m.external_reply.chat || m.external_reply.chat.id === m.chat.id) ? m.external_reply.message_id : undefined;
  let id: string | undefined;
  let followed: { origin: string; item_id: string } | null = null;
  for (const to of [m.reply_to_message?.message_id, external]) {
    if (!to || id) continue;
    id = (await itemForMessage(db, m.chat.id, to))?.item_id;
    if (!id) id = (followed = await followedForMessage(db, to))?.item_id;
  }
  if (!id) return undefined;
  const quote = followed ? await unframe(db, followed, m.quote?.text) : m.quote?.text.trim();
  return { md: `${await directive(db, site, id)}\n${quote ? quote.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n") + "\n" : ""}\n` };
}

// the changelog note a publish carried, as its reply says it; one the model wrote is marked so
const noteLine = (note: string | null | undefined, generated: boolean) => (note ? `\nnote${generated ? " (written by the model)" : ""}: ${note}` : "");

// the directive line blyxt writes, labelled with what it quotes
const directive = async (db: D1Database, site: Site, id: string) => {
  const label = await labelFor(db, site.origin, id);
  return `![[${id}${label ? ` | ${label}` : ""}]]`;
};

// A quote taken from a Sub message, as the followed post's own text: without the lines blyxt frames it with
// (blyg title, "in response to", ↳ links, the post's link), and with Telegram's paragraph gaps as single breaks,
// as text content keeps them (§10.2). A quote of the whole post is a whole quote, not a partial one.
async function unframe(db: D1Database, post: { origin: string; item_id: string }, quote?: string) {
  if (!quote?.trim()) return undefined;
  const sub = await db.prepare("SELECT title FROM subscriptions WHERE origin = ?").bind(post.origin).first<{ title: string }>();
  const lines = quote.split("\n").map((l) => l.trim());
  if (sub && (lines[0] === sub.title || lines[0]?.startsWith(`${sub.title} · v`))) lines.shift();
  const text = lines
    .filter((l) => !l.startsWith("↩ in response to ") && !l.startsWith("↳ ") && !/^https?:\/\/\S+$/.test(l))
    .filter((l, i, all) => l || (i > 0 && all[i - 1])) // one break between paragraphs
    .join("\n").replace(/\n+/g, "\n").trim();
  const snap = await db.prepare("SELECT content_html FROM snapshots WHERE origin = ? AND item_id = ?").bind(post.origin, post.item_id).first<{ content_html: string }>();
  if (!snap) return text || undefined;
  const own = textContent(snap.content_html).replace(/\n+/g, "\n").trim();
  // Sub shows images as [image] / [image: alt] links (tghtml), but they have no text in the post itself
  const unlabeled = text.replace(/\[image(?:: [^\]\n]*)?\]/g, "").split("\n").map((l) => l.replace(/[^\S\n]+/g, " ").trim()).filter(Boolean).join("\n");
  const quoted = own.includes(text) || !own.includes(unlabeled) ? text : unlabeled;
  if (quoted === own) return undefined;
  return quoted || undefined;
}

// the followed post a Sub message shows (or a reply blyxt posted under it for a later version)
const followedForMessage = (db: D1Database, messageId: number) =>
  db.prepare("SELECT origin, item_id FROM imported WHERE tg_message_id = ?1 OR reply_message_id = ?1 LIMIT 1").bind(messageId).first<{ origin: string; item_id: string }>();

// a message that opens with the link to a post (yours or a followed blyg's) quotes it like a reply would;
// the rest of the message is what you say about it
async function linkPrefix(db: D1Database, site: Site, m: TgMessage) {
  const [first, ...rest] = m.text!.trim().split("\n");
  const url = first.trim();
  if (!/^https?:\/\/\S+$/.test(url)) return undefined;
  const { results } = await db.prepare("SELECT origin FROM subscriptions WHERE legacy = 0").all<{ origin: string }>();
  for (const origin of [site.origin, ...results.map((r) => r.origin)]) {
    if (!url.startsWith(origin)) continue;
    const id = url.slice(origin.length).match(/^(?:[ft]\/([0-9a-z]{26})\/?(?:v\d+\/?)?|items\/([0-9a-z]{26})\.json)(?:[?#].*)?$/);
    const found = id?.[1] ?? id?.[2];
    if (found && ID_RE.test(found)) return { md: `${await directive(db, site, found)}\n\n`, rest: rest.join("\n") };
  }
  return undefined;
}

// editing a published message publishes its next version
async function handleEdit(m: TgMessage, db: D1Database, site: Site, cfg: Config) {
  if (!m.text || !inPub(cfg, m)) return null;
  const link = await itemForMessage(db, m.chat.id, m.message_id);
  if (!link) return null;

  // unchanged text (including Telegram retries) is not a new version
  // a message that opened with a link keeps its first line as the link: it rebuilds the same quote
  const linked = link.prefix ? await linkPrefix(db, site, m) : undefined;
  // a link to the same post keeps the directive it was published with, label included: the label is the
  // author's words, and a re-read snapshot mustn't rewrite it
  const quoted = (md: string | null | undefined) => md?.match(/^!\[\[([0-9a-z]{26})/)?.[1];
  const prefix = linked && quoted(linked.md) === quoted(link.prefix) ? link.prefix! : linked?.md;
  const md = linked ? prefix + linked.rest.trim() : (link.prefix ?? "") + m.text.trim();
  const composed = await compose(db, site.origin, md, link.item_id);
  if (!composed.ok) return () => reply(cfg, m, `edit not published: ${composed.error}. the post keeps its current version`);
  // the kind is fixed when a post is first published: it decides the page's address
  const current = await getItem(db, link.item_id);
  if (current?.authored_kind === "fragment" && overCap(md)) {
    return () => reply(cfg, m, `edit not published: fragments stay within ${FRAGMENT_CAP.toLocaleString("en")} characters, and this is ${[...md].length.toLocaleString("en")}. trim it, or send it as a new message to publish a thread`);
  }
  if (composed.thread && current?.authored_kind === "fragment") {
    return () => reply(cfg, m, "edit not published: a fragment can't quote. send it as a new message (or reply to the post you're quoting)");
  }
  const edited = await publishEdit(db, link.item_id, { md, html: composed.html, transclusions: composed.transclusions, links: composed.links }, m.chat.id, (before) => writeNote(cfg.anthropicKey, before, md));
  if (!edited) {
    if ((await getItem(db, link.item_id))?.kind !== "withdrawn") return null;
    return () => reply(cfg, m, "edit not published: this post is withdrawn. reply /republish to it to bring it back with this text");
  }
  // a link moved to another post: its new directive is the one later edits keep
  if (linked && prefix !== link.prefix) await db.prepare("UPDATE tg_messages SET prefix = ? WHERE chat_id = ? AND message_id = ?").bind(prefix, m.chat.id, m.message_id).run();
  // no note to publish with: the edit waits, and blyxt asks once (a later edit updates what it holds)
  if (edited.held) {
    const { held } = edited;
    if (held.asked) return null;
    return async () => {
      const asked = await reply(cfg, m, `held v${held.version}: what changed? reply to this with a changelog note and the edit publishes with it. edit again first to change it; reply /discard, or leave it ${HOLD_MINUTES} minutes, to drop it`);
      if (asked.ok) await askedAbout(db, held.id, (asked.result as { message_id: number }).message_id);
    };
  }
  const { item, note, generated } = edited;
  return async () => {
    await reply(cfg, m, `published v${item.version} → ${site.origin}${pagePath(item)}${noteLine(note, generated)}`);
    await mention(db, site, item);
  };
}

const PUB_USAGE = "reply to a published post with /note <what you're changing> before editing it, /withdraw [note], /republish [note] or /pin [vN] (or put its link first: /withdraw <link> [note]); /file <collection>, /unfile <collection>, /page <menu label> or /unpage; reply to a draft with /publish or /discard, or /discard a held edit";

// the post a command names: the message it replies to, else a link or id as the first argument
// (in a topic, a message that isn't a reply still replies to the topic's opening message, which maps to nothing)
async function target(m: TgMessage, db: D1Database, args: string[]) {
  const replied = m.reply_to_message && (await itemForMessage(db, m.chat.id, m.reply_to_message.message_id));
  if (replied) return replied.item_id;
  const named = args[0]?.match(/([0-9a-z]{26})\/?$/)?.[1];
  if (named && ID_RE.test(named)) { args.shift(); return named; }
  return null;
}

async function handlePubCommand(m: TgMessage, db: D1Database, site: Site, cfg: Config) {
  const [command, ...args] = m.text!.trim().split(/\s+/);
  const name = command.slice(1).split("@")[0].toLowerCase();
  if (name === "discard") {
    // a held edit: dropped by replying to blyxt's question, or to the post
    const to = m.reply_to_message?.message_id;
    const asked = to ? await heldForAsk(db, m.chat.id, to) : null;
    const post = !asked && to ? await itemForMessage(db, m.chat.id, to) : null;
    const held = asked ?? (post ? await heldFor(db, post.item_id) : null);
    if (held) {
      if (held.state !== "held") return () => reply(cfg, m, "nothing held: that edit was already published or dropped");
      await dropHeld(db, held);
      return () => reply(cfg, m, `dropped the held edit: the post stays at v${held.base_version}. your message still shows the edit; edit it again to revise`);
    }
  }
  if (name === "publish" || name === "discard") return handleDraftCommand(m, name, db, site, cfg, args.join(" "));
  if (!["note", "withdraw", "republish", "pin", "file", "unfile", "page", "unpage"].includes(name)) return () => reply(cfg, m, PUB_USAGE);
  const id = await target(m, db, args);
  if (!id) return () => reply(cfg, m, PUB_USAGE);
  if (["file", "unfile", "page", "unpage"].includes(name)) return handleHome(m, name, id, args.join(" "), db, site, cfg);
  if (name === "note") return handleNote(m, id, args.join(" "), db, site, cfg);
  if (name === "pin") return handlePin(m, null, id, db, site, cfg, args[0]);
  if (name === "republish") return handleRepublish(m, id, args.join(" ") || null, db, site, cfg);

  const note = args.join(" ") || null;
  const item = await withdraw(db, id, note);
  if (item) {
    return async () => {
      await reply(cfg, m, `withdrawn v${item.version} → ${site.origin}${pagePath(item)}\nits content is gone from the blyg, feed and followers' readers; the page stays as an endcap`);
      await mention(db, site, item);
    };
  }
  const existing = await getItem(db, id);
  if (!existing) return () => reply(cfg, m, `no post ${id} on this blyg`);
  return () => reply(cfg, m, `already withdrawn (v${existing.version})`);
}

// filing a post or listing it in the menu changes the home page only: no version, no feed entry, no mention
async function handleHome(m: TgMessage, name: string, id: string, arg: string, db: D1Database, site: Site, cfg: Config) {
  const item = await getItem(db, id);
  if (!item) return () => reply(cfg, m, `no post ${id} on this blyg`);
  if (name === "unpage") {
    await setPage(db, id, null);
    return () => reply(cfg, m, "off the menu");
  }
  if (!arg) return () => reply(cfg, m, name === "page" ? "/page <label>, e.g. /page About" : `/${name} <collection>`);
  if (name === "page") {
    await setPage(db, id, arg);
    return () => reply(cfg, m, `on the menu as "${arg}" → ${site.origin}`);
  }
  if (name === "unfile") {
    const had = await unfile(db, id, arg);
    return () => reply(cfg, m, had ? `taken out of ${arg}` : `not in ${arg}`);
  }
  const filed = await file(db, id, arg);
  if (!filed) return () => reply(cfg, m, "a collection name needs a letter or digit");
  return () => reply(cfg, m, `${filed.added ? "filed in" : "already in"} ${filed.name} → ${site.origin}h/${encodeURIComponent(filed.slug)}/`);
}

// from the cron: holds left unanswered are dropped, and their questions say so
export async function expireHeldEdits(db: D1Database, cfg: Pick<Config, "token">) {
  for (const held of await expireHolds(db)) {
    if (!held.ask_message_id) continue;
    await tg(cfg.token, "editMessageText", {
      chat_id: held.chat_id,
      message_id: held.ask_message_id,
      text: `dropped v${held.base_version + 1}: no note within ${HOLD_MINUTES} minutes, so the post stays at v${held.base_version}. edit it again to revise it`,
    });
  }
}

// a held edit publishes as the next version, with the owner's note
async function publishHeldEdit(m: TgMessage, held: Held, note: string, db: D1Database, site: Site, cfg: Config) {
  if (!note) return () => reply(cfg, m, "a changelog note needs words: say what changed");
  const item = await publishHeld(db, held, note);
  if (!item) return () => reply(cfg, m, "not published: that edit was dropped (the post changed since, or it waited too long). edit it again");
  return async () => {
    await reply(cfg, m, `published v${item.version} → ${site.origin}${pagePath(item)}${noteLine(note, false)}`);
    await mention(db, site, item);
  };
}

// /note queues the changelog note for a post's next edit (or publishes one waiting for it); /note alone takes it back
async function handleNote(m: TgMessage, id: string, note: string, db: D1Database, site: Site, cfg: Config) {
  const item = await getItem(db, id);
  if (!item) return () => reply(cfg, m, `no post ${id} on this blyg`);
  if (!note) {
    const had = await pendingNote(db, id);
    await clearNote(db, id);
    return () => reply(cfg, m, had ? `dropped the note "${had}"; the next edit will ask for one` : "no note queued for this post");
  }
  if (item.kind === "withdrawn") return () => reply(cfg, m, "this post is withdrawn: reply /republish <note> to bring it back with a note");
  // an edit already waiting for its note publishes with this one
  const held = await heldFor(db, id);
  if (held) return publishHeldEdit(m, held, note, db, site, cfg);
  await queueNote(db, id, note);
  return () => reply(cfg, m, `noted. your next edit publishes v${item.version + 1} with "${note}" (within ${NOTE_MINUTES} minutes; /note alone drops it)`);
}

// a draft another client submitted becomes v1 only when you /publish it in Pub; the preview message
// then stands for the post, so /withdraw and /pin work on it like on your own messages
async function handleDraftCommand(m: TgMessage, name: "publish" | "discard", db: D1Database, site: Site, cfg: Config, note = "") {
  const to = m.reply_to_message?.message_id;
  const draft = to && (await draftForMessage(db, m.chat.id, to));
  if (!draft) {
    // a retried /publish finds the draft already gone and the post in its place
    const published = to && (await itemForMessage(db, m.chat.id, to));
    const item = published && (await getItem(db, published.item_id));
    if (item) return () => reply(cfg, m, `already published → ${site.origin}${pagePath(item)}`);
    return () => reply(cfg, m, `reply /${name} to a draft's preview`);
  }

  if (name === "discard") {
    // nothing was ever public: a hard delete (§9)
    await deleteDraft(db, draft.id);
    return async () => {
      for (const id of [draft.message_id, draft.file_message_id]) if (id) await tg(cfg.token, "deleteMessage", { chat_id: cfg.chatId, message_id: id });
      await tg(cfg.token, "sendMessage", { chat_id: cfg.chatId, message_thread_id: cfg.pubTopicId, text: "discarded the draft; nothing was published" });
    };
  }

  // quoted posts may have changed since the draft arrived: it publishes against them as they are now
  const composed = await compose(db, site.origin, draft.content_md, draft.item_id ?? undefined);
  if (!composed.ok) return () => reply(cfg, m, `not published: ${composed.error}. the draft stays; /discard it and send a new one`);
  const generated = draft.generated ? JSON.parse(draft.generated) : undefined;
  const marked = generated ? " (marked machine-generated)" : "";

  if (draft.item_id) {
    const c = { md: draft.content_md, html: composed.html, transclusions: composed.transclusions, links: composed.links, generated };
    // every version has a note: the draft's, else yours as /publish <note>, else one Haiku writes from the version
    // it revises; with none of those it waits for yours
    const given = draft.note ?? (note || null);
    const before = given ? null : await getItem(db, draft.item_id);
    const auto = before && before.kind !== "withdrawn" && before.version === draft.base_version ? await writeNote(cfg.anthropicKey, before.content_md, draft.content_md) : null;
    if (!given && !auto) return () => reply(cfg, m, "not published: this revision has no changelog note. reply /publish <what changed> to publish it with yours");
    const item = await revise(db, draft.item_id, draft.base_version!, c, given ?? auto, draft.note ? !!draft.note_generated : !given);
    if (!item) {
      const now = await getItem(db, draft.item_id);
      return () => reply(cfg, m, now?.kind === "withdrawn"
        ? "not published: the post was withdrawn since this draft. /republish it, then ask for a new revision"
        : `not published: the post moved to v${now?.version} since this draft was written against v${draft.base_version}. /discard it and ask for a new revision`);
    }
    // the revision's preview stands for the post too, so commands work replying to either
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO tg_messages (chat_id, message_id, item_id) VALUES (?, ?, ?)").bind(m.chat.id, draft.message_id, item.id),
      db.prepare("DELETE FROM drafts WHERE id = ?").bind(draft.id),
    ]);
    return async () => {
      await reply(cfg, m, `published v${item.version}${marked} → ${site.origin}${pagePath(item)}${noteLine(auto, true)}`);
      await mention(db, site, item);
    };
  }
  const long = !composed.thread && overCap(draft.content_md);
  const kind = composed.thread || long ? "thread" : "fragment";
  const item = await publishNew(db, kind, { md: draft.content_md, html: composed.html, transclusions: composed.transclusions, links: composed.links, generated, stubOf: composed.stub }, { chatId: m.chat.id, messageId: draft.message_id! });
  await deleteDraft(db, draft.id);
  return async () => {
    await mention(db, site, item);
    await reply(cfg, m, `published ${kind === "thread" ? "thread " : ""}v1${marked}${await stubNote(db, composed.stub, site, item.id)} → ${site.origin}${pagePath(item)}`);
  };
}

// a withdrawn post comes back as its next version: the replied-to message's text as it reads now,
// else the last content it published, with its generation disclosure
// (a draft's preview is the bot's message, not the post's text, so only your own messages count)
async function handleRepublish(m: TgMessage, id: string, note: string | null, db: D1Database, site: Site, cfg: Config) {
  const item = await getItem(db, id);
  if (!item) return () => reply(cfg, m, `no post ${id} on this blyg`);
  if (item.kind !== "withdrawn") return () => reply(cfg, m, `this post isn't withdrawn (it's at v${item.version})`);
  const repliedTo = m.reply_to_message && (await itemForMessage(db, m.chat.id, m.reply_to_message.message_id));
  const text = repliedTo?.item_id === id && m.reply_to_message?.from?.id === cfg.ownerId && m.reply_to_message.text?.trim();
  const last = text ? null : await lastContent(db, id);
  const md = text ? (repliedTo.prefix ?? "") + text : last?.content_md;
  if (!md) return () => reply(cfg, m, "nothing to republish: this post never had content");
  const composed = await compose(db, site.origin, md, id);
  if (!composed.ok) return () => reply(cfg, m, `not republished: ${composed.error}. edit the post, then /republish again`);
  if (composed.thread && item.authored_kind === "fragment") return () => reply(cfg, m, "not republished: a fragment can't quote. edit out the ![[id]] line, then /republish again");
  if (item.authored_kind === "fragment" && overCap(md)) return () => reply(cfg, m, `not republished: fragments stay within ${FRAGMENT_CAP.toLocaleString("en")} characters. trim the post, then /republish again`);
  const generated = last?.generated ? JSON.parse(last.generated) : undefined;
  // with no note of yours, one is written from the last words it published; the same words back get none
  const before = note ? null : (last ?? (await lastContent(db, id)))?.content_md;
  const auto = before && before !== md ? await writeNote(cfg.anthropicKey, before, md) : null;
  // bringing back different words is a revision, and a revision says what changed
  if (before && before !== md && !auto) return () => reply(cfg, m, "not republished: the words differ from what it last published, so it needs a changelog note. reply /republish <what changed>");
  const next = await republish(db, id, { md, html: composed.html, transclusions: composed.transclusions, links: composed.links, generated }, note ?? auto, !!auto);
  if (!next) return null;
  return async () => {
    await reply(cfg, m, `republished v${next.version} → ${site.origin}${pagePath(next)}${noteLine(auto, true)}`);
    await mention(db, site, next);
  };
}

// pinning in Telegram, or /pin [vN], pins a version forever (§8); Telegram doesn't report unpins, and pins can't be undone anyway
async function handlePin(m: TgMessage, pinned: TgMessage | null, id: string | null, db: D1Database, site: Site, cfg: Config, versionArg?: string) {
  if (pinned) {
    const link = await itemForMessage(db, pinned.chat.id, pinned.message_id);
    if (!link) return null; // pinning chat that isn't a post is just Telegram
    id = link.item_id;
  }
  const item = await getItem(db, id!);
  if (!item) return () => reply(cfg, m, `no post ${id} on this blyg`);
  if (versionArg && !/^v?[1-9]\d*$/i.test(versionArg)) return () => reply(cfg, m, "usage: /pin [vN], replying to the post");
  const version = versionArg ? Number(versionArg.replace(/^v/i, "")) : item.version;
  const page = `${site.origin}${pagePath(item)}`;

  const result = await pin(db, item.id, version);
  if (result === "no such version") return () => reply(cfg, m, `this post has no v${version} (it's at v${item.version})`);
  if (result === "endcap") return () => reply(cfg, m, versionArg ? `v${version} is the withdrawal; there's nothing to pin` : `this post is withdrawn; pin an earlier version with /pin vN`);
  if (result === "already") return () => reply(cfg, m, `v${version} is already pinned → ${page}v${version}/`);
  return () => reply(cfg, m, `pinned v${version} → ${page}v${version}/\nthis version stays readable forever, through edits and withdrawal. a pin can't be undone; unpinning in Telegram doesn't change it`);
}

const USAGE = "/subscribe <url> · /unsubscribe <url> · /subscriptions · /newsub <name> · /sub <name> · /roll [url] · /unroll <url>";

async function handleSubCommand(m: TgMessage, db: D1Database, cfg: Config) {
  const [, ...args] = m.text!.trim().split(/\s+/);
  const name = commandName(m.text!);
  const arg = args[0];
  const sub = { token: cfg.token, chatId: cfg.chatId, topicId: m.message_thread_id! };
  const home = sub.topicId === cfg.subTopicId;

  if (name === "subscriptions") {
    const line = (s: { title?: string; origin?: string; last_error?: string | null; lossy?: number; legacy?: number }) =>
      `• ${s.title} — ${s.origin}${s.legacy ? " (RSS)" : ""}${s.lossy ? " (feed only: no archive index)" : ""}${s.last_error ? ` (failing: ${s.last_error})` : ""}`;
    if (!home) {
      const subs = await listSubscriptions(db, sub.topicId);
      return reply(cfg, m, subs.length ? subs.map(line).join("\n") : `no subscriptions here yet. ${USAGE}`);
    }
    // the home topic shows every grouping
    const groups = new Map<string, string[]>();
    for (const row of await listAllSubscriptions(db)) {
      const label = row.topic_id === cfg.subTopicId ? `${row.name} (here)` : row.name;
      groups.set(label, [...(groups.get(label) ?? []), ...(row.origin ? [line(row)] : [])]);
    }
    const text = [...groups].map(([label, lines]) => `${label}\n${lines.join("\n") || "(nothing yet)"}`).join("\n\n");
    return reply(cfg, m, text || `no subscriptions yet. ${USAGE}`);
  }

  if (name === "newsub") {
    const topicName = args.join(" ");
    if (!topicName) return reply(cfg, m, "usage: /newsub <name> — creates a topic that follows its own blygs");
    const created = await tg(cfg.token, "createForumTopic", { chat_id: cfg.chatId, name: topicName });
    if (!created.ok) return reply(cfg, m, `couldn't create the topic: ${created.description}. the bot needs the "manage topics" admin right`);
    const topicId = (created.result as { message_thread_id: number }).message_thread_id;
    await nameSubTopic(db, topicId, topicName);
    await tg(cfg.token, "sendMessage", { chat_id: cfg.chatId, message_thread_id: topicId, text: `${topicName} follows its own blygs. ${USAGE}` });
    return reply(cfg, m, `created ${topicName}; /subscribe there to fill it`);
  }

  if (name === "sub") {
    const topicName = args.join(" ");
    if (!topicName) return reply(cfg, m, "usage: /sub <name> — makes this topic a Sub grouping, or renames it");
    const existing = await getSubTopic(db, sub.topicId);
    await nameSubTopic(db, sub.topicId, topicName);
    if (existing) return reply(cfg, m, `renamed ${existing.name} to ${topicName}`);
    return reply(cfg, m, `this topic is now ${topicName}, a Sub grouping. ${USAGE}`);
  }

  if (name === "subscribe") {
    if (!arg) return reply(cfg, m, `usage: /subscribe <url of a blyg, its homepage, or its feed>`);
    const found = await resolve(arg);
    if (found.type === "failed") return reply(cfg, m, `no blyg found at ${arg}. tried:\n${found.tried.join("\n") || "(invalid url)"}`);
    if (found.type === "legacy") {
      if (await getSubscription(db, sub.topicId, found.feedUrl)) return reply(cfg, m, `already subscribed to ${found.feedUrl} here`);
      try {
        const { title, count } = await addLegacySubscription(db, sub, found.feedUrl);
        return reply(cfg, m, `subscribed to ${title} — ${found.feedUrl}\nit's a plain RSS feed, not a blyg: posts show here as a title, summary and link (marked RSS), and only what's in the feed when blyxt looks. ${count} in the feed now`);
      } catch (e) {
        return reply(cfg, m, `found a feed at ${found.feedUrl} but couldn't read it: ${(e as Error).message}`);
      }
    }
    if (await getSubscription(db, sub.topicId, found.origin)) return reply(cfg, m, `already subscribed to ${found.origin} here`);
    try {
      const { title, count, lossy } = await addSubscription(db, sub, found.origin, found.manifest);
      const warnings = [...found.warnings, ...(lossy ? ["it has no archive index, so blyxt follows its feed instead; posts that scroll out of the feed between polls can be missed"] : [])];
      const notes = warnings.map((w) => `\nnote: ${w}`).join("");
      return reply(cfg, m, `subscribed to ${title} — ${found.origin}\n${count} item${count === 1 ? "" : "s"} so far; new posts and edits show up here within ${POLL_MINUTES} minutes${notes}`);
    } catch (e) {
      return reply(cfg, m, `found a blyg at ${found.origin} but couldn't read its archive: ${(e as Error).message}`);
    }
  }

  // the blogroll is opt-in per blyg (§11): /roll <url> shows one on the home page and in blogroll.opml
  if (name === "roll" || name === "unroll") {
    if (!arg) {
      if (name === "unroll") return reply(cfg, m, "usage: /unroll <url>");
      const rolled = await blogroll(db);
      return reply(cfg, m, rolled.length ? `in the blogroll:\n${rolled.map((r) => `• ${r.title} — ${r.htmlUrl ?? r.xmlUrl}`).join("\n")}` : "the blogroll is empty: /roll <url> adds a blyg you follow");
    }
    const all = (await listAllSubscriptions(db)).filter((s) => s.origin);
    const found = all.find((s) => sameBlyg(s.origin!, arg));
    if (!found) return reply(cfg, m, `not subscribed to ${arg}`);
    await setRolled(db, found.origin!, name === "roll");
    return reply(cfg, m, name === "roll" ? `${found.title} is in the blogroll` : `${found.title} is out of the blogroll`);
  }

  if (name === "unsubscribe") {
    if (!arg) return reply(cfg, m, "usage: /unsubscribe <url>");
    const subs = await listSubscriptions(db, sub.topicId);
    const target = subs.find((s) => sameBlyg(s.origin, arg));
    const origin = target?.origin ?? (await resolveOrigin(arg));
    if (!origin || !(await getSubscription(db, sub.topicId, origin))) return reply(cfg, m, `not subscribed to ${arg} here`);
    await removeSubscription(db, sub.topicId, origin);
    return reply(cfg, m, `unsubscribed from ${origin} here`);
  }

  return reply(cfg, m, USAGE);
}

// match a typed URL against a stored origin without refetching
function sameBlyg(origin: string, input: string) {
  const strip = (u: string) => u.replace(/^https?:\/\//, "").replace(/[?#].*$/, "").replace(/\/?$/, "/").toLowerCase();
  return strip(origin) === strip(input);
}

async function resolveOrigin(input: string) {
  const found = await resolve(input);
  return found.type === "blyg" ? found.origin : found.type === "legacy" ? found.feedUrl : null;
}
