const audioContextToken = {};
const audioNodeToken = {};
const audioScheduledSourceToken = {};
const audioParamToken = {};
const listenerToken = {};
const scriptProcessorToken = {};
const workletToken = {};

export function createAudioFacades(EventTargetBase) {
  class AudioParam {
    constructor(token, value = 0, minValue = -3.4028234663852886e38, maxValue = 3.4028234663852886e38) {
      if (token !== audioParamToken) throw new TypeError("Failed to construct 'AudioParam': Illegal constructor");
      defineHidden(this, '__zpValue', Number(value) || 0);
      defineHidden(this, '__zpDefaultValue', Number(value) || 0);
      defineHidden(this, '__zpMinValue', Number(minValue));
      defineHidden(this, '__zpMaxValue', Number(maxValue));
    }
    get value() { return this.__zpValue; }
    set value(value) { defineHidden(this, '__zpValue', Number(value) || 0); }
    get defaultValue() { return this.__zpDefaultValue; }
    get minValue() { return this.__zpMinValue; }
    get maxValue() { return this.__zpMaxValue; }
    setValueAtTime(value) { this.value = value; return this; }
    linearRampToValueAtTime(value) { this.value = value; return this; }
    exponentialRampToValueAtTime(value) { this.value = value; return this; }
    setTargetAtTime(value) { this.value = value; return this; }
    setValueCurveAtTime(values) { if (values?.length) this.value = values[values.length - 1]; return this; }
    cancelScheduledValues() { return this; }
    cancelAndHoldAtTime() { return this; }
  }
  Object.defineProperty(AudioParam.prototype, Symbol.toStringTag, { value: 'AudioParam', configurable: true });

  function audioParam(value, minValue, maxValue) {
    return new AudioParam(audioParamToken, value, minValue, maxValue);
  }

  class AudioNode extends EventTargetBase {

    constructor(token, context, init = {}) {
      if (token !== audioNodeToken) throw new TypeError("Failed to construct 'AudioNode': Illegal constructor");
      super();
      defineHidden(this, '__zpContext', context ?? null);
      defineHidden(this, '__zpNumberOfInputs', Number(init.numberOfInputs ?? 1) || 0);
      defineHidden(this, '__zpNumberOfOutputs', Number(init.numberOfOutputs ?? 1) || 0);
      defineHidden(this, '__zpChannelCount', Number(init.channelCount ?? 2) || 0);
      defineHidden(this, '__zpChannelCountMode', String(init.channelCountMode ?? 'max'));
      defineHidden(this, '__zpChannelInterpretation', String(init.channelInterpretation ?? 'speakers'));
    }
    get context() { return this.__zpContext; }
    get numberOfInputs() { return this.__zpNumberOfInputs; }
    get numberOfOutputs() { return this.__zpNumberOfOutputs; }
    get channelCount() { return this.__zpChannelCount; }
    set channelCount(value) { defineHidden(this, '__zpChannelCount', Number(value) || 0); }
    get channelCountMode() { return this.__zpChannelCountMode; }
    set channelCountMode(value) { defineHidden(this, '__zpChannelCountMode', String(value)); }
    get channelInterpretation() { return this.__zpChannelInterpretation; }
    set channelInterpretation(value) { defineHidden(this, '__zpChannelInterpretation', String(value)); }
    connect(destination) { return destination; }
    disconnect() {}
  }
  Object.defineProperty(AudioNode.prototype, Symbol.toStringTag, { value: 'AudioNode', configurable: true });

  class AudioDestinationNode extends AudioNode {
    constructor(context) { super(audioNodeToken, context, { numberOfInputs: 1, numberOfOutputs: 0 }); defineHidden(this, '__zpMaxChannelCount', 2); }
    get maxChannelCount() { return this.__zpMaxChannelCount; }
  }
  Object.defineProperty(AudioDestinationNode.prototype, Symbol.toStringTag, { value: 'AudioDestinationNode', configurable: true });

  class AudioListener {
    constructor(token) {
      if (token !== listenerToken) throw new TypeError("Failed to construct 'AudioListener': Illegal constructor");
      defineHidden(this, '__zpPositionX', new AudioParam(audioParamToken, 0));
      defineHidden(this, '__zpPositionY', new AudioParam(audioParamToken, 0));
      defineHidden(this, '__zpPositionZ', new AudioParam(audioParamToken, 0));
      defineHidden(this, '__zpForwardX', new AudioParam(audioParamToken, 0));
      defineHidden(this, '__zpForwardY', new AudioParam(audioParamToken, 0));
      defineHidden(this, '__zpForwardZ', new AudioParam(audioParamToken, -1));
      defineHidden(this, '__zpUpX', new AudioParam(audioParamToken, 0));
      defineHidden(this, '__zpUpY', new AudioParam(audioParamToken, 1));
      defineHidden(this, '__zpUpZ', new AudioParam(audioParamToken, 0));
    }
    get positionX() { return this.__zpPositionX; }
    get positionY() { return this.__zpPositionY; }
    get positionZ() { return this.__zpPositionZ; }
    get forwardX() { return this.__zpForwardX; }
    get forwardY() { return this.__zpForwardY; }
    get forwardZ() { return this.__zpForwardZ; }
    get upX() { return this.__zpUpX; }
    get upY() { return this.__zpUpY; }
    get upZ() { return this.__zpUpZ; }
    setPosition(x, y, z) { this.positionX.value = x; this.positionY.value = y; this.positionZ.value = z; }
    setOrientation(x, y, z, upX, upY, upZ) { this.forwardX.value = x; this.forwardY.value = y; this.forwardZ.value = z; this.upX.value = upX; this.upY.value = upY; this.upZ.value = upZ; }
  }
  Object.defineProperty(AudioListener.prototype, Symbol.toStringTag, { value: 'AudioListener', configurable: true });

  class AudioWorklet {
    constructor(token) { if (token !== workletToken) throw new TypeError("Failed to construct 'AudioWorklet': Illegal constructor"); }
    addModule() { return Promise.reject(new DOMException('AudioWorklet is disabled by policy.', 'NotAllowedError')); }
  }
  Object.defineProperty(AudioWorklet.prototype, Symbol.toStringTag, { value: 'AudioWorklet', configurable: true });

  class BaseAudioContext extends EventTargetBase {
    constructor(token, init = {}) {
      if (token !== audioContextToken) throw new TypeError("Failed to construct 'BaseAudioContext': Illegal constructor");
      super();
      defineHidden(this, '__zpState', 'running');
      defineHidden(this, '__zpSampleRate', Number(init.sampleRate ?? 48000) || 48000);
      defineHidden(this, '__zpCurrentTime', 0);
      defineHidden(this, '__zpDestination', new AudioDestinationNode(this));
      defineHidden(this, '__zpListener', new AudioListener(listenerToken));
      defineHidden(this, '__zpAudioWorklet', new AudioWorklet(workletToken));
    }
    get destination() { return this.__zpDestination; }
    get sampleRate() { return this.__zpSampleRate; }
    get currentTime() { return this.__zpCurrentTime; }
    get listener() { return this.__zpListener; }
    get state() { return this.__zpState; }
    get audioWorklet() { return this.__zpAudioWorklet; }
    createBuffer(numberOfChannels, length, sampleRate) { return new AudioBuffer({ numberOfChannels, length, sampleRate }); }
    createBufferSource() { return new AudioBufferSourceNode(this); }
    createGain() { return new GainNode(this); }
    createOscillator() { return new OscillatorNode(this); }
    createAnalyser() { return new AnalyserNode(this); }
    createScriptProcessor(bufferSize = 0, numberOfInputChannels = 2, numberOfOutputChannels = 2) { return new ScriptProcessorNode(scriptProcessorToken, this, bufferSize, numberOfInputChannels, numberOfOutputChannels); }
    decodeAudioData() { return Promise.resolve(this.createBuffer(1, 0, this.sampleRate)); }
  }
  Object.defineProperty(BaseAudioContext.prototype, Symbol.toStringTag, { value: 'BaseAudioContext', configurable: true });

  class AudioContext extends BaseAudioContext {
    constructor(init = {}) { super(audioContextToken, init); defineHidden(this, '__zpBaseLatency', 0); defineHidden(this, '__zpOutputLatency', 0); }
    get baseLatency() { return this.__zpBaseLatency; }
    get outputLatency() { return this.__zpOutputLatency; }
    suspend() { defineHidden(this, '__zpState', 'suspended'); return Promise.resolve(); }
    resume() { defineHidden(this, '__zpState', 'running'); return Promise.resolve(); }
    close() { defineHidden(this, '__zpState', 'closed'); return Promise.resolve(); }
    getOutputTimestamp() { return { contextTime: this.currentTime, performanceTime: performance.now?.() ?? 0 }; }
    createMediaElementSource() { return new AudioNode(audioNodeToken, this); }
    createMediaStreamSource() { return new AudioNode(audioNodeToken, this); }
    createMediaStreamDestination() { return new AudioNode(audioNodeToken, this); }
  }
  Object.defineProperty(AudioContext.prototype, Symbol.toStringTag, { value: 'AudioContext', configurable: true });

  class OfflineAudioContext extends BaseAudioContext {
    constructor(numberOfChannelsOrOptions, length, sampleRate) {
      const options = typeof numberOfChannelsOrOptions === 'object' ? numberOfChannelsOrOptions : { numberOfChannels: numberOfChannelsOrOptions, length, sampleRate };
      super(audioContextToken, options);
      defineHidden(this, '__zpLength', Number(options.length ?? 0) || 0);
      defineHidden(this, '__zpNumberOfChannels', Number(options.numberOfChannels ?? 1) || 1);
    }
    get length() { return this.__zpLength; }
    startRendering() { defineHidden(this, '__zpState', 'closed'); return Promise.resolve(this.createBuffer(this.__zpNumberOfChannels, this.length, this.sampleRate)); }
  }
  Object.defineProperty(OfflineAudioContext.prototype, Symbol.toStringTag, { value: 'OfflineAudioContext', configurable: true });

  class AudioBuffer {
    constructor(options = {}) {
      const numberOfChannels = Number(options.numberOfChannels ?? 1) || 1;
      const length = Number(options.length ?? 0) || 0;
      defineHidden(this, '__zpNumberOfChannels', Math.max(1, Math.floor(numberOfChannels)));
      defineHidden(this, '__zpLength', Math.max(0, Math.floor(length)));
      defineHidden(this, '__zpSampleRate', Number(options.sampleRate ?? 48000) || 48000);
      defineHidden(this, '__zpChannels', Array.from({ length: Math.max(1, Math.floor(numberOfChannels)) }, () => new Float32Array(Math.max(0, Math.floor(length)))));
    }
    get sampleRate() { return this.__zpSampleRate; }
    get length() { return this.__zpLength; }
    get duration() { return this.sampleRate ? this.length / this.sampleRate : 0; }
    get numberOfChannels() { return this.__zpNumberOfChannels; }
    getChannelData(channel) { return this.__zpChannels[Number(channel)] ?? new Float32Array(0); }
    copyFromChannel(destination, channel, startInChannel = 0) { destination.set(this.getChannelData(channel).subarray(Number(startInChannel) || 0, (Number(startInChannel) || 0) + destination.length)); }
    copyToChannel(source, channel, startInChannel = 0) { this.getChannelData(channel).set(source.subarray(0, this.getChannelData(channel).length - (Number(startInChannel) || 0)), Number(startInChannel) || 0); }
  }
  Object.defineProperty(AudioBuffer.prototype, Symbol.toStringTag, { value: 'AudioBuffer', configurable: true });

  class AudioScheduledSourceNode extends AudioNode {
    constructor(token, context, init = {}) {
      if (token !== audioScheduledSourceToken) throw new TypeError("Failed to construct 'AudioScheduledSourceNode': Illegal constructor");
      super(audioNodeToken, context, init);
    }
    start() { this.dispatchEvent(new Event('ended')); }
    stop() { this.dispatchEvent(new Event('ended')); }
  }
  Object.defineProperty(AudioScheduledSourceNode.prototype, Symbol.toStringTag, { value: 'AudioScheduledSourceNode', configurable: true });

  class AudioBufferSourceNode extends AudioScheduledSourceNode {
    constructor(context, init = {}) { super(audioScheduledSourceToken, context); defineHidden(this, '__zpBuffer', init.buffer ?? null); defineHidden(this, '__zpPlaybackRate', new AudioParam(audioParamToken, 1)); defineHidden(this, '__zpDetune', new AudioParam(audioParamToken, 0)); defineHidden(this, '__zpLoop', false); }
    get buffer() { return this.__zpBuffer; }
    set buffer(value) { defineHidden(this, '__zpBuffer', value); }
    get playbackRate() { return this.__zpPlaybackRate; }
    get detune() { return this.__zpDetune; }
    get loop() { return this.__zpLoop; }
    set loop(value) { defineHidden(this, '__zpLoop', Boolean(value)); }
    start() { this.dispatchEvent(new Event('ended')); }
    stop() { this.dispatchEvent(new Event('ended')); }
  }
  Object.defineProperty(AudioBufferSourceNode.prototype, Symbol.toStringTag, { value: 'AudioBufferSourceNode', configurable: true });

  class GainNode extends AudioNode {
    constructor(context, init = {}) { super(audioNodeToken, context); defineHidden(this, '__zpGain', new AudioParam(audioParamToken, init.gain ?? 1, -3.4028234663852886e38, 3.4028234663852886e38)); }
    get gain() { return this.__zpGain; }
  }
  Object.defineProperty(GainNode.prototype, Symbol.toStringTag, { value: 'GainNode', configurable: true });

  class OscillatorNode extends AudioScheduledSourceNode {
    constructor(context, init = {}) { super(audioScheduledSourceToken, context); defineHidden(this, '__zpType', String(init.type ?? 'sine')); defineHidden(this, '__zpFrequency', new AudioParam(audioParamToken, init.frequency ?? 440)); defineHidden(this, '__zpDetune', new AudioParam(audioParamToken, init.detune ?? 0)); }
    get type() { return this.__zpType; }
    set type(value) { defineHidden(this, '__zpType', String(value)); }
    get frequency() { return this.__zpFrequency; }
    get detune() { return this.__zpDetune; }
    setPeriodicWave() {}
    start() { this.dispatchEvent(new Event('ended')); }
    stop() { this.dispatchEvent(new Event('ended')); }
  }
  Object.defineProperty(OscillatorNode.prototype, Symbol.toStringTag, { value: 'OscillatorNode', configurable: true });

  class AnalyserNode extends AudioNode {
    constructor(context, init = {}) { super(audioNodeToken, context); defineHidden(this, '__zpFftSize', Number(init.fftSize ?? 2048) || 2048); defineHidden(this, '__zpMinDecibels', -100); defineHidden(this, '__zpMaxDecibels', -30); defineHidden(this, '__zpSmoothingTimeConstant', 0.8); }
    get fftSize() { return this.__zpFftSize; }
    set fftSize(value) { defineHidden(this, '__zpFftSize', Number(value) || 2048); }
    get frequencyBinCount() { return this.fftSize / 2; }
    get minDecibels() { return this.__zpMinDecibels; }
    set minDecibels(value) { defineHidden(this, '__zpMinDecibels', Number(value)); }
    get maxDecibels() { return this.__zpMaxDecibels; }
    set maxDecibels(value) { defineHidden(this, '__zpMaxDecibels', Number(value)); }
    get smoothingTimeConstant() { return this.__zpSmoothingTimeConstant; }
    set smoothingTimeConstant(value) { defineHidden(this, '__zpSmoothingTimeConstant', Number(value)); }
    getFloatFrequencyData(array) { array.fill(-Infinity); }
    getByteFrequencyData(array) { array.fill(0); }
    getFloatTimeDomainData(array) { array.fill(0); }
    getByteTimeDomainData(array) { array.fill(128); }
  }
  Object.defineProperty(AnalyserNode.prototype, Symbol.toStringTag, { value: 'AnalyserNode', configurable: true });


  class BiquadFilterNode extends AudioNode {
    constructor(context, init = {}) { super(audioNodeToken, context); defineHidden(this, '__zpType', String(init.type ?? 'lowpass')); defineHidden(this, '__zpFrequency', audioParam(init.frequency ?? 350)); defineHidden(this, '__zpDetune', audioParam(init.detune ?? 0)); defineHidden(this, '__zpQ', audioParam(init.Q ?? 1)); defineHidden(this, '__zpGain', audioParam(init.gain ?? 0)); }
    get type() { return this.__zpType; }
    set type(value) { defineHidden(this, '__zpType', String(value)); }
    get frequency() { return this.__zpFrequency; }
    get detune() { return this.__zpDetune; }
    get Q() { return this.__zpQ; }
    get gain() { return this.__zpGain; }
    getFrequencyResponse(frequencyHz, magResponse, phaseResponse) { magResponse.fill(1); phaseResponse.fill(0); }
  }
  Object.defineProperty(BiquadFilterNode.prototype, Symbol.toStringTag, { value: 'BiquadFilterNode', configurable: true });

  class DelayNode extends AudioNode {
    constructor(context, init = {}) { super(audioNodeToken, context); defineHidden(this, '__zpDelayTime', audioParam(init.delayTime ?? 0, 0, init.maxDelayTime ?? 1)); }
    get delayTime() { return this.__zpDelayTime; }
  }
  Object.defineProperty(DelayNode.prototype, Symbol.toStringTag, { value: 'DelayNode', configurable: true });

  class DynamicsCompressorNode extends AudioNode {
    constructor(context, init = {}) { super(audioNodeToken, context); defineHidden(this, '__zpThreshold', audioParam(init.threshold ?? -24)); defineHidden(this, '__zpKnee', audioParam(init.knee ?? 30)); defineHidden(this, '__zpRatio', audioParam(init.ratio ?? 12)); defineHidden(this, '__zpReduction', 0); defineHidden(this, '__zpAttack', audioParam(init.attack ?? 0.003)); defineHidden(this, '__zpRelease', audioParam(init.release ?? 0.25)); }
    get threshold() { return this.__zpThreshold; }
    get knee() { return this.__zpKnee; }
    get ratio() { return this.__zpRatio; }
    get reduction() { return this.__zpReduction; }
    get attack() { return this.__zpAttack; }
    get release() { return this.__zpRelease; }
  }
  Object.defineProperty(DynamicsCompressorNode.prototype, Symbol.toStringTag, { value: 'DynamicsCompressorNode', configurable: true });

  class StereoPannerNode extends AudioNode {
    constructor(context, init = {}) { super(audioNodeToken, context); defineHidden(this, '__zpPan', audioParam(init.pan ?? 0, -1, 1)); }
    get pan() { return this.__zpPan; }
  }
  Object.defineProperty(StereoPannerNode.prototype, Symbol.toStringTag, { value: 'StereoPannerNode', configurable: true });

  class PannerNode extends AudioNode {
    constructor(context, init = {}) {
      super(audioNodeToken, context);
      initPannerParams(this, init);
      initPannerScalars(this, init);
    }
    get positionX() { return this.__zpPositionX; }
    get positionY() { return this.__zpPositionY; }
    get positionZ() { return this.__zpPositionZ; }
    get orientationX() { return this.__zpOrientationX; }
    get orientationY() { return this.__zpOrientationY; }
    get orientationZ() { return this.__zpOrientationZ; }
    get panningModel() { return this.__zpPanningModel; }
    set panningModel(value) { defineHidden(this, '__zpPanningModel', String(value)); }
    get distanceModel() { return this.__zpDistanceModel; }
    set distanceModel(value) { defineHidden(this, '__zpDistanceModel', String(value)); }
    get refDistance() { return this.__zpRefDistance; }
    set refDistance(value) { defineHidden(this, '__zpRefDistance', Number(value)); }
    get maxDistance() { return this.__zpMaxDistance; }
    set maxDistance(value) { defineHidden(this, '__zpMaxDistance', Number(value)); }
    get rolloffFactor() { return this.__zpRolloffFactor; }
    set rolloffFactor(value) { defineHidden(this, '__zpRolloffFactor', Number(value)); }
    get coneInnerAngle() { return this.__zpConeInnerAngle; }
    set coneInnerAngle(value) { defineHidden(this, '__zpConeInnerAngle', Number(value)); }
    get coneOuterAngle() { return this.__zpConeOuterAngle; }
    set coneOuterAngle(value) { defineHidden(this, '__zpConeOuterAngle', Number(value)); }
    get coneOuterGain() { return this.__zpConeOuterGain; }
    set coneOuterGain(value) { defineHidden(this, '__zpConeOuterGain', Number(value)); }
    setPosition(x, y, z) { this.positionX.value = x; this.positionY.value = y; this.positionZ.value = z; }
    setOrientation(x, y, z) { this.orientationX.value = x; this.orientationY.value = y; this.orientationZ.value = z; }
  }
  Object.defineProperty(PannerNode.prototype, Symbol.toStringTag, { value: 'PannerNode', configurable: true });


  function initPannerParams(node, init) {
    defineHidden(node, '__zpPositionX', audioParam(init.positionX ?? 0));
    defineHidden(node, '__zpPositionY', audioParam(init.positionY ?? 0));
    defineHidden(node, '__zpPositionZ', audioParam(init.positionZ ?? 0));
    defineHidden(node, '__zpOrientationX', audioParam(init.orientationX ?? 1));
    defineHidden(node, '__zpOrientationY', audioParam(init.orientationY ?? 0));
    defineHidden(node, '__zpOrientationZ', audioParam(init.orientationZ ?? 0));
  }

  function initPannerScalars(node, init) {
    defineHidden(node, '__zpPanningModel', String(init.panningModel ?? 'equalpower'));
    defineHidden(node, '__zpDistanceModel', String(init.distanceModel ?? 'inverse'));
    defineHidden(node, '__zpRefDistance', Number(init.refDistance ?? 1) || 1);
    defineHidden(node, '__zpMaxDistance', Number(init.maxDistance ?? 10000) || 10000);
    defineHidden(node, '__zpRolloffFactor', Number(init.rolloffFactor ?? 1) || 1);
    defineHidden(node, '__zpConeInnerAngle', Number(init.coneInnerAngle ?? 360) || 360);
    defineHidden(node, '__zpConeOuterAngle', Number(init.coneOuterAngle ?? 360) || 360);
    defineHidden(node, '__zpConeOuterGain', Number(init.coneOuterGain ?? 0) || 0);
  }
  class WaveShaperNode extends AudioNode {
    constructor(context, init = {}) { super(audioNodeToken, context); defineHidden(this, '__zpCurve', init.curve ?? null); defineHidden(this, '__zpOversample', String(init.oversample ?? 'none')); }
    get curve() { return this.__zpCurve; }
    set curve(value) { defineHidden(this, '__zpCurve', value); }
    get oversample() { return this.__zpOversample; }
    set oversample(value) { defineHidden(this, '__zpOversample', String(value)); }
  }
  Object.defineProperty(WaveShaperNode.prototype, Symbol.toStringTag, { value: 'WaveShaperNode', configurable: true });

  class ConvolverNode extends AudioNode {
    constructor(context, init = {}) { super(audioNodeToken, context); defineHidden(this, '__zpBuffer', init.buffer ?? null); defineHidden(this, '__zpNormalize', init.disableNormalization === true ? false : Boolean(init.normalize ?? true)); }
    get buffer() { return this.__zpBuffer; }
    set buffer(value) { defineHidden(this, '__zpBuffer', value); }
    get normalize() { return this.__zpNormalize; }
    set normalize(value) { defineHidden(this, '__zpNormalize', Boolean(value)); }
  }
  Object.defineProperty(ConvolverNode.prototype, Symbol.toStringTag, { value: 'ConvolverNode', configurable: true });

  class IIRFilterNode extends AudioNode {
    constructor(context, init = {}) { super(audioNodeToken, context); defineHidden(this, '__zpFeedforward', Array.from(init.feedforward ?? [1])); defineHidden(this, '__zpFeedback', Array.from(init.feedback ?? [1])); }
    getFrequencyResponse(frequencyHz, magResponse, phaseResponse) { magResponse.fill(1); phaseResponse.fill(0); }
  }
  Object.defineProperty(IIRFilterNode.prototype, Symbol.toStringTag, { value: 'IIRFilterNode', configurable: true });

  class ChannelSplitterNode extends AudioNode {
    constructor(context, init = {}) { super(audioNodeToken, context, { numberOfInputs: 1, numberOfOutputs: Number(init.numberOfOutputs ?? 6) || 6 }); }
  }
  Object.defineProperty(ChannelSplitterNode.prototype, Symbol.toStringTag, { value: 'ChannelSplitterNode', configurable: true });

  class ChannelMergerNode extends AudioNode {
    constructor(context, init = {}) { super(audioNodeToken, context, { numberOfInputs: Number(init.numberOfInputs ?? 6) || 6, numberOfOutputs: 1 }); }
  }
  Object.defineProperty(ChannelMergerNode.prototype, Symbol.toStringTag, { value: 'ChannelMergerNode', configurable: true });

  class ConstantSourceNode extends AudioScheduledSourceNode {
    constructor(context, init = {}) { super(audioScheduledSourceToken, context); defineHidden(this, '__zpOffset', audioParam(init.offset ?? 1)); }
    get offset() { return this.__zpOffset; }
    start() { this.dispatchEvent(new Event('ended')); }
    stop() { this.dispatchEvent(new Event('ended')); }
  }
  Object.defineProperty(ConstantSourceNode.prototype, Symbol.toStringTag, { value: 'ConstantSourceNode', configurable: true });

  class PeriodicWave {
    constructor(_context, init = {}) { defineHidden(this, '__zpReal', Array.from(init.real ?? [])); defineHidden(this, '__zpImag', Array.from(init.imag ?? [])); }
  }
  Object.defineProperty(PeriodicWave.prototype, Symbol.toStringTag, { value: 'PeriodicWave', configurable: true });

  class AudioParamMap {
    constructor() { throw new TypeError("Failed to construct 'AudioParamMap': Illegal constructor"); }
  }
  Object.defineProperty(AudioParamMap.prototype, 'size', { get() { return 0; }, configurable: true });
  Object.defineProperty(AudioParamMap.prototype, 'get', { value() { return undefined; }, writable: true, configurable: true });
  Object.defineProperty(AudioParamMap.prototype, 'has', { value() { return false; }, writable: true, configurable: true });
  Object.defineProperty(AudioParamMap.prototype, Symbol.iterator, { value: function* entries() {}, writable: true, configurable: true });
  Object.defineProperty(AudioParamMap.prototype, Symbol.toStringTag, { value: 'AudioParamMap', configurable: true });

  class AudioWorkletNode extends AudioNode {
    constructor(context, name = '', init = {}) { super(audioNodeToken, context); defineHidden(this, '__zpName', String(name)); defineHidden(this, '__zpParameters', Object.create(AudioParamMap.prototype)); defineHidden(this, '__zpPort', typeof MessageChannel === 'function' ? new MessageChannel().port1 : null); }
    get parameters() { return this.__zpParameters; }
    get port() { return this.__zpPort; }
  }
  Object.defineProperty(AudioWorkletNode.prototype, Symbol.toStringTag, { value: 'AudioWorkletNode', configurable: true });

  class MediaElementAudioSourceNode extends AudioNode {
    constructor(context, init = {}) { super(audioNodeToken, context, { numberOfInputs: 0, numberOfOutputs: 1 }); defineHidden(this, '__zpMediaElement', init.mediaElement ?? null); }
    get mediaElement() { return this.__zpMediaElement; }
  }
  Object.defineProperty(MediaElementAudioSourceNode.prototype, Symbol.toStringTag, { value: 'MediaElementAudioSourceNode', configurable: true });

  class MediaStreamAudioSourceNode extends AudioNode {
    constructor(context, init = {}) { super(audioNodeToken, context, { numberOfInputs: 0, numberOfOutputs: 1 }); defineHidden(this, '__zpMediaStream', init.mediaStream ?? null); }
    get mediaStream() { return this.__zpMediaStream; }
  }
  Object.defineProperty(MediaStreamAudioSourceNode.prototype, Symbol.toStringTag, { value: 'MediaStreamAudioSourceNode', configurable: true });

  class MediaStreamAudioDestinationNode extends AudioNode {
    constructor(context) { super(audioNodeToken, context, { numberOfInputs: 1, numberOfOutputs: 0 }); defineHidden(this, '__zpStream', new MediaStream()); }
    get stream() { return this.__zpStream; }
  }
  Object.defineProperty(MediaStreamAudioDestinationNode.prototype, Symbol.toStringTag, { value: 'MediaStreamAudioDestinationNode', configurable: true });

  const offlineAudioCompletionEventState = new WeakMap();
  function OfflineAudioCompletionEvent(type, init) {
    if (!new.target) throw new TypeError("Failed to construct 'OfflineAudioCompletionEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    if (arguments.length < 2) throw new TypeError(`Failed to construct 'OfflineAudioCompletionEvent': 2 arguments required, but only ${arguments.length} present.`);
    if (init === null || typeof init !== 'object') throw new TypeError("Failed to construct 'OfflineAudioCompletionEvent': The provided value is not of type 'OfflineAudioCompletionEventInit'.");
    const renderedBuffer = offlineAudioCompletionEventRenderedBuffer(init);
    const event = Reflect.construct(Event, [offlineAudioCompletionEventType(type), init], new.target);
    offlineAudioCompletionEventState.set(event, { renderedBuffer });
    return event;
  }
  Object.setPrototypeOf(OfflineAudioCompletionEvent, Event);
  OfflineAudioCompletionEvent.prototype = Object.create(Event.prototype);
  Object.defineProperties(OfflineAudioCompletionEvent.prototype, {
    renderedBuffer: { get() { return offlineAudioCompletionEventValue(this).renderedBuffer; }, enumerable: true, configurable: true },
    constructor: { value: OfflineAudioCompletionEvent, writable: true, configurable: true },
  });
  Object.defineProperty(OfflineAudioCompletionEvent.prototype, Symbol.toStringTag, { value: 'OfflineAudioCompletionEvent', configurable: true });
  Object.defineProperty(OfflineAudioCompletionEvent, 'prototype', { writable: false });

  function offlineAudioCompletionEventValue(event) {
    const state = offlineAudioCompletionEventState.get(event);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function offlineAudioCompletionEventType(value) {
    if (typeof value === 'symbol') throw new TypeError("Failed to construct 'OfflineAudioCompletionEvent': Cannot convert a Symbol value to a string");
    return String(value);
  }

  function offlineAudioCompletionEventRenderedBuffer(init) {
    const renderedBuffer = init.renderedBuffer;
    if (renderedBuffer === undefined) throw new TypeError("Failed to construct 'OfflineAudioCompletionEvent': Failed to read the 'renderedBuffer' property from 'OfflineAudioCompletionEventInit': Required member is undefined.");
    if (!(renderedBuffer instanceof AudioBuffer)) throw new TypeError("Failed to construct 'OfflineAudioCompletionEvent': Failed to read the 'renderedBuffer' property from 'OfflineAudioCompletionEventInit': Failed to convert value to 'AudioBuffer'.");
    return renderedBuffer;
  }

  const audioProcessingEventState = new WeakMap();
  function AudioProcessingEvent(type, init) {
    if (!new.target) throw new TypeError("Failed to construct 'AudioProcessingEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    if (arguments.length < 2) throw new TypeError(`Failed to construct 'AudioProcessingEvent': 2 arguments required, but only ${arguments.length} present.`);
    if (init === null || typeof init !== 'object') throw new TypeError("Failed to construct 'AudioProcessingEvent': The provided value is not of type 'AudioProcessingEventInit'.");
    const inputBuffer = audioProcessingEventBuffer(init, 'inputBuffer');
    const outputBuffer = audioProcessingEventBuffer(init, 'outputBuffer');
    const playbackTime = audioProcessingEventPlaybackTime(init);
    const event = Reflect.construct(Event, [audioProcessingEventType(type), init], new.target);
    audioProcessingEventState.set(event, { inputBuffer, outputBuffer, playbackTime });
    return event;
  }
  Object.setPrototypeOf(AudioProcessingEvent, Event);
  AudioProcessingEvent.prototype = Object.create(Event.prototype);
  Object.defineProperties(AudioProcessingEvent.prototype, {
    playbackTime: { get() { return audioProcessingEventValue(this).playbackTime; }, enumerable: true, configurable: true },
    inputBuffer: { get() { return audioProcessingEventValue(this).inputBuffer; }, enumerable: true, configurable: true },
    outputBuffer: { get() { return audioProcessingEventValue(this).outputBuffer; }, enumerable: true, configurable: true },
    constructor: { value: AudioProcessingEvent, writable: true, configurable: true },
  });
  Object.defineProperty(AudioProcessingEvent.prototype, Symbol.toStringTag, { value: 'AudioProcessingEvent', configurable: true });
  Object.defineProperty(AudioProcessingEvent, 'prototype', { writable: false });

  function audioProcessingEventValue(event) {
    const state = audioProcessingEventState.get(event);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function audioProcessingEventType(value) {
    if (typeof value === 'symbol') throw new TypeError("Failed to construct 'AudioProcessingEvent': Cannot convert a Symbol value to a string");
    return String(value);
  }

  function audioProcessingEventBuffer(init, field) {
    const value = init[field];
    if (value === undefined) throw new TypeError(`Failed to construct 'AudioProcessingEvent': Failed to read the '${field}' property from 'AudioProcessingEventInit': Required member is undefined.`);
    if (!(value instanceof AudioBuffer)) throw new TypeError(`Failed to construct 'AudioProcessingEvent': Failed to read the '${field}' property from 'AudioProcessingEventInit': Failed to convert value to 'AudioBuffer'.`);
    return value;
  }

  function audioProcessingEventPlaybackTime(init) {
    const value = init.playbackTime;
    if (value === undefined) throw new TypeError("Failed to construct 'AudioProcessingEvent': Failed to read the 'playbackTime' property from 'AudioProcessingEventInit': Required member is undefined.");
    if (typeof value === 'symbol') throw new TypeError("Failed to construct 'AudioProcessingEvent': Failed to read the 'playbackTime' property from 'AudioProcessingEventInit': Cannot convert a Symbol value to a number");
    const playbackTime = Number(value);
    if (!Number.isFinite(playbackTime)) throw new TypeError("Failed to construct 'AudioProcessingEvent': Failed to read the 'playbackTime' property from 'AudioProcessingEventInit': The provided double value is non-finite.");
    return playbackTime;
  }

  class ScriptProcessorNode extends AudioNode {
    constructor(token, context, bufferSize = 0, numberOfInputChannels = 2, numberOfOutputChannels = 2) {
      if (token !== scriptProcessorToken) throw new TypeError("Failed to construct 'ScriptProcessorNode': Illegal constructor");
      const inputs = Number(numberOfInputChannels) > 0 ? 1 : 0;
      const outputs = Number(numberOfOutputChannels) > 0 ? 1 : 0;
      super(audioNodeToken, context, { numberOfInputs: inputs, numberOfOutputs: outputs });
      defineHidden(this, '__zpBufferSize', Number(bufferSize) || 0);
      defineHidden(this, '__zpOnaudioprocess', null);
    }
    get bufferSize() { return this.__zpBufferSize; }
    get onaudioprocess() { return this.__zpOnaudioprocess; }
    set onaudioprocess(value) { defineHidden(this, '__zpOnaudioprocess', typeof value === 'function' ? value : null); }
  }
  Object.defineProperty(ScriptProcessorNode.prototype, Symbol.toStringTag, { value: 'ScriptProcessorNode', configurable: true });

  return { AnalyserNode, AudioBuffer, AudioBufferSourceNode, AudioContext, AudioDestinationNode, AudioListener, AudioNode, AudioParam, AudioParamMap, AudioProcessingEvent, AudioScheduledSourceNode, AudioWorklet, AudioWorkletNode, BaseAudioContext, BiquadFilterNode, ChannelMergerNode, ChannelSplitterNode, ConstantSourceNode, ConvolverNode, DelayNode, DynamicsCompressorNode, GainNode, IIRFilterNode, MediaElementAudioSourceNode, MediaStreamAudioDestinationNode, MediaStreamAudioSourceNode, OfflineAudioCompletionEvent, OfflineAudioContext, OscillatorNode, PannerNode, PeriodicWave, ScriptProcessorNode, StereoPannerNode, WaveShaperNode };
}


function defineHidden(target, key, value) {
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
}
