import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html", host: "localhost" },
    }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the standalone Verdue product", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Verdue — Verified claim discovery &amp; tracking<\/title>/i);
  assert.match(html, /Find claims you may qualify for/);
  assert.match(html, /Track what happens next/);
  assert.match(html, /Official form/);
  assert.match(html, /Possible match ≠ eligibility decision/);
  assert.match(html, /This service is not a law firm/);
  assert.doesNotMatch(html, />\s*ChatGPT\s*</i);
  assert.doesNotMatch(html, /chat interface|Your site is taking shape/i);
});

test("removes starter assets and keeps coverage claims bounded", async () => {
  const [page, layout, client, cases, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ClaimApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/cases.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.doesNotMatch(page + layout, /codex-preview|Starter Project|SkeletonPreview/);
  assert.match(client, /not a complete live index/i);
  assert.match(client, /scheduled worker not connected/i);
  assert.doesNotMatch(client, /all current (class actions|lawsuits)/i);
  assert.match(cases, /sourceUrl:/);
  await access(new URL("../public/og.png", import.meta.url));
  await access(new URL("../drizzle/0000_smooth_yellow_claw.sql", import.meta.url));
  await access(new URL("../.openai/hosting.json", import.meta.url));
});
