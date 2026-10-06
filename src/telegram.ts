// Write side: Telegram webhook → blyg publishes.
// Bot API: https://core.telegram.org/bots/api
import { pagePath, type Site } from "./blyg";
import { itemForMessage, publishEdit, publishNew } from "./store";

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
  ownerId: number;
};

export async function tg(token: string, method: string, body: unknown) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; description?: string };
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

// only the owner, in the configured group's Pub topic, publishes
const inPub = (cfg: Config, m: TgMessage) =>
  m.chat.id === cfg.chatId && m.message_thread_id === cfg.pubTopicId && m.from?.id === cfg.ownerId;

export async function handleUpdate(update: TgUpdate, db: D1Database, site: Site, cfg: Config) {
  if (update.edited_message) return handleEdit(update.edited_message, db, site, cfg);
  const m = update.message;
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
