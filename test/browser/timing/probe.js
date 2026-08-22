// 타이밍 축 프로브 — Resource Timing 의 "모양" 을 요약한다.
//
// 이름은 이미 디프록시했지만 **타이밍 필드는 손대지 않았다**. 프록시는 모든
// 서브리소스를 한 오리진으로 모으므로, 브라우저가 타깃 호스트로 DNS/연결을
// 하는 일이 없다 — 그 부재는 이름보다 지우기 어려운 신호다.
//
// 판정하지 않고 **요약만** 낸다. 판정은 대조군과의 차이로 러너가 한다.
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
    // 시계 일관성 — 프록시가 timeOrigin 을 가상화하면 여기서 어긋난다.
    out.clock = {
      skewMs: Math.round(performance.timeOrigin + performance.now() - Date.now()),
      originVsNavStart: performance.timing
        ? Math.round(performance.timeOrigin - performance.timing.navigationStart) : null,
      ownNames: Object.getOwnPropertyNames(performance).length,
    };
  } catch (e) { out.err = String(e && (e.message || e)); }
  return JSON.stringify(out);
})()
