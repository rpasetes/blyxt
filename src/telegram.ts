// Telegram webhook: Pub topic publishes, Sub topics manage subscriptions.
// Bot API: https://core.telegram.org/bots/api
import { FRAGMENT_CAP, ID_RE, overCap, pagePath, textContent, type Site, type StubOf } from "./blyg";
import { compose } from "./compose";
import { deleteDraft, draftForMessage } from "./drafts";
import { mention } from "./mentions";
import { resolve } from "./resolve";
import { getItem, itemForMessage, lastContent, pin, publishEdit, publishNew, republish, revise, withdraw } from "./store";
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

  const prefix = (await quotePrefix(db, m)) ?? (await linkPrefix(db, site, m));
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
  const item = await publishNew(db, kind, { md, html: composed.html, transclusions: composed.transclusions, stubOf: composed.stub }, { chatId: m.chat.id, messageId: m.message_id, prefix: prefix?.md });
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
async function quotePrefix(db: D1Database, m: TgMessage): Promise<{ md: string; rest?: string } | undefined> {
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
  return { md: `![[${id}]]\n${quote ? quote.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n") + "\n" : ""}\n` };
}

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
  if (snap && text === textContent(snap.content_html).replace(/\n+/g, "\n").trim()) return undefined;
  return text || undefined;
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
    if (found && ID_RE.test(found)) return { md: `![[${found}]]\n\n`, rest: rest.join("\n") };
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
  const md = linked ? linked.md + linked.rest.trim() : (link.prefix ?? "") + m.text.trim();
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
  const item = await publishEdit(db, link.item_id, { md, html: composed.html, transclusions: composed.transclusions });
  if (!item) {
    if ((await getItem(db, link.item_id))?.kind !== "withdrawn") return null;
    return () => reply(cfg, m, "edit not published: this post is withdrawn. reply /republish to it to bring it back with this text");
  }
  return async () => {
    await reply(cfg, m, `published v${item.version} → ${site.origin}${pagePath(item)}`);
    await mention(db, site, item);
  };
}

const PUB_USAGE = "reply to a published post with /withdraw [note], /republish [note] or /pin [vN] (or put its link first: /withdraw <link> [note]); reply to a draft with /publish or /discard";

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
  if (name === "publish" || name === "discard") return handleDraftCommand(m, name, db, site, cfg);
  if (!["withdraw", "republish", "pin"].includes(name)) return () => reply(cfg, m, PUB_USAGE);
  const id = await target(m, db, args);
  if (!id) return () => reply(cfg, m, PUB_USAGE);
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

// a draft another client submitted becomes v1 only when you /publish it in Pub; the preview message
// then stands for the post, so /withdraw and /pin work on it like on your own messages
async function handleDraftCommand(m: TgMessage, name: "publish" | "discard", db: D1Database, site: Site, cfg: Config) {
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
    const c = { md: draft.content_md, html: composed.html, transclusions: composed.transclusions, generated };
    const item = await revise(db, draft.item_id, draft.base_version!, c, draft.note, !!draft.note_generated);
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
      await reply(cfg, m, `published v${item.version}${marked} → ${site.origin}${pagePath(item)}`);
      await mention(db, site, item);
    };
  }
  const long = !composed.thread && overCap(draft.content_md);
  const kind = composed.thread || long ? "thread" : "fragment";
  const item = await publishNew(db, kind, { md: draft.content_md, html: composed.html, transclusions: composed.transclusions, generated, stubOf: composed.stub }, { chatId: m.chat.id, messageId: draft.message_id! });
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
  const next = await republish(db, id, { md, html: composed.html, transclusions: composed.transclusions, generated }, note);
  if (!next) return null;
  return async () => {
    await reply(cfg, m, `republished v${next.version} → ${site.origin}${pagePath(next)}`);
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

const USAGE = "/subscribe <url> · /unsubscribe <url> · /subscriptions · /newsub <name> · /sub <name>";

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
