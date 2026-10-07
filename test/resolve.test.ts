import { expect, test } from "bun:test";
import { resolve } from "../src/resolve";

type Route = { body: string; status?: number; finalUrl?: string };
const MANIFEST = JSON.stringify({ blyg: "0.3", title: "B", site: "https://b.example/blyg/" });

// a fake network: unknown URLs 404
function net(routes: Record<string, Route>) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const r = routes[url];
    const res = new Response(r?.body ?? "nope", { status: r ? (r.status ?? 200) : 404 });
    Object.defineProperty(res, "url", { value: r?.finalUrl ?? url });
    return res;
  }) as typeof fetch;
  return { impl, calls };
}

test("direct probe on a blyg url", async () => {
  const { impl } = net({ "https://b.example/blyg/blyg.json": { body: MANIFEST } });
  const r = await resolve("https://b.example/blyg", impl);
  expect(r).toMatchObject({ type: "blyg", origin: "https://b.example/blyg/", warnings: [] });
});

test("homepage rel=blyg, scheme optional", async () => {
  const { impl, calls } = net({
    "https://b.example/": { body: `<!DOCTYPE html><html><head><link rel="blyg" href="/blyg/"></head></html>` },
    "https://b.example/blyg/blyg.json": { body: MANIFEST },
  });
  const r = await resolve("b.example", impl);
  expect(r).toMatchObject({ type: "blyg", origin: "https://b.example/blyg/" });
  expect(calls).toEqual(["https://b.example/blyg.json", "https://b.example/", "https://b.example/blyg/blyg.json"]);
});

test("feed upgrade via blyg:manifest", async () => {
  const { impl } = net({
    "https://b.example/blyg/feed.xml": { body: `<?xml version="1.0"?><rss><channel><blyg:manifest>https://b.example/blyg/blyg.json</blyg:manifest></channel></rss>` },
    "https://b.example/blyg/blyg.json": { body: MANIFEST },
  });
  expect(await resolve("https://b.example/blyg/feed.xml", impl)).toMatchObject({ type: "blyg", origin: "https://b.example/blyg/" });
});

test("identity is the post-redirect fetch origin, not the claimed site", async () => {
  const { impl } = net({ "https://old.example/blyg.json": { body: MANIFEST, finalUrl: "https://new.example/blyg.json" } });
  const r = await resolve("https://old.example/", impl);
  expect(r).toMatchObject({ type: "blyg", origin: "https://new.example/" });
  if (r.type === "blyg") expect(r.warnings[0]).toContain("claims site");
});

test("conventional mount fallback", async () => {
  const { impl } = net({ "https://b.example/blyg/blyg.json": { body: MANIFEST } });
  expect(await resolve("https://b.example/about", impl)).toMatchObject({ type: "blyg", origin: "https://b.example/blyg/" });
});

test("plain RSS is legacy, nothing is failure with a trail", async () => {
  const { impl } = net({ "https://r.example/": { body: `<html><head><link rel="alternate" type="application/rss+xml" href="/rss"></head></html>` } });
  expect(await resolve("https://r.example/", impl)).toMatchObject({ type: "legacy", feedUrl: "https://r.example/rss" });
  const empty = await resolve("https://x.example/a/b", net({}).impl);
  expect(empty.type).toBe("failed");
  if (empty.type === "failed") expect(empty.tried.length).toBeLessThanOrEqual(6);
});

test("a JSON body without a blyg key is not a manifest", async () => {
  const { impl } = net({ "https://j.example/blyg.json": { body: `{"name":"x"}` } });
  expect((await resolve("https://j.example/", impl)).type).toBe("failed");
});
