// Drafts from other clients: POST /api/drafts puts a draft in Pub, and only the owner's /publish there
// makes it an item. Telegram stays the point of publish; a leaked token can only propose.
import { directives, FRAGMENT_CAP, ID_RE, newId, now, overCap, type Generated, type Site } from "./blyg";
import { compose } from "./compose";
import { tg, type Config } from "./telegram";
import { toTelegramHtml } from "./tghtml";

export type Draft = {
  id: string;
  content_md: string;
  generated: string | null;
  created: string;
  chat_id: number;
  message_id: number | null;
  file_message_id: number | null;
};

const MAX_DRAFT = 100_000;
const PREVIEW = 3000;

export const draftForMessage = (db: D1Database, chatId: number, messageId: number) =>
  db.prepare("SELECT * FROM drafts WHERE chat_id = ? AND (message_id = ? OR file_message_id = ?)").bind(chatId, messageId, messageId).first<Draft>();

export const deleteDraft = (db: D1Database, id: string) => db.prepare("DELETE FROM drafts WHERE id = ?").bind(id).run();

const fail = (status: number, error: string) => Response.json({ error }, { status });

// compares every byte, so the time taken doesn't say how much of a guess was right
function authorized(req: Request, token: string) {
  const given = new TextEncoder().encode(req.headers.get("authorization") ?? "");
  const expected = new TextEncoder().encode(`Bearer ${token}`);
  let diff = given.byteLength ^ expected.byteLength;
  for (let i = 0; i < expected.byteLength; i++) diff |= (given[i] ?? 0) ^ expected[i];
  return diff === 0;
}

// a draft's provenance keeps only what §5.7 discloses: sources, model, at. Anything else (a prompt,
// instructions) is studio-private and is dropped, never published
async function provenance(db: D1Database, input: unknown): Promise<Generated | string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "generated must be an object: { model?, at?, sources? }";
  const { model, at, sources = [] } = input as Record<string, unknown>;
  if (model !== undefined && (typeof model !== "string" || !model.trim() || model.length > 100)) return "generated.model must be a short string";
  if (at !== undefined && (typeof at !== "string" || Number.isNaN(Date.parse(at)))) return "generated.at must be a timestamp";
  if (!Array.isArray(sources)) return "generated.sources must be an array of { id, version }";
  const named: Generated["sources"] = [];
  for (const s of sources as Record<string, unknown>[]) {
    // own-origin only at 0.3 (§5.7): a source is an exact published version of one of this blyg's posts
    if (typeof s?.id !== "string" || !ID_RE.test(s.id) || !Number.isInteger(s.version)) return "each source is { id, version } of a post on this blyg";
    const v = await db.prepare("SELECT kind FROM versions WHERE item_id = ? AND version = ?").bind(s.id, s.version).first<{ kind: string }>();
    if (!v || v.kind === "withdrawn") return `${s.id} v${s.version} isn't a published version on this blyg`;
    named.push({ id: s.id, version: s.version as number });
  }
  return { sources: named, ...(model ? { model: model.trim() } : {}), at: at ? new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z") : now() };
}

export async function handleDraftRequest(req: Request, db: D1Database, site: Site, cfg: Config, token: string | undefined) {
  if (!token) return new Response("not found\n", { status: 404 });
  if (req.method !== "POST") return new Response("method not allowed\n", { status: 405 });
  if (!authorized(req, token)) return fail(401, "unauthorized");

  const body = (await req.json().catch(() => null)) as { content_md?: unknown; generated?: unknown } | null;
  const md = typeof body?.content_md === "string" ? body.content_md.trim() : "";
  if (!md) return fail(400, "content_md is required");
  if ([...md].length > MAX_DRAFT) return fail(400, `drafts stay within ${MAX_DRAFT.toLocaleString("en")} characters`);

  let generated: Generated | undefined;
  if (body!.generated !== undefined) {
    const g = await provenance(db, body!.generated);
    if (typeof g === "string") return fail(400, g);
    generated = g;
    // blyxt marks the whole body as generated; a quote in it would be marked too, and it isn't generated
    if (directives(md).length) return fail(400, "a generated draft can't quote yet: blyxt marks the whole body as generated");
  }

  const composed = await compose(db, site.origin, md);
  if (!composed.ok) return fail(422, composed.error);
  const kind = composed.thread || overCap(md) ? "thread" : "fragment";

  const draft: Draft = { id: newId(), content_md: md, generated: generated ? JSON.stringify([generated]) : null, created: now(), chat_id: cfg.chatId, message_id: null, file_message_id: null };
  await db.prepare("INSERT INTO drafts (id, content_md, generated, created, chat_id) VALUES (?, ?, ?, ?, ?)")
    .bind(draft.id, draft.content_md, draft.generated, draft.created, draft.chat_id).run();

  const preview = await previewDraft(cfg, site, md, composed.html, kind, generated);
  if (!preview) {
    await deleteDraft(db, draft.id);
    return fail(502, "couldn't post the draft to Pub");
  }
  await db.prepare("UPDATE drafts SET message_id = ?, file_message_id = ? WHERE id = ?").bind(preview.messageId, preview.fileMessageId, draft.id).run();
  return Response.json({ id: draft.id, kind, message_id: preview.messageId }, { status: 201 });
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// the draft as it would read, in Pub; a preview cut short comes with the whole markdown as a file
async function previewDraft(cfg: Config, site: Site, md: string, html: string, kind: string, generated?: Generated) {
  const body = toTelegramHtml(html, site.origin, PREVIEW);
  const cut = body !== toTelegramHtml(html, site.origin, Infinity);
  const chars = [...md].length;
  const head = [
    `📝 <b>draft</b> · ${kind}${kind === "thread" && chars > FRAGMENT_CAP ? ` (over ${FRAGMENT_CAP.toLocaleString("en")} characters)` : ""} · ${chars.toLocaleString("en")} characters`,
    ...(generated ? [`generated${generated.model ? ` by ${esc(generated.model)}` : ""}: it publishes marked as machine-generated`] : []),
  ].join("\n");
  const text = `${head}\n\n${body}\n\n<i>reply /publish to publish it, or /discard to drop it${cut ? ". the preview is cut short; the whole draft is attached" : ""}</i>`;
  const sent = await tg(cfg.token, "sendMessage", {
    chat_id: cfg.chatId,
    message_thread_id: cfg.pubTopicId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
  if (!sent.ok) return null;
  const messageId = (sent.result as { message_id: number }).message_id;
  if (!cut) return { messageId, fileMessageId: null };

  const form = new FormData();
  form.set("chat_id", String(cfg.chatId));
  form.set("message_thread_id", String(cfg.pubTopicId));
  form.set("reply_parameters", JSON.stringify({ message_id: messageId }));
  form.set("document", new Blob([md], { type: "text/markdown" }), "draft.md");
  const res = await fetch(`https://api.telegram.org/bot${cfg.token}/sendDocument`, { method: "POST", body: form });
  const file = (await res.json()) as { ok: boolean; result?: { message_id: number } };
  return { messageId, fileMessageId: file.ok ? file.result!.message_id : null };
}
