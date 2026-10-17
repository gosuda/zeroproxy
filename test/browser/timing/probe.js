// Aggregate Resource Timing entries by origin.
// Routing all subresources through a single proxy origin zeroes out target-host DNS and connection timings.
(function () {
  var out = { entries: 0, byOrigin: {}, nav: null, clock: {} };
  try {
    var es = performance.getEntriesByType('resource');
    out.entries = es.length;
    for (var i = 0; i < es.length; i++) {
      var e = es[i];
      var origin;
      try { origin = new URL(e.name).origin; } catch (err) { origin = '(unparsable)'; }
      var b = out.byOrigin[origin] || (out.byOrigin[origin] = {
        n: 0, dnsNonZero: 0, connectNonZero: 0, tlsNonZero: 0,
        workerStartNonZero: 0, transferZero: 0, encodedZero: 0, protos: {},
      });
      b.n++;
      if (e.domainLookupEnd - e.domainLookupStart > 0) b.dnsNonZero++;
      if (e.connectEnd - e.connectStart > 0) b.connectNonZero++;
      if (e.secureConnectionStart > 0) b.tlsNonZero++;
      if (e.workerStart > 0) b.workerStartNonZero++;
      if (!e.transferSize) b.transferZero++;
      if (!e.encodedBodySize) b.encodedZero++;
      var p = e.nextHopProtocol === undefined ? '(undef)' : (e.nextHopProtocol || '(empty)');
      b.protos[p] = (b.protos[p] || 0) + 1;
    }
    var n = performance.getEntriesByType('navigation')[0];
    if (n) out.nav = {
      proto: n.nextHopProtocol || '(empty)',
      dns: Math.round(n.domainLookupEnd - n.domainLookupStart),
      connect: Math.round(n.connectEnd - n.connectStart),
      tls: n.secureConnectionStart > 0 ? 1 : 0,
      transferSize: n.transferSize, encodedBodySize: n.encodedBodySize,
      workerStart: Math.round(n.workerStart || 0),
      deliveryType: n.deliveryType === undefined ? '(undef)' : (n.deliveryType || '(empty)'),
    };
    // Measure clock skew between performance.timeOrigin + performance.now() and Date.now().
    out.clock = {
      skewMs: Math.round(performance.timeOrigin + performance.now() - Date.now()),
      originVsNavStart: performance.timing
        ? Math.round(performance.timeOrigin - performance.timing.navigationStart) : null,
      ownNames: Object.getOwnPropertyNames(performance).length,
    };
  } catch (e) { out.err = String(e && (e.message || e)); }
  return JSON.stringify(out);
})()
