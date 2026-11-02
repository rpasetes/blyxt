// Order a live blyg's history with src/pace.ts and compare it with that blyg's own pace-layered home page:
// a by-hand conformance check (it fetches a third-party origin, so it isn't a test).
// bun scripts/pace-check.ts [origin]   (default https://venkateshrao.com/blyg/)
import { paceLayered, type PaceItem } from "../src/pace";
import { USER_AGENT } from "../src/resolve";

const origin = process.argv[2] ?? "https://venkateshrao.com/blyg/";
const get = async (url: string) => {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res;
};
const json = async <T>(path: string) => (await (await get(new URL(path, origin).href)).json()) as T;

type Entry = { version: number; at: string; pinned?: boolean };
const index = await json<{ items: { id: string; kind: string; created: string }[] }>("items/index.json");
// oldest first, as the reference reads the archive
const listed = [...index.items].sort((a, b) => a.created.localeCompare(b.created));
const items: PaceItem[] = [];
for (const it of listed) {
  const doc = await json<{ kind: string; changelog: (Entry & { kind?: string })[] }>(`items/${it.id}.json`);
  const versions = [];
  for (const e of doc.changelog.filter((e) => e.kind !== "withdrawn")) {
    let quotes: string[] = [];
    if (e.pinned) {
      const pin = await json<{ transclusions?: { id: string; origin?: string }[] }>(`items/${it.id}/v${e.version}.json`);
      quotes = (pin.transclusions ?? []).filter((t) => !t.origin).map((t) => t.id);
    }
    versions.push({ at: e.at, pinned: !!e.pinned, quotes });
  }
  items.push({ id: it.id, withdrawn: doc.kind === "withdrawn", versions });
}

const ours = paceLayered(items).map((r) => r.id);
const html = await (await get(origin)).text();
const theirs = html.split("<article").slice(1).map((a) => {
  const body = a.split("</article>")[0];
  return body.match(/class="permalink" href="[^"]*\/[ft]\/([0-9a-z]{26})\/"/)?.[1] ?? [...body.matchAll(/href="[^"]*\/blyg\/[ft]\/([0-9a-z]{26})\/"/g)].at(-1)?.[1];
}).filter(Boolean) as string[];

let same = 0;
while (same < theirs.length && ours[same] === theirs[same]) same++;
console.log(`${origin}: ${items.length} items; home page shows ${theirs.length}; the first ${same} agree`);
if (same < theirs.length) {
  console.log(`first difference at #${same + 1}: ours ${ours[same]}, theirs ${theirs[same]}`);
  console.log(`ours   ${ours.slice(same, same + 5).join(" ")}\ntheirs ${theirs.slice(same, same + 5).join(" ")}`);
  process.exitCode = 1;
}
