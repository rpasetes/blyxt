// Telegram webhook: Pub topic publishes, Sub topics manage subscriptions.
// Bot API: https://core.telegram.org/bots/api
import { FRAGMENT_CAP, ID_RE, overCap, pagePath, type Site } from "./blyg";
import { compose } from "./compose";
import { resolve } from "./resolve";
import { getItem, itemForMessage, lastContent, pin, publishEdit, publishNew, republish, withdraw } from "./store";
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

  const prefix = await quotePrefix(db, m);
  const md = (prefix ?? "") + m.text.trim();
  const composed = await compose(db, site.origin, md);
  if (!composed.ok) return () => reply(cfg, m, `not published: ${composed.error}. fix it and send it again`);
  // a message too long for a fragment becomes a thread, which has no cap
  const long = !composed.thread && overCap(md);
  const kind = composed.thread || long ? "thread" : "fragment";
  const item = await publishNew(db, kind, { md, html: composed.html, transclusions: composed.transclusions }, { chatId: m.chat.id, messageId: m.message_id, prefix });
  return () => reply(cfg, m, `published ${kind === "thread" ? "thread " : ""}v1${long ? ` (over ${FRAGMENT_CAP.toLocaleString("en")} characters)` : ""} → ${site.origin}${pagePath(item)}`);
}

// replying in Pub to one of your posts quotes it: the reply becomes a thread that opens with ![[id]],
// or with the part you selected as a partial quote (§10.1)
async function quotePrefix(db: D1Database, m: TgMessage) {
  const to = m.reply_to_message && (await itemForMessage(db, m.chat.id, m.reply_to_message.message_id));
  if (!to) return undefined;
  const quote = m.quote?.text.trim();
  return `![[${to.item_id}]]\n${quote ? quote.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n") + "\n" : ""}\n`;
}

// editing a published message publishes its next version
async function handleEdit(m: TgMessage, db: D1Database, site: Site, cfg: Config) {
  if (!m.text || !inPub(cfg, m)) return null;
  const link = await itemForMessage(db, m.chat.id, m.message_id);
  if (!link) return null;

  // unchanged text (including Telegram retries) is not a new version
  const md = (link.prefix ?? "") + m.text.trim();
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
  return () => reply(cfg, m, `published v${item.version} → ${site.origin}${pagePath(item)}`);
}

const PUB_USAGE = "reply to a published post with /withdraw [note], /republish [note] or /pin [vN] (or put its link first: /withdraw <link> [note])";

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
  if (!["withdraw", "republish", "pin"].includes(name)) return () => reply(cfg, m, PUB_USAGE);
  const id = await target(m, db, args);
  if (!id) return () => reply(cfg, m, PUB_USAGE);
  if (name === "pin") return handlePin(m, null, id, db, site, cfg, args[0]);
  if (name === "republish") return handleRepublish(m, id, args.join(" ") || null, db, site, cfg);

  const note = args.join(" ") || null;
  const item = await withdraw(db, id, note);
  if (item) return () => reply(cfg, m, `withdrawn v${item.version} → ${site.origin}${pagePath(item)}\nits content is gone from the blyg, feed and followers' readers; the page stays as an endcap`);
  const existing = await getItem(db, id);
  if (!existing) return () => reply(cfg, m, `no post ${id} on this blyg`);
  return () => reply(cfg, m, `already withdrawn (v${existing.version})`);
}

// a withdrawn post comes back as its next version: the replied-to message's text as it reads now,
// else the last content it published
async function handleRepublish(m: TgMessage, id: string, note: string | null, db: D1Database, site: Site, cfg: Config) {
  const item = await getItem(db, id);
  if (!item) return () => reply(cfg, m, `no post ${id} on this blyg`);
  if (item.kind !== "withdrawn") return () => reply(cfg, m, `this post isn't withdrawn (it's at v${item.version})`);
  const repliedTo = m.reply_to_message && (await itemForMessage(db, m.chat.id, m.reply_to_message.message_id));
  const text = repliedTo?.item_id === id && m.reply_to_message?.text?.trim();
  const md = text ? (repliedTo.prefix ?? "") + text : (await lastContent(db, id))?.content_md;
  if (!md) return () => reply(cfg, m, "nothing to republish: this post never had content");
  const composed = await compose(db, site.origin, md, id);
  if (!composed.ok) return () => reply(cfg, m, `not republished: ${composed.error}. edit the post, then /republish again`);
  if (composed.thread && item.authored_kind === "fragment") return () => reply(cfg, m, "not republished: a fragment can't quote. edit out the ![[id]] line, then /republish again");
  if (item.authored_kind === "fragment" && overCap(md)) return () => reply(cfg, m, `not republished: fragments stay within ${FRAGMENT_CAP.toLocaleString("en")} characters. trim the post, then /republish again`);
  const next = await republish(db, id, { md, html: composed.html, transclusions: composed.transclusions }, note);
  if (!next) return null;
  return () => reply(cfg, m, `republished v${next.version} → ${site.origin}${pagePath(next)}`);
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
