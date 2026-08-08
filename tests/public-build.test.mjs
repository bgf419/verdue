import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("public build is standalone and points to the normal public URL", async () => {
  const html = await readFile(new URL("../dist-public/index.html", import.meta.url), "utf8");
  assert.match(html, /Verdue/);
  assert.match(html, /https:\/\/bgf419\.github\.io\/verdue\//);
  assert.doesNotMatch(html, /chatgpt\.site|signin-with-chatgpt/i);
});

test("public entry uses browser-local persistence instead of platform auth", async () => {
  const source = await readFile(new URL("../static-site/main.tsx", import.meta.url), "utf8");
  assert.match(source, /storageMode="local"/);
  assert.doesNotMatch(source, /signInPath|ChatGPT/i);
});
