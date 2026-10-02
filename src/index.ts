import type { Site } from "./blyg";
import { serveBlyg } from "./serve";
import { handleUpdate, type TgUpdate } from "./telegram";

export type Env = {
  DB: D1Database;
  ORIGIN: string;
  SITE_TITLE: string;
  AUTHOR_NAME: string;
  AUTHOR_URL: string;
  TELEGRAM_CHAT_ID: string;
  PUB_TOPIC_ID: string;
  OWNER_USER_ID: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
};

const WEBHOOK_PATH = "/telegram/webhook";

const siteOf = (env: Env): Site => ({
  origin: env.ORIGIN,
  title: env.SITE_TITLE,
  author: { name: env.AUTHOR_NAME, url: env.AUTHOR_URL },
});

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);

    if (url.pathname === WEBHOOK_PATH) {
      if (req.method !== "POST") return new Response("method not allowed\n", { status: 405 });
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("forbidden\n", { status: 403 });
      }
      const after = await handleUpdate((await req.json()) as TgUpdate, env.DB, siteOf(env), {
        token: env.TELEGRAM_BOT_TOKEN,
        chatId: Number(env.TELEGRAM_CHAT_ID),
        pubTopicId: Number(env.PUB_TOPIC_ID),
        ownerId: Number(env.OWNER_USER_ID),
      });
      // acknowledge Telegram first; the confirmation reply goes out after
      if (after) ctx.waitUntil(after());
      return new Response("ok\n");
    }

    if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed\n", { status: 405 });
    // Vercel rewrites rslantonie.com/blyg/:path* → this Worker's /:path*
    return serveBlyg(req, env.DB, siteOf(env), url.pathname.replace(/^\//, ""));
  },
} satisfies ExportedHandler<Env>;
