import assert from "node:assert/strict";
import test from "node:test";

import {
  anchorPingPolicy,
  anchorPingRequestMetadata,
  attachmentDisposition,
  formContentTypeMatches,
  nextSealedOperationRecord,
  normalizeBeaconBody,
  normalizeDownloadFilename,
  normalizeFormEnctype,
  normalizeFormMethod,
  normalizePingBody,
  preserveAttachmentDisposition,
  serializeRequestOrigin,
} from "../../web/sw/network-plan-contract.mjs";

function securityError(action) {
  assert.throws(action, error => error instanceof DOMException && error.name === "SecurityError");
}

test("form plans allow only controlled GET and POST encodings", () => {
  assert.equal(normalizeFormMethod("get"), "GET");
  assert.equal(normalizeFormMethod("POST"), "POST");
  securityError(() => normalizeFormMethod("PUT"));
  securityError(() => normalizeFormMethod("DIALOG"));

  assert.equal(normalizeFormEnctype("application/x-www-form-urlencoded"), "application/x-www-form-urlencoded");
  assert.equal(normalizeFormEnctype("MULTIPART/FORM-DATA"), "multipart/form-data");
  assert.equal(normalizeFormEnctype("text/plain"), "text/plain");
  securityError(() => normalizeFormEnctype("application/json"));

  assert.equal(formContentTypeMatches("application/x-www-form-urlencoded", "application/x-www-form-urlencoded;charset=UTF-8"), true);
  assert.equal(formContentTypeMatches("multipart/form-data", "multipart/form-data; boundary=----zp"), true);
  assert.equal(formContentTypeMatches("text/plain", "text/plain; charset=utf-8"), true);
  assert.equal(formContentTypeMatches("multipart/form-data", "multipart/form-data"), false);
  assert.equal(formContentTypeMatches("text/plain", "text/plain\r\nCookie: escape"), false);
});

test("beacon bodies are bounded, cloned, and content-type safe", () => {
  const original = new Uint8Array([1, 2, 3]);
  const normalized = normalizeBeaconBody(original, "text/plain;charset=UTF-8");
  original[0] = 9;
  assert.deepEqual([...normalized.body], [1, 2, 3]);
  assert.equal(normalized.contentType, "text/plain;charset=UTF-8");
  assert.equal(normalizeBeaconBody(new Uint8Array(), "").contentType, "");
  securityError(() => normalizeBeaconBody(new Uint8Array((64 << 10) + 1), "text/plain"));
  securityError(() => normalizeBeaconBody(new Uint8Array(), "text/plain\r\nCookie: escape"));
});

test("download disposition is forced to a safe attachment filename", () => {
  assert.equal(normalizeDownloadFilename(undefined, "https://target.test/files/report.pdf"), "report.pdf");
  assert.equal(attachmentDisposition("résumé.pdf"), "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
  assert.equal(preserveAttachmentDisposition("attachment; filename=target.pdf", "fallback.pdf"), "attachment; filename=target.pdf");
  assert.equal(preserveAttachmentDisposition("inline; filename=target.pdf", "fallback.pdf"), "attachment; filename*=UTF-8''fallback.pdf");
  securityError(() => normalizeDownloadFilename("../escape", "https://target.test/file"));
  securityError(() => normalizeDownloadFilename("line\r\nbreak", "https://target.test/file"));
});

test("anchor ping has a bounded exact controlled request shape", () => {
  assert.deepEqual(anchorPingPolicy, { enabled: true, max_targets: 16, content_type: "text/ping", body: "PING" });
  assert.deepEqual([...normalizePingBody(new TextEncoder().encode("PING"), "text/ping")], [80, 73, 78, 71]);
  securityError(() => normalizePingBody(new TextEncoder().encode("PONG"), "text/ping"));
  securityError(() => normalizePingBody(new TextEncoder().encode("PING"), "text/plain"));
});

test("ping metadata reconstructs authenticated target headers without a Referer", () => {
  const sameOrigin = anchorPingRequestMetadata(
    "https://source.test/document",
    "https://source.test/audit",
    "https://destination.test/next#section",
    "strict-origin-when-cross-origin",
  );
  assert.deepEqual(sameOrigin, {
    headers: [
      ["Accept", "*/*"],
      ["Content-Type", "text/ping"],
      ["Ping-To", "https://destination.test/next#section"],
      ["Ping-From", "https://source.test/document"],
    ],
    corsOrigin: "",
    referrerPolicy: "strict-origin-when-cross-origin",
    referrerSource: "",
    referrer: "",
  });
  const secureCrossOrigin = anchorPingRequestMetadata(
    "https://source.test/document",
    "https://audit.test/ping",
    "https://destination.test/",
    "same-origin",
  );
  assert.equal(secureCrossOrigin.headers.some(([name]) => name === "Ping-From"), false);
  assert.equal(secureCrossOrigin.corsOrigin, "");
  const insecureCrossOrigin = anchorPingRequestMetadata(
    "http://source.test/document",
    "https://audit.test/ping",
    "https://destination.test/",
    "strict-origin",
  );
  assert.deepEqual(insecureCrossOrigin.headers.at(-1), ["Ping-From", "http://source.test/document"]);
  assert.equal(serializeRequestOrigin("https://source.test/", "http://target.test/", "strict-origin"), "null");
  assert.equal(serializeRequestOrigin("https://source.test/", "http://target.test/", "origin"), "https://source.test");
  assert.equal(serializeRequestOrigin("https://source.test/", "https://target.test/", "no-referrer"), "null");
  assert.equal(serializeRequestOrigin("https://source.test/", "https://target.test/", "unsafe-url", "GET"), "");
  securityError(() => anchorPingRequestMetadata("data:text/plain,x", "https://audit.test/", "https://destination.test/", ""));
});

test("sealed operation records are client-bound, bounded, and replay-proof across route kinds", () => {
  const binding = {
    source_client_id: "client",
    document_id: "document",
    profile_id: "profile",
    origin_id: "origin",
    capability_epoch: 7,
  };
  const first = nextSealedOperationRecord(null, binding, "a".repeat(48));
  assert.deepEqual(first.operations, ["a".repeat(48)]);
  const second = nextSealedOperationRecord(first, binding, "b".repeat(48));
  assert.deepEqual(second.operations, ["a".repeat(48), "b".repeat(48)]);
  securityError(() => nextSealedOperationRecord(first, binding, "a".repeat(48)));
  securityError(() => nextSealedOperationRecord(first, { ...binding, document_id: "other" }, "b".repeat(48)));
});
