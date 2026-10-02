# blyxt

A Telegram client for [Blygger](https://blygger.org/spec/0.3/): write in a Telegram group, publish to a blyg.

blyxt is both publisher and subscriber. It is one Cloudflare Worker that receives the Telegram webhook, keeps the blyg in D1, and serves every protocol surface directly — so a message is live as soon as it is sent. `rslantonie.com/blyg/*` is rewritten to the Worker by Vercel, which keeps the blyg's identity at `https://rslantonie.com/blyg/`.

## The group

One Telegram supergroup with Topics:

- **Pub** — send text, it becomes a public fragment. (Planned: edit → new version, pin → pin, shared link → stub.)
- **Sub** — read-only feed of followed blygs. (Planned.)
- **Admin** — `/follow`, `/unfollow`, status. (Planned.)

Only `OWNER_USER_ID` publishes, and only in the Pub topic.

## Develop

```sh
bun install
cp .dev.vars.example .dev.vars    # bot token + webhook secret
bun run db:migrate                # local D1
bun run dev                       # http://localhost:8787/blyg.json
bun test && bun run typecheck
```

## Deploy

1. Bot: create with @BotFather, turn privacy mode off (`/setprivacy` → Disable), add it to the group as an admin.
2. Ids: with no webhook set, post in each topic and run `bun run discover`; put the chat, Pub topic and your user id in `wrangler.jsonc`.
3. Cloudflare: `bunx wrangler login`, `bunx wrangler d1 create blyxt` (copy `database_id` into `wrangler.jsonc`), `bun run db:migrate:remote`, `bunx wrangler secret put TELEGRAM_BOT_TOKEN`, `bunx wrangler secret put TELEGRAM_WEBHOOK_SECRET`, `bun run deploy`.
4. Webhook: `bun run set-webhook https://blyxt.<account>.workers.dev`.
5. motherbase `vercel.json`: rewrite `/blyg/:path*` → `https://blyxt.<account>.workers.dev/:path*`.

Published items are permanent by protocol: never delete rows from `items` or `versions`.
