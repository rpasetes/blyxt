// The pace-layered home page: the diachronic view, beside the feed's synchronic newest-first. The model is
// Blygger Studio's reference (docs/pace-layered-feed.md, RFC-3), which other clients are asked to implement:
// items sink as new ones arrive, more slowly the more they've been pinned, and climb as they're revised.
// Read only from what the wire carries (changelogs, pins, pinned versions' transclusions), so the same code
// could order a followed blyg too. Only the home page uses it; the feed and the archive index stay newest-first.
// Adapted from blygger-studio src/feeds/pace-layered.ts, MIT License, Copyright (c) 2026 Venkatesh Rao
// (licenses/blygger-studio.txt), so its orderings match the reference's.

// Brand's pace layers, fastest first
export const LAYERS = ["fashion", "commerce", "infrastructure", "governance", "culture", "nature"] as const;
// a pin's weight reaches this many quoters up before it's ignored, halving each hop
const HOPS = 6;

export type PaceVersion = { at: string; pinned: boolean; quotes: string[] };
// oldest first, as the archive lists them (ties in `at` fall to this order); a withdrawal endcap is no version here
export type PaceItem = { id: string; withdrawn: boolean; versions: PaceVersion[] };

export const layerOf = (weight: number) => Math.min(LAYERS.length - 1, Math.floor(weight));
// depth gained per new item: each layer down sinks half as fast as the one above
const sink = (layer: number) => 2 ** -layer;
// how many places a new version climbs: one, until changelog notes can say how much a revision matters
const climb = (_v: PaceVersion) => 1;

// own pins, plus half of what each pinned quoter weighs, recursively: a pinned thread freezes what it quotes,
// which says the quoted item matters (never the other way, which would reward quoting popular things)
function weights(pins: Map<string, number>, quotedBy: Map<string, Set<string>>) {
  let w = new Map(pins);
  for (let hop = 0; hop < HOPS; hop++) {
    const next = new Map(pins);
    for (const [quoted, quoters] of quotedBy) {
      let inherited = 0;
      for (const q of quoters) inherited += w.get(q) ?? 0;
      next.set(quoted, (next.get(quoted) ?? 0) + inherited / 2);
    }
    w = next;
  }
  return w;
}

// the home page's order, top first, with each item's layer; withdrawn items are left out
export function paceLayered(items: PaceItem[]): { id: string; layer: number }[] {
  const shown = new Set(items.filter((i) => !i.withdrawn).map((i) => i.id));
  const rank = new Map(items.map((i, n) => [i.id, n]));
  const events = items
    .flatMap((i) => i.versions.map((v, n) => ({ id: i.id, v, n })))
    .sort((a, b) => a.v.at.localeCompare(b.v.at) || rank.get(a.id)! - rank.get(b.id)! || a.n - b.n);

  const depth = new Map<string, number>();
  // the order items entered (or last climbed into a tie): at equal depth, the later one is on top
  const entered = new Map<string, number>();
  const pins = new Map<string, number>();
  const quotedBy = new Map<string, Set<string>>();
  let layer = new Map<string, number>();
  let clock = 0;
  const order = () => [...depth.keys()].sort((a, b) => depth.get(a)! - depth.get(b)! || entered.get(b)! - entered.get(a)!);

  for (const { id, v } of events) {
    // a pin counts from its version's time (the wire doesn't say when it was made), withdrawn or not:
    // pinned versions are served forever
    if (v.pinned) {
      pins.set(id, (pins.get(id) ?? 0) + 1);
      for (const q of v.quotes) if (q !== id) quotedBy.set(q, (quotedBy.get(q) ?? new Set()).add(id));
      layer = new Map([...weights(pins, quotedBy)].map(([k, w]) => [k, layerOf(w)]));
    }
    if (!shown.has(id)) continue;
    if (!depth.has(id)) {
      // a tick: everything sinks at its layer's speed and the newcomer enters on top
      for (const [other, d] of depth) depth.set(other, d + sink(layer.get(other) ?? 0));
      depth.set(id, 0);
      entered.set(id, clock++);
      continue;
    }
    // a revision trades places with the item above it
    for (let n = climb(v); n > 0; n--) {
      const now = order();
      const at = now.indexOf(id);
      if (at <= 0) break;
      const above = now[at - 1];
      const mine = depth.get(id)!;
      depth.set(id, depth.get(above)!);
      depth.set(above, mine);
      // tied depths: the swap is a no-op, so the climber becomes the later entrant to come out on top
      if (depth.get(id) === mine) entered.set(id, clock++);
    }
  }
  return order().map((id) => ({ id, layer: layer.get(id) ?? 0 }));
}

// blyxt's history in that shape, from D1: every published version but endcaps, oldest item first
export async function paceHistory(db: D1Database): Promise<PaceItem[]> {
  const { results } = await db.prepare(
    `SELECT v.item_id, v.at, v.pinned, v.transclusions, i.kind AS item_kind FROM versions v JOIN items i ON i.id = v.item_id
     WHERE v.kind != 'withdrawn' ORDER BY i.created, i.id, v.version`,
  ).all<{ item_id: string; at: string; pinned: number; transclusions: string | null; item_kind: string }>();
  const items = new Map<string, PaceItem>();
  for (const r of results) {
    const item = items.get(r.item_id) ?? { id: r.item_id, withdrawn: r.item_kind === "withdrawn", versions: [] };
    items.set(r.item_id, item);
    // same-origin quotes only: a transclusion with an origin is someone else's item
    const quotes = (JSON.parse(r.transclusions ?? "[]") as { id: string; origin?: string }[]).filter((t) => !t.origin).map((t) => t.id);
    item.versions.push({ at: r.at, pinned: !!r.pinned, quotes });
  }
  return [...items.values()];
}
