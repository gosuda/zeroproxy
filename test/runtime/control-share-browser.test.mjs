import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";

const root = path.resolve(import.meta.dirname, "../..");
const dist = path.join(root, "dist/web");
const relayHexDigest = "e466728411805ea3c97c9ba046b0d88d6e0477c0683078c441854bce65801e24";
const relayDigest = Buffer.from(relayHexDigest, "hex").toString("base64url");
const relayProfile = JSON.parse(await readFile(path.join(root, `protocol/relay-profiles/${relayHexDigest}.json`), "utf8"));
const relaySignatures = JSON.parse(await readFile(path.join(root, `protocol/relay-profiles/${relayHexDigest}.sig`), "utf8"));
const releaseSigningKeys = JSON.parse(await readFile(path.join(root, "protocol/release-signing-keys.json"), "utf8"));
const addressPolicy = JSON.parse(await readFile(path.join(root, "protocol/address-policy.json"), "utf8"));
const addressPolicySignatures = JSON.parse(await readFile(path.join(root, "protocol/address-policy.sig"), "utf8"));

function chromiumPath() {
  return [
    process.env.CHROME_BIN,
    path.join(root, ".puppeteer-cache/chrome/mac_arm-150.0.7871.124/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].find(candidate => candidate && existsSync(candidate));
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html;charset=utf-8";
  if (file.endsWith(".mjs") || file.endsWith(".js")) return "text/javascript;charset=utf-8";
  if (file.endsWith(".json")) return "application/json;charset=utf-8";
  if (file.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

test("control UI requires installed relay selection and explicit visibility approval", { timeout: 30_000 }, async (t) => {
  const executablePath = chromiumPath();
  assert.ok(executablePath, "pinned Chromium is required");
  let capabilityRequests = 0;
  const server = http.createServer((request, response) => void (async () => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      response.writeHead(200, {
        "Content-Type": "text/html;charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      }).end(await readFile(path.join(dist, "control/index.html")));
      return;
    }
    if (url.pathname === "/control/config.json") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({
        browse_domain: "example.test",
        development_mode: true,
        installed_relay_profile_digests: [relayDigest],
        release_signing_keys: releaseSigningKeys,
        address_policy: addressPolicy,
        address_policy_signatures: addressPolicySignatures,
        relay_profiles: [{ digest: relayDigest, profile: relayProfile, signatures: relaySignatures }],
      }));
      return;
    }
    if (url.pathname === "/control/capability") {
      capabilityRequests += 1;
      response.writeHead(500).end("capability must not be requested before approval");
      return;
    }
    const file = path.resolve(dist, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(`${dist}${path.sep}`)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-store" }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  })());
  const port = await listen(server);
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
  t.after(async () => {
    await browser.close();
    await close(server);
  });

  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
  await page.waitForSelector(`#relay-profile option[value="${relayDigest}"]`);
  await page.type("#target", "https://example.test/private");
  await page.select("#relay-profile", relayDigest);
  await page.click('button[type="submit"]');
  await page.waitForSelector("#relay-approval[open]");

  const observed = await page.evaluate(() => ({
    disclosure: document.querySelector("#relay-approval p").textContent,
    digest: document.querySelector("#approval-digest").textContent,
    status: document.querySelector("#status").value,
  }));
  assert.match(observed.disclosure, /client IP.*destination metadata.*timing and volume.*plaintext HTTP/);
  assert.equal(observed.digest, relayDigest);
  assert.equal(observed.status, "Waiting for relay approval…");
  assert.equal(capabilityRequests, 0, "no anonymous capability is chosen before explicit approval");

  await page.click('#relay-approval button[value="cancel"]');
  await page.waitForFunction(() => document.querySelector("#status").value === "Blocked: AbortError");
  assert.equal(capabilityRequests, 0);

  const nullRelayState = await page.evaluate(async () => {
    const app = await import("/control/app.mjs");
    app.applySharedRecord({
      target_url: "https://shared.example/private",
      requested_profile_mode: "persistent",
      relay_profile_digest: null,
    });
    document.querySelector("#status").value = "";
    return {
      formHidden: document.querySelector("#open-form").hidden,
      target: document.querySelector("#target").value,
      mode: document.querySelector("#profile-mode").value,
      relay: document.querySelector("#relay-profile").value,
    };
  });
  assert.deepEqual(nullRelayState, {
    formHidden: false,
    target: "https://shared.example/private",
    mode: "persistent",
    relay: "",
  });
  await page.click('button[type="submit"]');
  assert.equal(await page.$("#relay-approval[open]"), null, "null relay cannot open without selection");
  assert.equal(capabilityRequests, 0);

  await page.select("#relay-profile", relayDigest);
  await page.click('button[type="submit"]');
  await page.waitForSelector("#relay-approval[open]");
  assert.equal(capabilityRequests, 0, "selecting a relay still requires dialog approval");
  await page.click('#relay-approval button[value="cancel"]');

  await page.evaluate(() => {
    Date.now = () => Date.parse("2027-01-01T00:00:00Z");
  });
  await page.click("#create-share");
  await page.waitForFunction(() => document.querySelector("#status").value === "Blocked: SecurityError");
  assert.equal(await page.$("#share-output a"), null, "expired installed profiles cannot be shared");
});
