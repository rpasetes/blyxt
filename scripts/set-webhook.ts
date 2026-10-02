// Points Telegram at the deployed Worker: bun run set-webhook https://blyxt.<account>.workers.dev
const [base] = process.argv.slice(2);
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
if (!base || !token || !secret) throw new Error("usage: bun run set-webhook <worker-url>  (needs TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET)");

const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: new URL("/telegram/webhook", base).href,
    secret_token: secret,
    allowed_updates: ["message", "edited_message"],
  }),
});
console.log(await res.json());

export {};
