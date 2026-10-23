/*
 * A fake Cloud III S dongle for testing the page without hardware.
 * Injected before the page loads (Playwright addInitScript); replaces
 * navigator.hid. Every packet the page sends is recorded in window.__sent
 * as [reportId, ...data] (feature reports are prefixed with 'F').
 *
 * Behaviour follows docs/PROTOCOL.md: GET replies echo the header with the
 * value in byte 6, SETs are acknowledged with an echo, sidetone changes also
 * raise a 0x0D notification.
 */
(() => {
  const DATA_LEN = 63;

  class FakeDevice extends EventTarget {
    constructor() {
      super();
      this.vendorId = 0x03f0;
      this.productId = 0x06be;
      this.productName = 'HyperX Cloud III S Wireless';
      this.opened = false;
      const items = [{ reportSize: 8, reportCount: DATA_LEN }];
      this.collections = [
        { usagePage: 0x000c, usage: 0x0001, inputReports: [{ reportId: 0x0f, items: [{ reportSize: 8, reportCount: 2 }] }], outputReports: [], featureReports: [], children: [] },
        { usagePage: 0xff13, usage: 0x0001, inputReports: [], outputReports: [{ reportId: 0x66, items }], featureReports: [], children: [] },
        { usagePage: 0x000b, usage: 0x0005, inputReports: [{ reportId: 0x05, items: [{ reportSize: 8, reportCount: 1 }] }], outputReports: [], featureReports: [], children: [] },
        {
          usagePage: 0x01c0, usage: 0x0001,
          inputReports: [{ reportId: 0x0c, items }, { reportId: 0x0d, items }],
          outputReports: [{ reportId: 0x0c, items }],
          featureReports: [], children: [],
        },
      ];
      this.st = {
        link: 2, battery: 87, charging: 0, color: 2, mic: 0, sidetone: 0, stl: 0xfa, vp: 1,
        autoOff: 1200, pbmute: 0, eqslot: 0, boom: 1, eq: new Array(10).fill(0), depop: [],
      };
      this.silent = false;
      window.__sent = [];
    }

    async open() { this.opened = true; }
    async close() { this.opened = false; }
    async forget() { this.forgotten = true; }

    async sendReport(id, data) {
      const d = new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset || 0, (data.byteOffset || 0) + data.byteLength) : data);
      window.__sent.push([id, ...d]);
      if (!this.opened) throw new DOMException('closed', 'InvalidStateError');
      if (id === 0x0c && d.length !== DATA_LEN) throw new DOMException(`bad length ${d.length}`, 'NotAllowedError');
      if (!this.silent) this._handle(id, d);
    }

    async sendFeatureReport(id, data) {
      window.__sent.push(['F', id, ...new Uint8Array(data)]);
    }

    async receiveFeatureReport(id) {
      return new DataView(Uint8Array.of(1, 2, 3, 4).buffer);
    }

    _emit(reportId, bytes) {
      setTimeout(() => {
        const ev = new Event('inputreport');
        ev.reportId = reportId;
        ev.data = new DataView(Uint8Array.from(bytes).buffer);
        ev.device = this;
        this.dispatchEvent(ev);
      }, 4);
    }

    notify(type, value) {
      const r = new Uint8Array(DATA_LEN);
      r[0] = 2; r[1] = 3; r[3] = type; r[4] = value;
      this._emit(0x0d, r);
    }

    button(bits) {
      this._emit(0x0f, [bits, 0]);
    }

    _handle(id, d) {
      if (id !== 0x0c) return;
      // d[i] is packet byte i+1
      const rw = d[2];
      const op = d[4];
      const r = new Uint8Array(DATA_LEN);
      r[0] = 2; r[1] = 3; r[2] = rw; r[3] = 0; r[4] = op;
      const s = this.st;
      if (rw === 1) {
        const map = {
          0x02: [s.link], 0x04: [s.mic], 0x06: [s.battery, 0x0f, 0xa0], 0x14: [s.vp], 0x16: [s.sidetone],
          0x1c: [s.eqslot], 0x43: [s.boom], 0x45: [s.stl], 0x47: [s.pbmute], 0x48: [s.charging],
          0x49: [3, 1, 2, 4, 4, 1, 2, 4], 0x4b: [s.autoOff >> 8, s.autoOff & 0xff], 0x4d: [s.color],
        };
        if (!(op in map)) return; // unknown opcodes stay silent
        if (s.link !== 2 && op !== 0x02) map[op] = [0xff, 0xff];
        map[op].forEach((v, i) => (r[5 + i] = v));
      } else {
        const v = d[5];
        switch (op) {
          case 0x01: s.mic = v; break;
          case 0x0b: s.vp = v; break;
          case 0x0d: s.sidetone = v; this.notify(5, v); break;
          case 0x0f: s.eqslot = v; break;
          case 0x44: s.stl = v; break;
          case 0x46: s.pbmute = v; break;
          case 0x4a: s.autoOff = (d[5] << 8) | d[6]; break;
          case 0x5f: {
            const g = (d[6] << 8) | d[7];
            s.eq[d[5]] = (g > 32767 ? g - 65536 : g) / 100;
            s.depop[d[5]] = d[8];
            break;
          }
          default: return;
        }
        for (let i = 5; i < 9; i++) r[i] = d[i];
      }
      this._emit(0x0c, r);
    }
  }

  const dev = new FakeDevice();
  window.__dev = dev;
  const hid = new EventTarget();
  hid.requestDevice = async () => [dev];
  hid.getDevices = async () => (window.__granted ? [dev] : []);
  Object.defineProperty(Navigator.prototype, 'hid', { get: () => hid, configurable: true });
})();
