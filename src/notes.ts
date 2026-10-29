// Changelog notes written by a model when the owner gave none (a community norm, not the protocol: "hook up an AI
// for changelog generation at least", vgr). Haiku writes them when ANTHROPIC_API_KEY is set; without it, or when a
// call fails or its note is refused, blyxt asks the owner instead (held edits), so every version still has a note.

export const NOTE_MODEL = "claude-haiku-5-5";
const TIMEOUT_MS = 8000;
const MAX_NOTE = 200;
// what the model sees of a change: the lines removed and added, cut to this much each
const MAX_DIFF = 3000;

const PROMPT =
  "You write the changelog note for a new version of a short blog post. Reply with one plain sentence under 200 " +
  "characters saying what changed, in the past tense, like: \"Fixed a typo in the second paragraph.\" or " +
  "\"Added a paragraph on feed pacing and reworded the opening.\" Describe the change; never quote or repeat the " +
  "removed text. No preamble, no quotation marks, no markdown.";

// the lines that differ, as sets: enough to say what changed, far less to send than both versions
function diff(before: string, after: string) {
  const a = before.split("\n").map((l) => l.trim()).filter(Boolean);
  const b = after.split("\n").map((l) => l.trim()).filter(Boolean);
  const cut = (lines: string[]) => lines.join("\n").slice(0, MAX_DIFF);
  return { removed: cut(a.filter((l) => !b.includes(l))), added: cut(b.filter((l) => !a.includes(l))) };
}

// words, case-folded; an apostrophe inside a word stays (don't), quotes around one don't ('teh' is teh)
const words = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}'’]+/gu) ?? []).map((w) => w.replace(/^['’]+|['’]+$/g, "")).filter(Boolean);

// a changelog note must not reproduce withheld prior text (§5.2), and notes travel far (they title feed entries,
// §7). The text most worth withholding is often one word: a removed name, a misspelling fixed. So a note may not
// use any word (3+ letters, case-folded) that the old version had and the new one doesn't. Checked here, whatever
// the model was told; a refused note is no note, which is the safe side of a MUST
export function reproducesRemoved(note: string, before: string, after: string) {
  const kept = new Set(words(after));
  const removed = new Set(words(before).filter((w) => [...w].length >= 3 && !kept.has(w)));
  return words(note).some((w) => removed.has(w));
}

export async function writeNote(key: string | undefined, before: string, after: string, timeoutMs = TIMEOUT_MS): Promise<string | null> {
  if (!key || before === after) return null;
  const { removed, added } = diff(before, after);
  const change = `${removed ? `Removed lines:\n${removed}\n\n` : ""}${added ? `Added lines:\n${added}` : "Only whitespace or line order changed."}`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: NOTE_MODEL, max_tokens: 100, system: PROMPT, messages: [{ role: "user", content: change }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.error(`note: ${res.status} ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = body.content?.find((c) => c.type === "text")?.text;
    if (typeof text !== "string") return null;
    // one line, no wrapping quotes, and short; a sentence cut mid-way is no note at all
    const note = text.split("\n").map((l) => l.trim()).find(Boolean)?.replace(/^["“'](.*)["”']$/, "$1").trim();
    if (!note || [...note].length > MAX_NOTE) return null;
    return reproducesRemoved(note, before, after) ? null : note;
  } catch (e) {
    console.error(`note: ${e}`);
    return null;
  }
}
