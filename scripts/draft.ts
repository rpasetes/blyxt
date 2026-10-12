// Sends a markdown file to Pub as a draft; it publishes only when you reply /publish to it there.
//   bun run draft <file.md> [--generated-by <model>] [--source <id>@v<n> ...]
// --generated-by marks the whole body machine-generated (§5.7); --source names a post of this blyg it drew on.
// Needs DRAFT_TOKEN (e.g. in .dev.vars); BLYXT_URL defaults to the deployed Worker.
import { parseArgs } from "node:util";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { "generated-by": { type: "string" }, source: { type: "string", multiple: true } },
});
const [file] = positionals;
const token = process.env.DRAFT_TOKEN;
const base = process.env.BLYXT_URL ?? "https://blyxt.blyxt.workers.dev";
if (!file || !token) throw new Error("usage: bun run draft <file.md> [--generated-by <model>] [--source <id>@v<n> ...]  (needs DRAFT_TOKEN)");
if (values.source?.length && !values["generated-by"]) throw new Error("--source describes a generated draft; add --generated-by <model>");

const sources = (values.source ?? []).map((s) => {
  const m = s.match(/^([0-9a-z]{26})@v([1-9]\d*)$/);
  if (!m) throw new Error(`--source ${s}: expected <id>@v<n>`);
  return { id: m[1], version: Number(m[2]) };
});
const generated = values["generated-by"] ? { model: values["generated-by"], sources } : undefined;

const res = await fetch(new URL("/api/drafts", base), {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ content_md: await Bun.file(file).text(), generated }),
});
const out = (await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }))) as { id?: string; kind?: string; error?: string };
if (!res.ok) throw new Error(`draft not sent: ${out.error}`);
console.log(`draft ${out.id} (${out.kind}) is in Pub; reply /publish to it there, or /discard`);
