const validSdpTypes = new Set(['offer', 'pranswer', 'answer', 'rollback']);
const validRTCErrorDetails = new Set([
  'data-channel-failure',
  'dtls-failure',
  'fingerprint-failure',
  'hardware-encoder-error',
  'hardware-encoder-not-available',
  'sctp-failure',
  'sdp-syntax-error',
]);
const missingRTCErrorInit = {};

export function createRTCBasicFacades(DOMExceptionBase) {
  const EventTargetBase = typeof globalThis.EventTarget === 'function' ? globalThis.EventTarget : class {};
  const rtcInternalToken = {};

  class RTCIceCandidate {
    constructor(init = {}) {
      const sdpMid = nullableString(init.sdpMid);
      const sdpMLineIndex = nullableNumber(init.sdpMLineIndex);
      if (sdpMid === null && sdpMLineIndex === null) throw new TypeError("Failed to construct 'RTCIceCandidate': sdpMid and sdpMLineIndex are both null.");
      defineHidden(this, '__zpCandidate', String(init.candidate ?? ''));
      defineHidden(this, '__zpSdpMid', sdpMid);
      defineHidden(this, '__zpSdpMLineIndex', sdpMLineIndex);
      defineHidden(this, '__zpUsernameFragment', nullableString(init.usernameFragment));
    }
    get candidate() { return this.__zpCandidate; }
    get sdpMid() { return this.__zpSdpMid; }
    get sdpMLineIndex() { return this.__zpSdpMLineIndex; }
    get foundation() { return null; }
    get component() { return null; }
    get priority() { return null; }
    get address() { return null; }
    get protocol() { return null; }
    get port() { return null; }
    get type() { return null; }
    get tcpType() { return null; }
    get relatedAddress() { return null; }
    get relatedPort() { return null; }
    get usernameFragment() { return this.__zpUsernameFragment; }
    get relayProtocol() { return null; }
    get url() { return null; }
    toJSON() { return { candidate: this.candidate, sdpMid: this.sdpMid, sdpMLineIndex: this.sdpMLineIndex, usernameFragment: this.usernameFragment }; }
  }
  Object.defineProperty(RTCIceCandidate.prototype, Symbol.toStringTag, { value: 'RTCIceCandidate', configurable: true });

  class RTCSessionDescription {
    constructor(init = {}) {
      defineHidden(this, '__zpType', rtcSdpType(init.type));
      defineHidden(this, '__zpSdp', String(init.sdp ?? ''));
    }
    get type() { return this.__zpType; }
    set type(value) { defineHidden(this, '__zpType', rtcSdpType(value)); }
    get sdp() { return this.__zpSdp; }
    set sdp(value) { defineHidden(this, '__zpSdp', String(value ?? '')); }
    toJSON() { return { type: this.type, sdp: this.sdp }; }
  }
  Object.defineProperty(RTCSessionDescription.prototype, Symbol.toStringTag, { value: 'RTCSessionDescription', configurable: true });

  class RTCError extends DOMExceptionBase {
    constructor(init = missingRTCErrorInit, message = '') {
      if (init === missingRTCErrorInit) throw new TypeError("Failed to construct 'RTCError': 1 argument required, but only 0 present.");
      const errorDetail = rtcErrorDetail(init.errorDetail);
      super(String(message), 'OperationError');
      defineHidden(this, '__zpErrorDetail', errorDetail);
      defineHidden(this, '__zpSdpLineNumber', nullableNumber(init.sdpLineNumber));
      defineHidden(this, '__zpHttpRequestStatusCode', nullableNumber(init.httpRequestStatusCode));
      defineHidden(this, '__zpSctpCauseCode', nullableNumber(init.sctpCauseCode));
      defineHidden(this, '__zpReceivedAlert', nullableNumber(init.receivedAlert));
      defineHidden(this, '__zpSentAlert', nullableNumber(init.sentAlert));
    }
    get errorDetail() { return this.__zpErrorDetail; }
    get sdpLineNumber() { return this.__zpSdpLineNumber; }
    get httpRequestStatusCode() { return this.__zpHttpRequestStatusCode; }
    get sctpCauseCode() { return this.__zpSctpCauseCode; }
    get receivedAlert() { return this.__zpReceivedAlert; }
    get sentAlert() { return this.__zpSentAlert; }
  }
  Object.defineProperty(RTCError.prototype, Symbol.toStringTag, { value: 'RTCError', configurable: true });

  class RTCPeerConnection extends EventTargetBase {
    constructor(configuration = {}) {
      super();
      defineHidden(this, '__zpConfiguration', cloneRTCConfiguration(configuration));
      this.localDescription = null;
      this.currentLocalDescription = null;
      this.pendingLocalDescription = null;
      this.remoteDescription = null;
      this.currentRemoteDescription = null;
      this.pendingRemoteDescription = null;
      this.signalingState = 'stable';
      this.iceGatheringState = 'complete';
      this.iceConnectionState = 'new';
      this.connectionState = 'new';
      this.canTrickleIceCandidates = null;
      this.onconnectionstatechange = null;
      this.ondatachannel = null;
      this.onicecandidate = null;
      this.onicecandidateerror = null;
      this.oniceconnectionstatechange = null;
      this.onicegatheringstatechange = null;
      this.onnegotiationneeded = null;
      this.onsignalingstatechange = null;
      this.ontrack = null;
    }
    addIceCandidate() { return rejectRTCPolicy(DOMExceptionBase); }
    addTrack() { throw new DOMExceptionBase('WebRTC is disabled by policy.', 'NotAllowedError'); }
    addTransceiver() { throw new DOMExceptionBase('WebRTC is disabled by policy.', 'NotAllowedError'); }
    close() { this.connectionState = 'closed'; this.iceConnectionState = 'closed'; this.signalingState = 'closed'; }
    createAnswer() { return rejectRTCPolicy(DOMExceptionBase); }
    createDataChannel(label = '', options = {}) { return new RTCDataChannel(rtcInternalToken, label, options); }
    createOffer() { return rejectRTCPolicy(DOMExceptionBase); }
    getConfiguration() { return cloneRTCConfiguration(this.__zpConfiguration); }
    getReceivers() { return []; }
    getSenders() { return []; }
    getStats() { return Promise.resolve(new RTCStatsReport(rtcInternalToken)); }
    getTransceivers() { return []; }
    removeTrack() {}
    restartIce() {}
    setConfiguration(configuration = {}) { defineHidden(this, '__zpConfiguration', cloneRTCConfiguration(configuration)); }
    setLocalDescription() { return rejectRTCPolicy(DOMExceptionBase); }
    setRemoteDescription() { return rejectRTCPolicy(DOMExceptionBase); }
    static generateCertificate() { return rejectRTCPolicy(DOMExceptionBase); }
  }
  Object.defineProperty(RTCPeerConnection.prototype, Symbol.toStringTag, { value: 'RTCPeerConnection', configurable: true });
  Object.defineProperty(RTCPeerConnection, 'name', { value: 'RTCPeerConnection', configurable: true });

  class RTCDataChannel extends EventTargetBase {
    constructor(token, label = '', options = {}) {
      if (token !== rtcInternalToken) throw new TypeError('Illegal constructor');
      super();
      this.label = String(label);
      this.ordered = options.ordered === undefined ? true : Boolean(options.ordered);
      this.maxPacketLifeTime = nullableNumber(options.maxPacketLifeTime);
      this.maxRetransmits = nullableNumber(options.maxRetransmits);
      this.protocol = String(options.protocol || '');
      this.negotiated = Boolean(options.negotiated);
      this.id = options.id === undefined ? null : Number(options.id);
      this.readyState = 'closed';
      this.bufferedAmount = 0;
      this.bufferedAmountLowThreshold = 0;
      this.binaryType = 'blob';
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      this.onbufferedamountlow = null;
    }
    close() { this.readyState = 'closed'; }
    send() { throw new DOMExceptionBase('RTCDataChannel is closed.', 'InvalidStateError'); }
  }
  Object.defineProperty(RTCDataChannel.prototype, Symbol.toStringTag, { value: 'RTCDataChannel', configurable: true });
  Object.defineProperty(RTCDataChannel, 'name', { value: 'RTCDataChannel', configurable: true });

  const RTCDtlsTransport = makeIllegalRTCConstructor('RTCDtlsTransport', rtcInternalToken);
  const RTCIceTransport = makeIllegalRTCConstructor('RTCIceTransport', rtcInternalToken);
  const RTCSctpTransport = makeIllegalRTCConstructor('RTCSctpTransport', rtcInternalToken);
  const RTCDTMFSender = makeIllegalRTCConstructor('RTCDTMFSender', rtcInternalToken);
  const RTCRtpReceiver = makeIllegalRTCConstructor('RTCRtpReceiver', rtcInternalToken);
  const RTCRtpSender = makeIllegalRTCConstructor('RTCRtpSender', rtcInternalToken);
  const RTCRtpTransceiver = makeIllegalRTCConstructor('RTCRtpTransceiver', rtcInternalToken);
  const RTCCertificate = makeIllegalRTCConstructor('RTCCertificate', rtcInternalToken);
  const RTCEncodedAudioFrame = makeIllegalRTCConstructor('RTCEncodedAudioFrame', rtcInternalToken, "Failed to construct 'RTCEncodedAudioFrame': Illegal constructor");
  const RTCEncodedVideoFrame = makeIllegalRTCConstructor('RTCEncodedVideoFrame', rtcInternalToken, "Failed to construct 'RTCEncodedVideoFrame': Illegal constructor");

  class RTCStatsReport extends Map {
    constructor(token) {
      if (token !== rtcInternalToken) throw new TypeError('Illegal constructor');
      super();
    }
  }
  Object.defineProperty(RTCStatsReport.prototype, Symbol.toStringTag, { value: 'RTCStatsReport', configurable: true });

  Object.defineProperty(RTCStatsReport, 'name', { value: 'RTCStatsReport', configurable: true });
  class RTCRtpScriptTransform {
    constructor(worker) {
      if (!worker || typeof worker !== 'object') throw new TypeError("Failed to construct 'RTCRtpScriptTransform': parameter 1 is not of type 'Worker'.");
      throw new DOMExceptionBase('RTCRtpScriptTransform is disabled by policy.', 'NotAllowedError');
    }
  }
  Object.defineProperty(RTCRtpScriptTransform.prototype, Symbol.toStringTag, { value: 'RTCRtpScriptTransform', configurable: true });

  Object.defineProperty(RTCRtpScriptTransform, 'name', { value: 'RTCRtpScriptTransform', configurable: true });
  return {
    RTCIceCandidate,
    RTCSessionDescription,
    RTCError,
    RTCPeerConnection,
    RTCDataChannel,
    RTCDtlsTransport,
    RTCIceTransport,
    RTCSctpTransport,
    RTCDTMFSender,
    RTCRtpReceiver,
    RTCRtpSender,
    RTCRtpTransceiver,
    RTCStatsReport,
    RTCCertificate,
    RTCEncodedAudioFrame,
    RTCEncodedVideoFrame,
    RTCRtpScriptTransform,
  };
}

