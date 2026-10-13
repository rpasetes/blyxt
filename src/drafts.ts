// Drafts from other clients: POST /api/drafts puts a draft in Pub, and only the owner's /publish there
// makes it an item. Telegram stays the point of publish; a leaked token can only propose.
import { directives, FRAGMENT_CAP, ID_RE, newId, now, overCap, pagePath, type Generated, type Item, type Site } from "./blyg";
import { compose } from "./compose";
import { getItem } from "./store";
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
  // a revision draft: the post it revises, the version it was written against, and its changelog note
  item_id: string | null;
  base_version: number | null;
  note: string | null;
  note_generated: number;
};

const MAX_DRAFT = 100_000;
const PREVIEW = 3000;
const MAX_NOTE = 500;

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

  const body = (await req.json().catch(() => null)) as { content_md?: unknown; generated?: unknown; update?: unknown; note?: unknown; note_generated?: unknown } | null;
  const md = typeof body?.content_md === "string" ? body.content_md.trim() : "";
  if (!md) return fail(400, "content_md is required");
  if ([...md].length > MAX_DRAFT) return fail(400, `drafts stay within ${MAX_DRAFT.toLocaleString("en")} characters`);
  const note = typeof body!.note === "string" && body!.note.trim() ? body!.note.trim() : null;
  if (note && [...note].length > MAX_NOTE) return fail(400, `notes stay within ${MAX_NOTE} characters`);

  let generated: Generated | undefined;
  if (body!.generated !== undefined) {
    const g = await provenance(db, body!.generated);
    if (typeof g === "string") return fail(400, g);
    generated = g;
    // blyxt marks the whole body as generated; a quote in it would be marked too, and it isn't generated
    if (directives(md).length) return fail(400, "a generated draft can't quote yet: blyxt marks the whole body as generated");
  }

  // a revision draft names the post it revises, by id or page link; it keeps that post's kind
  let item: Item | null = null;
  if (body!.update !== undefined) {
    const id = typeof body!.update === "string" ? body!.update.match(/([0-9a-z]{26})\/?$/)?.[1] : undefined;
    item = id && ID_RE.test(id) ? await getItem(db, id) : null;
    if (!item) return fail(404, "update names no post on this blyg");
    if (item.kind === "withdrawn") return fail(409, "that post is withdrawn: /republish it in Pub first");
    if (item.content_md === md) return fail(400, "the revision doesn't change the post");
    if (item.authored_kind === "fragment" && overCap(md)) return fail(400, `fragments stay within ${FRAGMENT_CAP.toLocaleString("en")} characters`);
  } else if (note) return fail(400, "a note describes a revision; a new post has none");

  const composed = await compose(db, site.origin, md, item?.id);
  if (!composed.ok) return fail(422, composed.error);
  if (composed.thread && item?.authored_kind === "fragment") return fail(400, "a fragment can't quote");
  const kind = item ? item.authored_kind : composed.thread || overCap(md) ? "thread" : "fragment";

  const draft: Draft = {
    id: newId(), content_md: md, generated: generated ? JSON.stringify([generated]) : null, created: now(), chat_id: cfg.chatId, message_id: null, file_message_id: null,
    item_id: item?.id ?? null, base_version: item?.version ?? null, note, note_generated: note && body!.note_generated === true ? 1 : 0,
  };
  await db.prepare("INSERT INTO drafts (id, content_md, generated, created, chat_id, item_id, base_version, note, note_generated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(draft.id, draft.content_md, draft.generated, draft.created, draft.chat_id, draft.item_id, draft.base_version, draft.note, draft.note_generated).run();

  const chars = [...md].length;
  const head = item
    ? [
        `📝 <b>revision draft</b> · v${item.version} → v${item.version + 1} of ${esc(site.origin + pagePath(item))}`,
        note ? `note${draft.note_generated ? " (written by the client)" : ""}: <i>${esc(note)}</i>` : "no note",
        `changes: ${changes(item.content_md, md)}`,
      ]
    : [`📝 <b>draft</b> · ${kind}${kind === "thread" && chars > FRAGMENT_CAP ? ` (over ${FRAGMENT_CAP.toLocaleString("en")} characters)` : ""} · ${chars.toLocaleString("en")} characters`];
  if (generated) head.push(`generated${generated.model ? ` by ${esc(generated.model)}` : ""}: it publishes marked as machine-generated`);
  // a revision's preview replies to the post's latest message in Pub, so a post's drafts chain under it
  const under = item && (await db.prepare("SELECT message_id FROM tg_messages WHERE item_id = ? AND chat_id = ? ORDER BY message_id DESC LIMIT 1").bind(item.id, cfg.chatId).first<{ message_id: number }>());

  const preview = await previewDraft(cfg, site, md, composed.html, head.join("\n"), under?.message_id);
  if (!preview) {
    await deleteDraft(db, draft.id);
    return fail(502, "couldn't post the draft to Pub");
  }
  await db.prepare("UPDATE drafts SET message_id = ?, file_message_id = ? WHERE id = ?").bind(preview.messageId, preview.fileMessageId, draft.id).run();
  return Response.json({ id: draft.id, kind, message_id: preview.messageId, ...(item ? { update: item.id, version: item.version + 1 } : {}) }, { status: 201 });
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// what a revision changes, for the owner's eyes in Pub only: sections by heading, and length.
// (never published: a changelog note must not reproduce withheld text, §5.2)
export function changes(before: string, after: string) {
  const sections = (md: string) => {
    const out = new Map<string, string>();
    let name = "(opening)";
    for (const line of md.split("\n")) {
      const h = line.match(/^#{1,6}\s+(.*)$/);
      if (h) { name = h[1].trim(); out.set(name, out.get(name) ?? ""); continue; }
      out.set(name, (out.get(name) ?? "") + line.trim() + "\n");
    }
    for (const [k, v] of out) out.set(k, v.trim());
    return out;
  };
  const a = sections(before), b = sections(after);
  const changed = [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k));
  const added = [...b.keys()].filter((k) => !a.has(k));
  const removed = [...a.keys()].filter((k) => !b.has(k));
  const delta = [...after].length - [...before].length;
  const parts = [
    ...(changed.length ? [`edited ${changed.map(esc).join(", ")}`] : []),
    ...(added.length ? [`added ${added.map(esc).join(", ")}`] : []),
    ...(removed.length ? [`removed ${removed.map(esc).join(", ")}`] : []),
  ];
  return `${parts.join("; ") || "wording only"} (${delta >= 0 ? "+" : "−"}${Math.abs(delta).toLocaleString("en")} characters)`;
}

// the draft as it would read, in Pub; a preview cut short comes with the whole markdown as a file
async function previewDraft(cfg: Config, site: Site, md: string, html: string, head: string, replyTo?: number) {
  const body = toTelegramHtml(html, site.origin, PREVIEW);
  const cut = body !== toTelegramHtml(html, site.origin, Infinity);
  const text = `${head}\n\n${body}\n\n<i>reply /publish to publish it, or /discard to drop it${cut ? ". the preview is cut short; the whole draft is attached" : ""}</i>`;
  const sent = await tg(cfg.token, "sendMessage", {
    chat_id: cfg.chatId,
    message_thread_id: cfg.pubTopicId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
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
