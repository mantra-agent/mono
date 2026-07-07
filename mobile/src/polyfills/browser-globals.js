/**
 * Browser globals polyfill for livekit-client in React Native.
 *
 * livekit-client (used by @elevenlabs/react-native) unconditionally reaches for
 * browser-only globals during Room initialization and Track.attach():
 *   - document.createElement('audio'|'video'), document.body, document.getElementById
 *   - HTMLElement, HTMLMediaElement, HTMLAudioElement, HTMLVideoElement
 *   - window.addEventListener/removeEventListener
 *   - navigator.mediaDevices.addEventListener/removeEventListener/getSupportedConstraints
 *   - AudioContext / webkitAudioContext
 *   - Event, MessageEvent, ErrorEvent, CloseEvent
 *   - location.href
 *
 * None of these are functional — real audio flows through @livekit/react-native-webrtc's
 * native AVAudioSession pipeline. This polyfill exists solely to prevent ReferenceErrors
 * that become NSExceptions on the TurboModule queue, causing SIGABRT.
 *
 * See: https://github.com/elevenlabs/packages/issues/766
 */

const g = globalThis;

// ---------------------------------------------------------------------------
// Event classes (livekit-client uses instanceof checks)
// ---------------------------------------------------------------------------

if (!g.Event) {
  g.Event = class Event {
    constructor(type, opts) {
      this.type = type;
      this.bubbles = !!(opts && opts.bubbles);
      this.cancelable = !!(opts && opts.cancelable);
      this.defaultPrevented = false;
      this.target = null;
      this.currentTarget = null;
      this.timeStamp = Date.now();
    }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() {}
    stopImmediatePropagation() {}
  };
}

if (!g.MessageEvent) {
  g.MessageEvent = class MessageEvent extends g.Event {
    constructor(type, opts) {
      super(type, opts);
      this.data = opts && opts.data !== undefined ? opts.data : null;
      this.origin = (opts && opts.origin) || '';
      this.lastEventId = (opts && opts.lastEventId) || '';
    }
  };
}

if (!g.ErrorEvent) {
  g.ErrorEvent = class ErrorEvent extends g.Event {
    constructor(type, opts) {
      super(type, opts);
      this.message = (opts && opts.message) || '';
      this.filename = (opts && opts.filename) || '';
      this.lineno = (opts && opts.lineno) || 0;
      this.colno = (opts && opts.colno) || 0;
      this.error = (opts && opts.error) || null;
    }
  };
}

if (!g.CloseEvent) {
  g.CloseEvent = class CloseEvent extends g.Event {
    constructor(type, opts) {
      super(type, opts);
      this.code = (opts && opts.code) || 0;
      this.reason = (opts && opts.reason) || '';
      this.wasClean = !!(opts && opts.wasClean);
    }
  };
}

// ---------------------------------------------------------------------------
// HTMLElement class hierarchy (for instanceof checks in Track.attach)
// ---------------------------------------------------------------------------

if (!g.HTMLElement) {
  g.HTMLElement = class HTMLElement {
    constructor() {
      this.style = {};
      this.dataset = {};
      this.childNodes = [];
      this.attributes = {};
    }
    setAttribute(k, v) { this.attributes[k] = v; }
    getAttribute(k) { return this.attributes[k] || null; }
    removeAttribute(k) { delete this.attributes[k]; }
    appendChild(c) { this.childNodes.push(c); return c; }
    removeChild(c) { this.childNodes = this.childNodes.filter(n => n !== c); return c; }
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() { return true; }
  };
}

if (!g.HTMLMediaElement) {
  g.HTMLMediaElement = class HTMLMediaElement extends g.HTMLElement {
    constructor() {
      super();
      this.srcObject = null;
      this.src = '';
      this.muted = false;
      this.volume = 1;
      this.paused = true;
      this.autoplay = false;
      this.playbackRate = 1;
      this.currentTime = 0;
      this.duration = 0;
      this.readyState = 0;
    }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    load() {}
    setSinkId() { return Promise.resolve(); }
  };
}

if (!g.HTMLAudioElement) {
  g.HTMLAudioElement = class HTMLAudioElement extends g.HTMLMediaElement {
    constructor() { super(); }
  };
}

if (!g.HTMLVideoElement) {
  g.HTMLVideoElement = class HTMLVideoElement extends g.HTMLMediaElement {
    constructor() {
      super();
      this.width = 0;
      this.height = 0;
      this.videoWidth = 0;
      this.videoHeight = 0;
      this.playsInline = true;
    }
  };
}

if (!g.Audio) {
  g.Audio = g.HTMLAudioElement;
}

// ---------------------------------------------------------------------------
// document (createElement, getElementById, body, visibilityState, cookie)
// ---------------------------------------------------------------------------

if (!g.document) {
  const _elementsById = {};
  g.document = {
    visibilityState: 'visible',
    hidden: false,
    cookie: '',
    body: {
      append() {},
      appendChild() {},
      removeChild() {},
      addEventListener() {},
      removeEventListener() {},
    },
    createElement(tag) {
      const t = (tag || '').toLowerCase();
      if (t === 'audio') return new g.HTMLAudioElement();
      if (t === 'video') return new g.HTMLVideoElement();
      return new g.HTMLElement();
    },
    getElementById(id) { return _elementsById[id] || null; },
    addEventListener() {},
    removeEventListener() {},
  };
}

// ---------------------------------------------------------------------------
// window (addEventListener, removeEventListener, AudioContext)
// ---------------------------------------------------------------------------

if (typeof g.addEventListener !== 'function') {
  g.addEventListener = function() {};
}
if (typeof g.removeEventListener !== 'function') {
  g.removeEventListener = function() {};
}

// Alias window to globalThis for code that checks `typeof window !== 'undefined'`
if (!g.window) {
  g.window = g;
}

// ---------------------------------------------------------------------------
// AudioContext stub (livekit-client creates one for reduced audio latency)
// ---------------------------------------------------------------------------

if (!g.AudioContext && !g.webkitAudioContext) {
  class StubAnalyser {
    connect() { return this; }
    disconnect() {}
    getFloatTimeDomainData() {}
    getByteTimeDomainData() {}
    getFloatFrequencyData() {}
    getByteFrequencyData() {}
  }

  g.AudioContext = class AudioContext {
    constructor() {
      this.state = 'running';
      this.sampleRate = 48000;
      this.currentTime = 0;
      this.destination = { channelCount: 2 };
      this.listener = {};
    }
    createAnalyser() { return new StubAnalyser(); }
    createMediaStreamSource() {
      return { connect() { return this; }, disconnect() {} };
    }
    createGain() {
      return {
        gain: { value: 1, setValueAtTime() {} },
        connect() { return this; },
        disconnect() {},
      };
    }
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  };
}

// ---------------------------------------------------------------------------
// navigator.mediaDevices stubs (addEventListener, getSupportedConstraints)
// ---------------------------------------------------------------------------

if (!g.navigator) {
  g.navigator = {};
}
if (!g.navigator.mediaDevices) {
  g.navigator.mediaDevices = {};
}
const md = g.navigator.mediaDevices;
if (typeof md.addEventListener !== 'function') {
  md.addEventListener = function() {};
}
if (typeof md.removeEventListener !== 'function') {
  md.removeEventListener = function() {};
}
if (typeof md.getSupportedConstraints !== 'function') {
  md.getSupportedConstraints = function() { return {}; };
}

// ---------------------------------------------------------------------------
// location.href (livekit-client reads it for logging)
// ---------------------------------------------------------------------------

if (!g.location) {
  g.location = { href: 'react-native://app', protocol: 'https:', host: 'localhost' };
}