function rtcSdpType(value) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  if (!validSdpTypes.has(text)) throw new TypeError(`Failed to construct 'RTCSessionDescription': Failed to read the 'type' property from 'RTCSessionDescriptionInit': The provided value '${text}' is not a valid enum value of type RTCSdpType.`);
  return text;
}

function rtcErrorDetail(value) {
  if (value === undefined) throw new TypeError("Failed to construct 'RTCError': Failed to read the 'errorDetail' property from 'RTCErrorInit': Required member is undefined.");
  const text = String(value);
  if (!validRTCErrorDetails.has(text)) throw new TypeError(`Failed to construct 'RTCError': Failed to read the 'errorDetail' property from 'RTCErrorInit': The provided value '${text}' is not a valid enum value of type RTCErrorDetailType.`);
  return text;
}

function nullableString(value) {
  return value === undefined || value === null ? null : String(value);
}

function nullableNumber(value) {
  return value === undefined || value === null ? null : Number(value);
}


function rejectRTCPolicy(DOMExceptionBase) {
  return Promise.reject(new DOMExceptionBase('WebRTC is disabled by policy.', 'NotAllowedError'));
}

function cloneRTCConfiguration(configuration = {}) {
  const iceServers = Array.isArray(configuration.iceServers)
    ? configuration.iceServers.map((server) => ({ ...server }))
    : [];
  return {
    ...configuration,
    iceServers,
  };
}

function makeIllegalRTCConstructor(interfaceName, internalToken, message = 'Illegal constructor') {
  const ctor = function RTCIllegalConstructor(token) {
    if (token !== internalToken) throw new TypeError(message);
  };
  Object.defineProperty(ctor, 'name', { value: interfaceName, configurable: true });
  Object.defineProperty(ctor.prototype, Symbol.toStringTag, { value: interfaceName, configurable: true });
  return ctor;
}
function defineHidden(target, key, value) {
  Object.defineProperty(target, key, { value, configurable: true });
}
