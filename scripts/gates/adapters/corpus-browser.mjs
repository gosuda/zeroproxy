import { canonicalDigest, invariant } from "../common.mjs";
import { browserEvidenceLaunchOptions, startBrowserEvidence } from "./browser-evidence.mjs";

function validateProbeList(probes, label) {
  invariant(Array.isArray(probes) && probes.length > 0, `${label} must enumerate probes`, "evidence_prerequisite_missing");
  const ids = new Set();
  for (const probe of probes) {
    invariant(probe && typeof probe.id === "string" && probe.id.length > 0 && !ids.has(probe.id), `${label} probe ids must be unique`, "evidence_prerequisite_missing");
    ids.add(probe.id);
    invariant(typeof probe.expression === "string" && probe.expression.length > 0, `${label} probe ${probe.id} requires a JavaScript expression`, "evidence_prerequisite_missing");
  }
}

function validateManifest(manifest) {
  invariant(manifest && Array.isArray(manifest.sites), "corpus browser adapter requires a corpus manifest", "evidence_prerequisite_missing");
  for (const site of manifest.sites) {
    if (site.kind === "live-canary") {
      invariant(typeof site.native_url === "string" && /^https?:\/\//.test(site.native_url), `corpus site ${site.id} requires native_url`, "evidence_prerequisite_missing");
      invariant(typeof site.mediated_url === "string" && /^https?:\/\//.test(site.mediated_url), `corpus site ${site.id} requires mediated_url`, "evidence_prerequisite_missing");
    } else {
      invariant(site.native_url === null && site.mediated_url === null && typeof site.mediated_url_template === "string", `offline corpus site ${site.id} requires gate-owned execution URLs`, "evidence_prerequisite_missing");
    }
    validateProbeList(site.actions, `corpus site ${site.id} actions`);
    validateProbeList(site.compatibility_probes, `corpus site ${site.id} compatibility_probes`);
    validateProbeList(site.stealth_probes, `corpus site ${site.id} stealth_probes`);
  }
}

async function evaluateProbe(browser, page, probe) {
  const source = `(async () => JSON.stringify(await (async () => (${probe.expression}))()))()`;
  const raw = await browser.evaluate(page, source);
  invariant(typeof raw === "string", `corpus probe ${probe.id} did not produce JSON`, "measurement_unavailable");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`corpus probe ${probe.id} returned invalid JSON: ${error.message}`);
  }
}
async function evaluateCompatibilityProbe(browser, page, probe) {
  const deadline = Date.now() + 10_000;
  let value;
  do {
    value = await evaluateProbe(browser, page, probe);
    if (value === true) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return value;
}

export async function evaluateCorpusPage(browser, page, site) {
  const compatibility = [];
  for (const probe of site.compatibility_probes)
    compatibility.push({ id: probe.id, value: await evaluateCompatibilityProbe(browser, page, probe) });
  const actions = [];
  for (const action of site.actions)
    actions.push({ id: action.id, value: await evaluateProbe(browser, page, action) });
  const signals = [];
  for (const probe of site.stealth_probes)
    signals.push({ id: probe.id, signature: canonicalDigest({ id: probe.id, value: await evaluateProbe(browser, page, probe) }) });
  const actionFailures = actions.filter(action => action.value !== true).map(action => action.id).sort();
  const failures = compatibility.filter(probe => probe.value !== true).map(probe => probe.id).sort();
  return {
    actions: { passed: actionFailures.length === 0, executed: actions.map(action => action.id).sort(), failures: actionFailures },
    compatibility: { passed: failures.length === 0, failures },
    deterministic_signals: signals,
  };
}

/**
 * Production adapter selected with --adapter scripts/gates/adapters/corpus-browser.mjs.
 * It loads each native and mediated site URL in Chromium and evaluates only the explicit,
 * versioned manifest probes. Probe values are observed in-browser, then canonical-hashed;
 * a missing browser, build proof, URL, or probe value fails instead of manufacturing data.
 */
export async function createCorpusEvidenceAdapter(context) {
  validateManifest(context.manifest);
  const browser = await startBrowserEvidence(browserEvidenceLaunchOptions(context));
  return {
    async describe() {
      return {
        browser: browser.browser,
        toolchain: {
          kind: "chromium-cdp-browser-corpus-v1",
          browser_product: browser.browserVersion.product,
          build_proof: browser.buildProof,
        },
      };
    },
    async evaluateSite({ site, mode }) {
      const url = mode === "native" ? site.native_url : site.mediated_url;
      invariant(typeof url === "string", `corpus site ${site.id} lacks ${mode} URL`, "evidence_prerequisite_missing");
      const page = await browser.createPage();
      try {
        await browser.navigate(page, url);
        return await evaluateCorpusPage(browser, page, site);
      } finally {
        await browser.closePage(page);
      }
    },
    async close() {
      await browser.close();
    },
  };
}

export { validateManifest as validateCorpusBrowserManifest };
