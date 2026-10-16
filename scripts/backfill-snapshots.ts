// Reads every followed post once more and keeps its snapshot, so posts imported before snapshots
// existed can be quoted. A reader fetch, like a poll: quoting still bakes only from what's stored.
import { remoteD1 } from "./remote-d1";
import { saveSnapshot } from "../src/subscribe";
import { USER_AGENT } from "../src/resolve";

const { results } = await remoteD1
  .prepare("SELECT DISTINCT i.origin, i.item_id FROM imported i JOIN subscriptions s ON s.origin = i.origin WHERE s.legacy = 0 AND i.item_id NOT IN (SELECT item_id FROM snapshots WHERE origin = i.origin)")
  .all<{ origin: string; item_id: string }>();
console.log(`${results.length} posts without a snapshot`);
for (const { origin, item_id } of results) {
  const res = await fetch(new URL(`items/${item_id}.json`, origin), { headers: { "user-agent": USER_AGENT, accept: "application/json" } });
  if (!res.ok) { console.log(`${item_id}: ${res.status}, skipped`); continue; }
  const doc = (await res.json()) as Parameters<typeof saveSnapshot>[2];
  if (doc.id !== item_id) { console.log(`${item_id}: document names ${doc.id}, skipped`); continue; }
  await saveSnapshot(remoteD1, origin, doc);
  console.log(`${item_id} v${doc.version}`);
}
