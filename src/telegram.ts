// Telegram webhook: Pub topic publishes, Sub topic manages subscriptions.
// Bot API: https://core.telegram.org/bots/api
import { ID_RE, pagePath, type Site } from "./blyg";
import { compose } from "./compose";
import { resolve } from "./resolve";
import { getItem, itemForMessage, lastContent, pin, publishEdit, publishNew, republish, withdraw } from "./store";
import { addSubscription, getSubscription, listSubscriptions, POLL_MINUTES, removeSubscription } from "./subscribe";

export type TgMessage = {
  message_id: number;
  message_thread_id?: number;
  from?: { id: number };
  chat: { id: number };
  text?: string;
  reply_to_message?: TgMessage;
  pinned_message?: TgMessage;
};
export type TgUpdate = { update_id: number; message?: TgMessage; edited_message?: TgMessage };

export type Config = {
  token: string;
  chatId: number;
  pubTopicId: number;
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

export async function handleUpdate(update: TgUpdate, db: D1Database, site: Site, cfg: Config) {
  if (update.edited_message) return handleEdit(update.edited_message, db, site, cfg);
  const m = update.message;
  if (m?.text && inTopic(cfg, m, cfg.subTopicId) && m.text.startsWith("/")) return () => handleSubCommand(m, db, cfg);
  if (m?.pinned_message && inPub(cfg, m)) return handlePin(m, m.pinned_message, null, db, site, cfg);
  if (!m?.text || !inPub(cfg, m)) return null;
  if (m.text.startsWith("/")) return handlePubCommand(m, db, site, cfg);

  // Telegram retries webhooks; a message publishes at most once
  if (await itemForMessage(db, m.chat.id, m.message_id)) return null;

  const md = m.text.trim();
  const composed = await compose(db, site.origin, md);
  if (!composed.ok) return () => reply(cfg, m, `not published: ${composed.error}. fix it and send it again`);
  const item = await publishNew(db, "fragment", md, composed.html, { chatId: m.chat.id, messageId: m.message_id });
  return () => reply(cfg, m, `published v1 → ${site.origin}${pagePath(item)}`);
}

// editing a published message publishes its next version
async function handleEdit(m: TgMessage, db: D1Database, site: Site, cfg: Config) {
  if (!m.text || !inPub(cfg, m)) return null;
  const link = await itemForMessage(db, m.chat.id, m.message_id);
  if (!link) return null;

  // unchanged text (including Telegram retries) is not a new version
  const md = m.text.trim();
  const composed = await compose(db, site.origin, md);
  if (!composed.ok) return () => reply(cfg, m, `edit not published: ${composed.error}. the post keeps its current version`);
  const item = await publishEdit(db, link.item_id, md, composed.html);
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
  const md = (repliedTo?.item_id === id && m.reply_to_message?.text?.trim()) || (await lastContent(db, id))?.content_md;
  if (!md) return () => reply(cfg, m, "nothing to republish: this post never had content");
  const composed = await compose(db, site.origin, md);
  if (!composed.ok) return () => reply(cfg, m, `not republished: ${composed.error}. edit the post, then /republish again`);
  const next = await republish(db, id, md, composed.html, note);
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

const USAGE = "/subscribe <url> · /unsubscribe <url> · /subscriptions";

async function handleSubCommand(m: TgMessage, db: D1Database, cfg: Config) {
  const [command, ...args] = m.text!.trim().split(/\s+/);
  const name = command.slice(1).split("@")[0].toLowerCase();
  const arg = args[0];
  const sub = { token: cfg.token, chatId: cfg.chatId, topicId: cfg.subTopicId };

  if (name === "subscriptions") {
    const subs = await listSubscriptions(db, sub.topicId);
    const lines = subs.map((s) => `• ${s.title} — ${s.origin}${s.last_error ? ` (failing: ${s.last_error})` : ""}`);
    return reply(cfg, m, subs.length ? lines.join("\n") : `no subscriptions yet. ${USAGE}`);
  }

  if (name === "subscribe") {
    if (!arg) return reply(cfg, m, `usage: /subscribe <url of a blyg, its homepage, or its feed>`);
    const found = await resolve(arg);
    if (found.type === "failed") return reply(cfg, m, `no blyg found at ${arg}. tried:\n${found.tried.join("\n") || "(invalid url)"}`);
    if (found.type === "legacy") return reply(cfg, m, `${arg} only has a plain RSS feed (${found.feedUrl}); legacy feeds aren't supported yet`);
    if (await getSubscription(db, sub.topicId, found.origin)) return reply(cfg, m, `already subscribed to ${found.origin}`);
    try {
      const { title, count } = await addSubscription(db, sub, found.origin, found.manifest);
      const notes = found.warnings.map((w) => `\nnote: ${w}`).join("");
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
    if (!origin || !(await getSubscription(db, sub.topicId, origin))) return reply(cfg, m, `not subscribed to ${arg}`);
    await removeSubscription(db, sub.topicId, origin);
    return reply(cfg, m, `unsubscribed from ${origin}`);
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
  return found.type === "blyg" ? found.origin : null;
}
