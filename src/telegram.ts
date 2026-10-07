// Telegram webhook: Pub topic publishes, Sub topic manages subscriptions.
// Bot API: https://core.telegram.org/bots/api
import { pagePath, type Site } from "./blyg";
import { resolve } from "./resolve";
import { itemForMessage, publishEdit, publishNew } from "./store";
import { addSubscription, getSubscription, listSubscriptions, POLL_MINUTES, removeSubscription } from "./subscribe";

export type TgMessage = {
  message_id: number;
  message_thread_id?: number;
  from?: { id: number };
  chat: { id: number };
  text?: string;
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
  const data = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
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
  if (!m?.text || !inPub(cfg, m) || m.text.startsWith("/")) return null;

  // Telegram retries webhooks; a message publishes at most once
  if (await itemForMessage(db, m.chat.id, m.message_id)) return null;

  const item = await publishNew(db, "fragment", m.text.trim(), { chatId: m.chat.id, messageId: m.message_id });
  return () => reply(cfg, m, `published v1 → ${site.origin}${pagePath(item)}`);
}

// editing a published message publishes its next version
async function handleEdit(m: TgMessage, db: D1Database, site: Site, cfg: Config) {
  if (!m.text || !inPub(cfg, m)) return null;
  const link = await itemForMessage(db, m.chat.id, m.message_id);
  if (!link) return null;

  // unchanged text (including Telegram retries) is not a new version
  const item = await publishEdit(db, link.item_id, m.text.trim());
  if (!item) return null;
  return () => reply(cfg, m, `published v${item.version} → ${site.origin}${pagePath(item)}`);
}

const USAGE = "/subscribe <url> · /unsubscribe <url> · /subscriptions";

async function handleSubCommand(m: TgMessage, db: D1Database, cfg: Config) {
  const [command, ...args] = m.text!.trim().split(/\s+/);
  const name = command.slice(1).split("@")[0].toLowerCase();
  const arg = args[0];
  const sub = { token: cfg.token, chatId: cfg.chatId, topicId: cfg.subTopicId };

  if (name === "subscriptions") {
    const subs = await listSubscriptions(db);
    const lines = subs.map((s) => `• ${s.title} — ${s.origin}${s.last_error ? ` (failing: ${s.last_error})` : ""}`);
    return reply(cfg, m, subs.length ? lines.join("\n") : `no subscriptions yet. ${USAGE}`);
  }

  if (name === "subscribe") {
    if (!arg) return reply(cfg, m, `usage: /subscribe <url of a blyg, its homepage, or its feed>`);
    const found = await resolve(arg);
    if (found.type === "failed") return reply(cfg, m, `no blyg found at ${arg}. tried:\n${found.tried.join("\n") || "(invalid url)"}`);
    if (found.type === "legacy") return reply(cfg, m, `${arg} only has a plain RSS feed (${found.feedUrl}); legacy feeds aren't supported yet`);
    if (await getSubscription(db, found.origin)) return reply(cfg, m, `already subscribed to ${found.origin}`);
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
    const subs = await listSubscriptions(db);
    const target = subs.find((s) => sameBlyg(s.origin, arg));
    const origin = target?.origin ?? (await resolveOrigin(arg));
    if (!origin || !(await getSubscription(db, origin))) return reply(cfg, m, `not subscribed to ${arg}`);
    await removeSubscription(db, origin);
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
