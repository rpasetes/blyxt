// Prints chat, topic and user ids from recent messages to the bot.
// Run before the webhook is set (getUpdates is disabled while one is active).
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("set TELEGRAM_BOT_TOKEN (e.g. in .dev.vars)");

type U = { message?: { chat: { id: number; title?: string; type: string }; message_thread_id?: number; from?: { id: number; username?: string }; text?: string } };
const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
const data = (await res.json()) as { ok: boolean; result: U[]; description?: string };
if (!data.ok) throw new Error(data.description);

for (const { message: m } of data.result) {
  if (!m) continue;
  console.log(`chat ${m.chat.id} (${m.chat.title ?? m.chat.type})  topic ${m.message_thread_id ?? "-"}  from ${m.from?.id} @${m.from?.username ?? "?"}  ${JSON.stringify(m.text ?? "")}`);
}
if (!data.result.length) console.log("no updates: send a message in each topic, then rerun");

export {};
