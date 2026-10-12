import { afterEach, expect, test } from "bun:test";
import { parseFeed, syntheticId } from "../src/rss";
import { ID_RE } from "../src/blyg";
import { addLegacySubscription, pollDue } from "../src/subscribe";
import { d1 } from "./d1";

const FEED = "https://blog.example/feed.xml";
const rss = (items: { guid: string; title: string; body: string }[]) => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>A &amp; B blog</title><link>https://blog.example/</link>
${items.map((i) => `<item><guid>${i.guid}</guid><title>${i.title}</title><link>/p/${i.guid}</link><description><![CDATA[<p>${i.body}</p>]]></description></item>`).join("\n")}
</channel></rss>`;

test("RSS and Atom entries parse to summary + link", () => {
  expect(parseFeed(rss([{ guid: "1", title: "Hi &amp; bye", body: "<b>x</b>" }]), FEED)).toEqual({
    title: "A & B blog",
    entries: [{ key: "1", link: "https://blog.example/p/1", title: "Hi & bye", summary: "<p><b>x</b></p>" }],
  });
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title type="text">Atomic</title>
    <entry><id>urn:a</id><title>T</title><link rel="self" href="/self"/><link href="https://a.example/post"/><summary>s &lt;i&gt;i&lt;/i&gt;</summary></entry>
    <entry><title>no id or link</title></entry></feed>`;
  expect(parseFeed(atom, FEED)).toEqual({ title: "Atomic", entries: [{ key: "urn:a", link: "https://a.example/post", title: "T", summary: "s <i>i</i>" }] });
});

test("synthetic ids are never blyg ids", async () => {
  expect(ID_RE.test(await syntheticId("1"))).toBe(false);
  expect(await syntheticId("1")).toBe(await syntheticId("1"));
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("a legacy feed: baseline, new entries, changed entries as edits, departed entries kept", async () => {
  const db = d1();
  let items = [{ guid: "1", title: "one", body: "first" }];
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  let next = 100;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    if (String(input).startsWith("https://api.telegram.org/")) {
      const body = JSON.parse(String(init?.body));
      const method = String(input).split("/").pop()!;
      sent.push({ method, body });
      return Response.json({ ok: true, result: { message_id: method === "sendMessage" ? next++ : body.message_id } });
    }
    return new Response(rss(items));
  }) as typeof fetch;

  const SUB = { token: "t", chatId: -100, topicId: 3 };
  expect(await addLegacySubscription(db, SUB, FEED)).toEqual({ title: "A & B blog", count: 1 });
  expect(String(sent[0].body.text)).toBe('<b>A &amp; B blog</b> · RSS\n\n<b><a href="https://blog.example/p/1">one</a></b>\n\nfirst');

  items = [{ guid: "2", title: "two", body: "second" }, { guid: "1", title: "one", body: "first, fixed" }];
  sent.length = 0;
  db.sqlite.exec("UPDATE subscriptions SET next_poll = '1970-01-01T00:00:00Z'");
  await pollDue(db, { token: "t", chatId: -100 });
  expect(sent.map((s) => s.method)).toEqual(["editMessageText", "sendMessage"]);
  expect(String(sent[0].body.text)).toContain("RSS · updated");

  items = [];
  db.sqlite.exec("UPDATE subscriptions SET next_poll = '1970-01-01T00:00:00Z'");
  await pollDue(db, { token: "t", chatId: -100 });
  expect(db.sqlite.query("SELECT kind, version FROM imported ORDER BY version").all()).toEqual([{ kind: "l0", version: 1 }, { kind: "l0", version: 2 }]);
});
