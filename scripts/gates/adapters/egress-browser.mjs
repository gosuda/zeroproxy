import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { invariant } from "../common.mjs";
import { browserEvidenceLaunchOptions, startBrowserEvidence } from "./browser-evidence.mjs";
function validateManifest(manifest) {
  invariant(manifest && manifest.schema_version === 1 && Array.isArray(manifest.scenarios) && manifest.scenarios.length > 0, "egress browser adapter requires a schema_version 1 enumerated scenario manifest", "evidence_prerequisite_missing");
  const ids = new Set();
  for (const scenario of manifest.scenarios) {
    invariant(scenario && typeof scenario.id === "string" && scenario.id.length > 0 && !ids.has(scenario.id), "egress scenario ids must be unique", "evidence_prerequisite_missing");
    ids.add(scenario.id);
    invariant(typeof scenario.url === "string" && /^https?:\/\//.test(scenario.url), `egress scenario ${scenario.id} requires an absolute browser URL`, "evidence_prerequisite_missing");
    invariant(scenario.target && typeof scenario.target.host === "string" && Array.isArray(scenario.target.ports) && scenario.target.ports.length > 0, `egress scenario ${scenario.id} requires an explicit target`, "evidence_prerequisite_missing");
    invariant(Array.isArray(scenario.expected_assertions) && scenario.expected_assertions.length > 0 && new Set(scenario.expected_assertions).size === scenario.expected_assertions.length, `egress scenario ${scenario.id} requires unique expected assertions`, "evidence_prerequisite_missing");
    invariant(Array.isArray(scenario.surfaces) && scenario.surfaces.length > 0 && scenario.surfaces.every(surface => scenario.expected_assertions.includes(`surface:${surface}`)), `egress scenario ${scenario.id} must assert every declared surface`, "evidence_prerequisite_missing");
    invariant(Number.isInteger(scenario.settle_ms) && scenario.settle_ms >= 500 && scenario.settle_ms <= 10_000, `egress scenario ${scenario.id} requires a bounded settle_ms`, "evidence_prerequisite_missing");
  }
  return manifest;
}

function validateScenarioCompletion(value, scenario) {
  const scenarioId = scenario.id;
  invariant(value && typeof value === "object" && !Array.isArray(value), `egress scenario ${scenarioId} did not publish a completion oracle`, "scenario_incomplete");
  invariant(value.schema_version === 1, `egress scenario ${scenarioId} completion schema is unsupported`, "scenario_incomplete");
  invariant(value.scenario_id === scenarioId, `egress scenario ${scenarioId} completion identity mismatched`, "scenario_incomplete");
  invariant(value.status === "completed", `egress scenario ${scenarioId} reported ${String(value.status)}`, "scenario_incomplete");
  invariant(Array.isArray(value.assertions) && value.assertions.length > 0, `egress scenario ${scenarioId} reported no assertions`, "scenario_incomplete");
  const ids = new Set();
  for (const assertion of value.assertions) {
    invariant(assertion && typeof assertion.id === "string" && assertion.id.length > 0 && !ids.has(assertion.id), `egress scenario ${scenarioId} assertion ids must be unique`, "scenario_incomplete");
    ids.add(assertion.id);
    invariant(assertion.pass === true, `egress scenario ${scenarioId} assertion ${assertion.id} failed`, "scenario_incomplete");
  }
  const actual = [...ids].sort();
  const expected = [...scenario.expected_assertions].sort();
  invariant(JSON.stringify(actual) === JSON.stringify(expected), `egress scenario ${scenarioId} assertion coverage mismatched`, "scenario_incomplete");
  return value;
}

async function waitForScenarioCompletion(browser, page, scenario, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await browser.evaluate(page, "globalThis.__zeroproxyEgressScenario ?? null");
    if (value !== null) return validateScenarioCompletion(value, scenario);
    await sleep(50);
  }
  invariant(false, `egress scenario ${scenario.id} completion timed out`, "scenario_incomplete");
}

async function waitForPostCompletionIdle(page, settleMs) {
  await sleep(settleMs);
  const deadline = Date.now() + 5_000;
  let idleSince = null;
  while (Date.now() < deadline) {
    if (page.pending_requests.size === 0) {
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= 250) return;
    } else {
      idleSince = null;
    }
    await sleep(25);
  }
  invariant(false, "egress scenario did not reach browser network idle", "scenario_incomplete");
}


/**
 * Production adapter selected with --adapter scripts/gates/adapters/egress-browser.mjs.
 * It navigates every manifest scenario URL in a launched Chromium instance. The egress
 * runner starts tcpdump before each call, so browser DNS and target-bound packets are
 * measured rather than inferred. Browser/build proof prerequisites are fail-closed.
 */
export async function createEgressEvidenceAdapter(context) {
  validateManifest(context.manifest);
  const browser = await startBrowserEvidence(browserEvidenceLaunchOptions(context));
  return {
    async describe() {
      return {
        browser: browser.browser,
        toolchain: {
          kind: "chromium-cdp-browser-egress-v1",
          browser_product: browser.browserVersion.product,
          build_proof: browser.buildProof,
        },
      };
    },
    async executeScenario({ scenario, target_ips }) {
      invariant(Array.isArray(target_ips) && target_ips.length > 0, `egress scenario ${scenario.id} has no resolved target IPs`, "target_unresolved");
      const page = await browser.createPage();
      try {
        await browser.navigate(page, scenario.url);
        const completion = await waitForScenarioCompletion(browser, page, scenario);
        await waitForPostCompletionIdle(page, scenario.settle_ms);
        const title = await browser.evaluate(page, "document.title");
        return {
          status: "completed",
          details: {
            url: scenario.url,
            assertion_count: completion.assertions.length,
            completion_sha256: createHash("sha256").update(JSON.stringify(completion)).digest("hex"),
            settle_ms: scenario.settle_ms,
            network_idle_ms: 250,
            browser_title_sha256: createHash("sha256").update(String(title)).digest("hex"),
          },
        };
      } finally {
        await browser.closePage(page);
      }
    },
    async close() {
      await browser.close();
    },
  };
}

export { validateManifest as validateEgressBrowserManifest, validateScenarioCompletion };
