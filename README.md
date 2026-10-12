# blyxt

A Telegram client for [Blygger](https://blygger.org/spec/0.3/): write in a Telegram group, publish to a blyg.

blyxt is both publisher and subscriber. It is one Cloudflare Worker that receives the Telegram webhook, keeps the blyg in D1, and serves every protocol surface directly — so a message is live as soon as it is sent. `rslantonie.com/blyg/*` is rewritten to the Worker by Vercel, which keeps the blyg's identity at `https://rslantonie.com/blyg/`.

## The group

One Telegram supergroup with Topics:

- **Pub** — send text, it becomes a public fragment; edit it to publish a new version. Reply to one of your posts to publish a thread that quotes it (select part of the post first to quote just that part), or put `![[id]]` on a line of its own. A message over 2,000 characters publishes as a thread, since fragments are capped there. Reply `/withdraw [note]` to a published post to withdraw it: its content is emptied everywhere and its page stays as an endcap; reply `/republish [note]` to bring it back. Pin a post in Telegram (or reply `/pin [vN]`) to pin that version forever at `items/{id}/v{n}.json` and `f/{id}/v{n}/`. (Planned: shared link → stub.)
- **Drafts from other clients** — an agent or script can propose a post with `bun run draft <file.md>` (or `POST /api/drafts` with `Authorization: Bearer $DRAFT_TOKEN`). The bot previews it in Pub, attaching the whole markdown when the preview is cut short; reply `/publish` to it to publish v1, or `/discard` to drop it. Nothing is public until you publish, so Pub stays the point of publish. `--generated-by <model>` (and `--source <id>@v<n>` for posts of yours it drew on) publishes the post disclosed as machine-generated: `generated` in its document and its body wrapped in `blyg-tk-gen` (§5.7). The prompt is never sent. A published draft's preview stands for the post: `/withdraw`, `/republish` and pinning work on it.
- **Sub** — `/subscribe <url>` follows a blyg (a blyg URL, its site's homepage, or its feed all work), `/unsubscribe <url>`, `/subscriptions`. Followed blygs are polled every 15 minutes: new items are posted here, new versions edit the posted message, withdrawals blank it. A blyg that rewrites its history, edits without a new version, or serves a bad `content_hash` gets a ⚠ notice; one without an archive index is followed through its feed. A plain RSS or Atom feed can be followed too: its posts show as title, summary and link, marked RSS. Once a post is over an hour old, a new version or withdrawal also gets a reply under it so it shows up at the bottom; more versions within the hour edit that reply.
- **More Sub topics** — each is a grouping that follows its own blygs. `/newsub <name>` creates one (the bot needs the "manage topics" admin right); `/sub <name>` in any other topic adopts it, or renames a grouping. `/subscriptions` in the first Sub topic lists every grouping. A blyg followed in several groupings is fetched once per poll; deleting a topic drops its grouping.
- **Admin** — status, AI chat. (Planned.)

Only `OWNER_USER_ID` acts, and only in these topics.

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
3. Cloudflare: `bunx wrangler login` (or put `CLOUDFLARE_API_TOKEN=...` in `.cloudflare.env` and `set -a; . ./.cloudflare.env`), `bunx wrangler d1 create blyxt` (copy `database_id` into `wrangler.jsonc`), `bun run db:migrate:remote`, `bunx wrangler secret put TELEGRAM_BOT_TOKEN`, `bunx wrangler secret put TELEGRAM_WEBHOOK_SECRET`, optionally `bunx wrangler secret put DRAFT_TOKEN` for drafts, `bun run deploy`.
4. Webhook: `bun run set-webhook https://blyxt.<account>.workers.dev`.
5. motherbase `vercel.json`: rewrite `/blyg/:path*` → `https://blyxt.<account>.workers.dev/:path*`.

Published items are permanent by protocol: never delete rows from `items` or `versions`.
