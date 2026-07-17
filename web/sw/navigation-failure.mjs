import { createLocalDiagnostic } from "../diagnostics.mjs";
const internalPathPattern = /^\/(?!\/)[A-Za-z0-9_./~-]+$/u;

function escapeHTML(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function createNavigationFailureResponse({
  code,
  requestID,
  retryPath,
  scriptPath,
  stage,
  status = 502,
  targetURL = null,
}) {
  if (!internalPathPattern.test(retryPath)
    || !internalPathPattern.test(scriptPath)
    || !Number.isInteger(status)
    || status < 400
    || status > 599) {
    throw new TypeError("Invalid navigation failure response");
  }
  let diagnostic;
  try {
    diagnostic = createLocalDiagnostic({
      code,
      request_id: requestID,
      stage,
      target_url: targetURL,
    });
  } catch {
    throw new TypeError("Invalid navigation failure response");
  }
  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>Navigation failed</title>
<main>
  <h1>Navigation failed</h1>
  <p>ZeroProxy could not safely load this page.</p>
  <dl>
    ${diagnostic.target_hostname === null ? "" : `<dt>Host</dt><dd id="zp-host">${escapeHTML(diagnostic.target_hostname)}</dd>`}
    <dt>Code</dt><dd id="zp-code">${escapeHTML(diagnostic.code)}</dd>
    <dt>Stage</dt><dd id="zp-stage">${escapeHTML(diagnostic.stage)}</dd>
    <dt>Request</dt><dd id="zp-request">${escapeHTML(diagnostic.request_id)}</dd>
  </dl>
  <button id="zp-back" type="button">Back</button>
  <button id="zp-home" type="button">Home</button>
  <button id="zp-retry" type="button" data-path="${escapeHTML(retryPath)}">Retry</button>
</main>
<script type="module" src="${escapeHTML(scriptPath)}"></script>
`;
  return new Response(html, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
      "Content-Type": "text/html;charset=utf-8",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
