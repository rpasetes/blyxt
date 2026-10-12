// Re-renders every message already posted in the Sub topic with the current formatting.
// Edits are silent in Telegram. Reads the remote D1 through wrangler; needs TELEGRAM_BOT_TOKEN.
import { $ } from "bun";
import config from "../wrangler.jsonc";
import { messageText } from "../src/subscribe";
import { tg } from "../src/telegram";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("set TELEGRAM_BOT_TOKEN (e.g. in .dev.vars)");
const chatId = Number(config.vars.TELEGRAM_CHAT_ID);

const query = async <T>(sql: string) => {
  const out = await $`bunx wrangler d1 execute blyxt --remote --json --command ${sql}`.quiet().json();
  return (Array.isArray(out) ? out[0] : out).results as T[];
};

const titles = new Map((await query<{ origin: string; title: string }>("SELECT origin, title FROM subscriptions")).map((s) => [s.origin, s.title]));
const rows = await query<{ origin: string; item_id: string; tg_message_id: number }>("SELECT origin, item_id, tg_message_id FROM imported WHERE tg_message_id IS NOT NULL");

for (const row of rows) {
  const res = await fetch(new URL(`items/${row.item_id}.json`, row.origin));
  if (!res.ok) { console.log(`${row.item_id}: ${res.status}, skipped`); continue; }
  const text = messageText(titles.get(row.origin) ?? row.origin, row.origin, (await res.json()) as Parameters<typeof messageText>[2]);
  const body = { chat_id: chatId, message_id: row.tg_message_id, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } };
  let edited = await tg(token, "editMessageText", body);
  // groups take about 20 messages a minute; wait out a 429 once
  if (edited.error_code === 429) {
    await Bun.sleep(((edited.parameters?.retry_after ?? 30) + 1) * 1000);
    edited = await tg(token, "editMessageText", body);
  }
  console.log(`${row.item_id}: ${edited.ok ? "updated" : edited.description}`);
  await Bun.sleep(3100);
}
