/*
 * HyperX Cloud III S Wireless - HID protocol
 *
 * Everything here was taken from HyperX's own software:
 *   - NGENUITY "Legacy" 2.35 (NGenuity2Helper.exe, .NET, decompiled):
 *       NGenuity2.Devices.Headset.Cloud3SWireless.*  and  HeadsetCloud3SWireless.cs
 *   - NGENUITY 3.1.0 (hxn-srv-communication-hub.exe, Rust, disassembled):
 *       the 0x0C packet builders and the dispatcher that maps each
 *       "universal" command to them.
 * See docs/PROTOCOL.md for the full write-up.
 *
 * Packet layout (output report 0x0C, 64 bytes including the report id):
 *   [0] 0x0C  report id
 *   [1] 0x02
 *   [2] 0x03
 *   [3] 0x00 = write/set, 0x01 = read/get
 *   [4] 0x00
 *   [5] opcode
 *   [6..] arguments
 * Replies come back as input report 0x0C with the same header, the opcode in
 * byte 5 and the value from byte 6 on (0xFF in byte 6 = "no value").
 * Unsolicited events come back as input report 0x0D: byte 4 = type, byte 5 = value.
 *
 * Works as a plain <script> in the browser (window.HX) and as a CommonJS module.
 */
(function (root) {
  'use strict';

  const VID = 0x03f0;

  const PRODUCTS = {
    0x06be: { name: 'Cloud III S Wireless (2.4 GHz dongle, rev. 1)', kind: 'dongle', tested: 'NGENUITY Legacy + 3' },
    0x02cc: { name: 'Cloud III S Wireless (2.4 GHz dongle, rev. 2)', kind: 'dongle', tested: 'NGENUITY 3' },
    0x05be: { name: 'Cloud III S Wireless (USB-C cable, rev. 1)', kind: 'wired', tested: 'firmware-update only in NGENUITY' },
    0x01cc: { name: 'Cloud III S Wireless (USB-C cable, rev. 2)', kind: 'wired', tested: 'firmware-update only in NGENUITY' },
  };

  const REPORT = { CMD: 0x0c, NOTIFY: 0x0d, BUTTONS: 0x0f };
  const RW = { SET: 0x00, GET: 0x01 };
  const PACKET_LEN = 64; // including the report id

  // Opcodes. `src`: where it was found.
  //   L  = NGENUITY Legacy 2.35 (implemented and used for this headset)
  //   Ld = NGENUITY Legacy 2.35 (command class exists, never called)
  //   N3 = NGENUITY 3.1.0 communication hub
  const OP = {
    SET_MIC_MUTE: 0x01,
    GET_LINK: 0x02,
    GET_MIC_MUTE: 0x04,
    GET_BATTERY: 0x06,
    SET_VOICE_PROMPT: 0x0b,
    SET_SIDETONE: 0x0d,
    SET_EQ_SLOT: 0x0f,
    GET_VOICE_PROMPT: 0x14,
    GET_SIDETONE: 0x16,
    GET_EQ_SLOT: 0x1c,
    GET_MIC_BOOM: 0x43,
    SET_SIDETONE_LEVEL: 0x44,
    GET_SIDETONE_LEVEL: 0x45,
    SET_PLAYBACK_MUTE: 0x46,
    GET_PLAYBACK_MUTE: 0x47,
    GET_CHARGING: 0x48,
    GET_INFO: 0x49,
    SET_AUTO_OFF: 0x4a,
    GET_AUTO_OFF: 0x4b,
    GET_COLOR: 0x4d,
    SET_EQ_BAND: 0x5f,
  };

  const OP_INFO = {
    [OP.SET_MIC_MUTE]: { rw: RW.SET, name: 'Set microphone mute', args: 'mute (0/1)', src: 'L, N3' },
    [OP.GET_LINK]: { rw: RW.GET, name: 'Get headset link', reply: '2 = headset connected to dongle', src: 'L, N3' },
    [OP.GET_MIC_MUTE]: { rw: RW.GET, name: 'Get microphone mute', reply: '1 = muted', src: 'L, N3' },
    [OP.GET_BATTERY]: { rw: RW.GET, name: 'Get battery', reply: 'percent', src: 'L, N3' },
    [OP.SET_VOICE_PROMPT]: { rw: RW.SET, name: 'Set voice prompts', args: 'on (0/1)', src: 'L, N3' },
    [OP.SET_SIDETONE]: { rw: RW.SET, name: 'Set sidetone (mic monitoring)', args: 'on (0/1)', src: 'L, N3' },
    [OP.SET_EQ_SLOT]: { rw: RW.SET, name: 'Set onboard EQ slot', args: 'index 0-5', src: 'Ld, N3' },
    [OP.GET_VOICE_PROMPT]: { rw: RW.GET, name: 'Get voice prompts', reply: '1 = on', src: 'L, N3' },
    [OP.GET_SIDETONE]: { rw: RW.GET, name: 'Get sidetone', reply: '1 = on', src: 'L, N3' },
    [OP.GET_EQ_SLOT]: { rw: RW.GET, name: 'Get onboard EQ slot', reply: 'index', src: 'Ld, N3' },
    [OP.GET_MIC_BOOM]: { rw: RW.GET, name: 'Get mic boom status', reply: 'raw', src: 'Ld' },
    [OP.SET_SIDETONE_LEVEL]: { rw: RW.SET, name: 'Set sidetone level', args: 'signed byte (min -6)', src: 'N3' },
    [OP.GET_SIDETONE_LEVEL]: { rw: RW.GET, name: 'Get sidetone level', reply: 'signed byte', src: 'N3' },
    [OP.SET_PLAYBACK_MUTE]: { rw: RW.SET, name: 'Set playback mute', args: 'mute (0/1)', src: 'Ld, N3' },
    [OP.GET_PLAYBACK_MUTE]: { rw: RW.GET, name: 'Get playback mute', reply: '1 = muted', src: 'N3' },
    [OP.GET_CHARGING]: { rw: RW.GET, name: 'Get charging state', reply: '0 no, 1 charging, 2 full', src: 'L' },
    [OP.GET_INFO]: { rw: RW.GET, name: 'Get headset information', reply: 'raw', src: 'Ld' },
    [OP.SET_AUTO_OFF]: { rw: RW.SET, name: 'Set auto power-off', args: 'seconds, 16-bit big-endian (0 = never)', src: 'L, N3' },
    [OP.GET_AUTO_OFF]: { rw: RW.GET, name: 'Get auto power-off', reply: 'seconds, 16-bit big-endian', src: 'L, N3' },
    [OP.GET_COLOR]: { rw: RW.GET, name: 'Get color code', reply: 'SKU color', src: 'L, N3' },
    [OP.SET_EQ_BAND]: { rw: RW.SET, name: 'Set EQ band gain', args: 'band, gain hi, gain lo, de-pop', src: 'L, N3' },
  };

  // Notification types (input report 0x0D, byte 4). From NGENUITY Legacy's
  // HeadsetCloud3SWireless.HandleDeviceNotification.
  const NOTIFY = {
    BATTERY: 1,
    MIC_MUTE: 3,
    SIDETONE: 5,
    CHARGING: 10,
    LINK: 12,
  };

  // CommunicationHub.SKUColor (NGENUITY 3). Legacy only knew 0-2.
  const COLORS = {
    0: 'Black', 1: 'White', 2: 'Black / Red', 3: 'Black / Blue', 4: 'Black / Green',
    5: 'White / Pink', 6: 'White / Blue', 7: 'White / Green', 8: 'Gray / Green',
    9: 'Black / White', 10: 'Silver / Black', 11: 'Blue / Black', 12: 'White / Purple',
    13: 'White / Black', 14: 'Black / Purple', 15: 'Gray / Red', 16: 'Purple',
    22: 'White / Silver',
  };

  const CHARGING = { 0: 'Not charging', 1: 'Charging', 2: 'Fully charged' };

  const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  // NGENUITY 3 limits the Cloud III S onboard EQ to +-8 dB. The wire format is
  // a signed 16-bit value in hundredths of a dB.
  const EQ_OFFICIAL_RANGE = 8;

  // NGENUITY 3 only offers these; it silently replaces anything else with 1200.
  const AUTO_OFF_PRESETS = [0, 600, 1200, 1800];

  // NGENUITY 3: slider index i -> byte (250 + i) & 0xFF, i.e. a signed byte
  // starting at -6.
  const SIDETONE_LEVEL_MIN = -6;

  function hex(n, w = 2) {
    return (n >>> 0).toString(16).toUpperCase().padStart(w, '0');
  }

  function hexBytes(bytes, max) {
    const a = Array.from(bytes.slice(0, max == null ? bytes.length : max));
    return a.map((b) => hex(b)).join(' ');
  }

  // Trim trailing zero bytes for readable logs (keeps at least `min` bytes).
  function hexTrim(bytes, min = 8) {
    let end = bytes.length;
    while (end > min && bytes[end - 1] === 0) end--;
    return hexBytes(bytes.slice(0, end)) + (end < bytes.length ? ' …' : '');
  }

  function parseHex(str) {
    const clean = String(str).replace(/0x/gi, '').replace(/[^0-9a-f]/gi, ' ').trim();
    if (!clean) return [];
    const parts = clean.split(/\s+/);
    const out = [];
    for (const p of parts) {
      if (p.length > 2) {
        if (p.length % 2) throw new Error(`Odd-length hex token "${p}"`);
        for (let i = 0; i < p.length; i += 2) out.push(parseInt(p.slice(i, i + 2), 16));
      } else {
        out.push(parseInt(p, 16));
      }
    }
    if (out.some((b) => Number.isNaN(b) || b < 0 || b > 255)) throw new Error('Bad hex');
    return out;
  }

  function s8(b) {
    return b > 127 ? b - 256 : b;
  }

  function u8(n) {
    return ((n % 256) + 256) % 256;
  }

  // Full packet including the report id.
  function buildPacket(rw, op, args = [], len = PACKET_LEN) {
    const p = new Uint8Array(len);
    p[0] = REPORT.CMD;
    p[1] = 0x02;
    p[2] = 0x03;
    p[3] = rw;
    p[4] = 0x00;
    p[5] = op;
    for (let i = 0; i < args.length && 6 + i < len; i++) p[6 + i] = u8(args[i]);
    return p;
  }

  const get = (op) => buildPacket(RW.GET, op);
  const set = (op, args) => buildPacket(RW.SET, op, args);

  const cmd = {
    getLink: () => get(OP.GET_LINK),
    getBattery: () => get(OP.GET_BATTERY),
    getCharging: () => get(OP.GET_CHARGING),
    getColor: () => get(OP.GET_COLOR),
    getMicMute: () => get(OP.GET_MIC_MUTE),
    getSidetone: () => get(OP.GET_SIDETONE),
    getSidetoneLevel: () => get(OP.GET_SIDETONE_LEVEL),
    getVoicePrompt: () => get(OP.GET_VOICE_PROMPT),
    getAutoOff: () => get(OP.GET_AUTO_OFF),
    getPlaybackMute: () => get(OP.GET_PLAYBACK_MUTE),
    getEqSlot: () => get(OP.GET_EQ_SLOT),
    getMicBoom: () => get(OP.GET_MIC_BOOM),
    getInfo: () => get(OP.GET_INFO),

    setMicMute: (on) => set(OP.SET_MIC_MUTE, [on ? 1 : 0]),
    setSidetone: (on) => set(OP.SET_SIDETONE, [on ? 1 : 0]),
    setVoicePrompt: (on) => set(OP.SET_VOICE_PROMPT, [on ? 1 : 0]),
    setPlaybackMute: (on) => set(OP.SET_PLAYBACK_MUTE, [on ? 1 : 0]),
    setEqSlot: (i) => set(OP.SET_EQ_SLOT, [i]),
    // level is a signed value, -128..127 (NGENUITY 3 starts its slider at -6)
    setSidetoneLevel: (level) => {
      if (!Number.isInteger(level) || level < -128 || level > 127) throw new RangeError('sidetone level must be -128..127');
      return set(OP.SET_SIDETONE_LEVEL, [u8(level)]);
    },
    // seconds: 0 = never, max 65535
    setAutoOff: (seconds) => {
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 0xffff) throw new RangeError('auto-off must be 0..65535 seconds');
      return set(OP.SET_AUTO_OFF, [seconds >> 8, seconds & 0xff]);
    },
    // band 0-9, gainDb e.g. -3.5. depop = NGENUITY 3's "withDepop" flag,
    // sent in byte 9 of the last band packet of a batch.
    setEqBand: (band, gainDb, depop = false) => {
      if (!Number.isInteger(band) || band < 0 || band > 9) throw new RangeError('band must be 0..9');
      let centi = Math.round(gainDb * 100);
      centi = Math.max(-32768, Math.min(32767, centi));
      const v = centi & 0xffff;
      return set(OP.SET_EQ_BAND, [band, v >> 8, v & 0xff, depop ? 1 : 0]);
    },
  };

  // Packets for a whole 10-band curve. NGENUITY sends one packet per band
  // (the firmware ignores extra bands in one packet).
  function eqPackets(gainsDb, depop = false) {
    const out = [];
    for (let i = 0; i < gainsDb.length; i++) {
      out.push(cmd.setEqBand(i, gainsDb[i], depop && i === gainsDb.length - 1));
    }
    return out;
  }

  function parseAutoOff(hi, lo) {
    const s = (hi << 8) | lo;
    return s;
  }

  function describeAutoOff(seconds) {
    if (seconds === 0) return 'Never';
    if (seconds % 60 === 0) return `${seconds / 60} min`;
    if (seconds >= 60) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
    return `${seconds} s`;
  }

  /*
   * Decode an input report. `pkt` is the full report including the id
   * (WebHID strips it, so the caller must prepend it).
   * Returns { kind, ... } - never throws.
   */
  function parseInput(pkt) {
    const id = pkt[0];
    if (id === REPORT.CMD && pkt.length >= 7) {
      const op = pkt[5];
      const v = pkt[6];
      const base = { kind: 'reply', op, rw: pkt[3], raw: pkt, value: v, noValue: v === 0xff };
      const info = OP_INFO[op];
      base.name = info ? info.name : `opcode 0x${hex(op)}`;
      if (pkt[1] !== 0x02 || pkt[2] !== 0x03) base.unusualHeader = true;
      if (pkt[3] === RW.SET) {
        base.ack = true;
        return base;
      }
      if (base.noValue && op !== OP.GET_SIDETONE_LEVEL && op !== OP.GET_AUTO_OFF) return base;
      switch (op) {
        case OP.GET_LINK:
          return Object.assign(base, { field: 'link', parsed: v === 2, text: v === 2 ? 'Connected' : `Not connected (${v})` });
        case OP.GET_MIC_MUTE:
          return Object.assign(base, { field: 'micMute', parsed: v === 1, text: v === 1 ? 'Muted' : 'Live' });
        case OP.GET_BATTERY:
          return Object.assign(base, { field: 'battery', parsed: v, text: `${v} %`, extra: (pkt[7] << 8) | pkt[8] });
        case OP.GET_VOICE_PROMPT:
          return Object.assign(base, { field: 'voicePrompt', parsed: v === 1, text: v === 1 ? 'On' : 'Off' });
        case OP.GET_SIDETONE:
          return Object.assign(base, { field: 'sidetone', parsed: v === 1, text: v === 1 ? 'On' : 'Off' });
        case OP.GET_EQ_SLOT:
          return Object.assign(base, { field: 'eqSlot', parsed: v, text: String(v) });
        case OP.GET_MIC_BOOM:
          return Object.assign(base, { field: 'micBoom', parsed: v, text: `raw ${v}` });
        case OP.GET_SIDETONE_LEVEL:
          if (base.noValue) return Object.assign(base, { field: 'sidetoneLevel', parsed: -1, text: '-1 (0xFF, may also mean "unsupported")' });
          return Object.assign(base, { field: 'sidetoneLevel', parsed: s8(v), text: String(s8(v)) });
        case OP.GET_PLAYBACK_MUTE:
          return Object.assign(base, { field: 'playbackMute', parsed: v === 1, text: v === 1 ? 'Muted' : 'Not muted' });
        case OP.GET_CHARGING:
          return Object.assign(base, { field: 'charging', parsed: v, text: CHARGING[v] || `Unknown (${v})` });
        case OP.GET_INFO:
          return Object.assign(base, { field: 'info', parsed: Array.from(pkt.slice(6, 22)), text: hexTrim(pkt.slice(6, 38), 1) });
        case OP.GET_AUTO_OFF: {
          const s = parseAutoOff(pkt[6], pkt[7]);
          if (s === 0xffff) return Object.assign(base, { noValue: true });
          return Object.assign(base, { field: 'autoOff', parsed: s, text: `${describeAutoOff(s)} (${s} s)`, noValue: false });
        }
        case OP.GET_COLOR:
          return Object.assign(base, { field: 'color', parsed: v, text: COLORS[v] || `Unknown (${v})` });
        default:
          return base;
      }
    }
    if (id === REPORT.NOTIFY && pkt.length >= 6) {
      const type = pkt[4];
      const v = pkt[5];
      const base = { kind: 'notify', type, value: v, raw: pkt };
      switch (type) {
        case NOTIFY.BATTERY:
          return Object.assign(base, { field: 'battery', parsed: v, text: `Battery ${v} %` });
        case NOTIFY.MIC_MUTE:
          return Object.assign(base, { field: 'micMute', parsed: v === 1, text: v === 1 ? 'Mic muted' : 'Mic unmuted' });
        case NOTIFY.SIDETONE:
          return Object.assign(base, { field: 'sidetone', parsed: v === 1, text: v === 1 ? 'Sidetone on' : 'Sidetone off' });
        case NOTIFY.CHARGING:
          return Object.assign(base, { field: 'charging', parsed: v, text: CHARGING[v] || `Charging state ${v}` });
        case NOTIFY.LINK:
          return Object.assign(base, { field: 'link', parsed: v === 1, text: v === 1 ? 'Headset connected' : 'Headset disconnected' });
        default:
          return Object.assign(base, { text: `Unknown notification type ${type}, value ${v}` });
      }
    }
    if (id === REPORT.BUTTONS) {
      const b = pkt[1] || 0;
      const names = [];
      if (b & 0x01) names.push('Volume up');
      if (b & 0x02) names.push('Volume down');
      if (b & 0x08) names.push('Play/pause');
      if (b & ~0x0b) names.push(`0x${hex(b & ~0x0b)}`);
      return { kind: 'button', raw: pkt, value: b, text: names.length ? names.join(' + ') : 'Released' };
    }
    return { kind: 'other', raw: pkt, text: `Report 0x${hex(id)}` };
  }

  const HX = {
    VID, PRODUCTS, REPORT, RW, OP, OP_INFO, NOTIFY, COLORS, CHARGING, EQ_BANDS, EQ_OFFICIAL_RANGE,
    AUTO_OFF_PRESETS, SIDETONE_LEVEL_MIN, PACKET_LEN,
    hex, hexBytes, hexTrim, parseHex, s8, u8, buildPacket, cmd, eqPackets, parseInput, describeAutoOff,
  };

  if (typeof module === 'object' && module.exports) module.exports = HX;
  else root.HX = HX;
})(typeof window !== 'undefined' ? window : globalThis);
