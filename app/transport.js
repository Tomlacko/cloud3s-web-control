/*
 * WebHID transport for the Cloud III S dongle.
 *
 * - Finds the HID collection that declares output report 0x0C (on Windows the
 *   dongle exposes six top-level collections; Chrome merges them into one
 *   HIDDevice and routes sendReport() by report id).
 * - Serialises requests: one packet in flight, matched to its reply by opcode.
 * - Re-emits every input report as an 'input' event with the report id put
 *   back in front, so byte offsets match docs/PROTOCOL.md.
 */
(function (root) {
  'use strict';
  const HX = root.HX;

  function reportBytes(report) {
    let bits = 0;
    for (const item of report.items || []) bits += (item.reportSize || 0) * (item.reportCount || 0);
    return Math.ceil(bits / 8);
  }

  function describeCollections(device) {
    const rows = [];
    const walk = (cols, depth) => {
      for (const c of cols || []) {
        rows.push({
          depth,
          usagePage: c.usagePage,
          usage: c.usage,
          input: (c.inputReports || []).map((r) => ({ id: r.reportId, bytes: reportBytes(r) })),
          output: (c.outputReports || []).map((r) => ({ id: r.reportId, bytes: reportBytes(r) })),
          feature: (c.featureReports || []).map((r) => ({ id: r.reportId, bytes: reportBytes(r) })),
        });
        walk(c.children, depth + 1);
      }
    };
    walk(device.collections, 0);
    return rows;
  }

  function findReport(device, kind, id) {
    let found = null;
    const walk = (cols) => {
      for (const c of cols || []) {
        for (const r of c[kind] || []) if (r.reportId === id && !found) found = { collection: c, report: r };
        walk(c.children);
      }
    };
    walk(device.collections);
    return found;
  }

  class HeadsetTransport extends EventTarget {
    constructor(device, opts = {}) {
      super();
      this.device = device;
      this.replyTimeout = opts.replyTimeout || 1000;
      this.ackTimeout = opts.ackTimeout || 300;
      this.gapMs = opts.gapMs == null ? 15 : opts.gapMs;
      this._chain = Promise.resolve();
      this._pending = null;
      this._onInput = this._onInput.bind(this);
      this.analyze();
    }

    static isSupported() {
      return typeof navigator !== 'undefined' && !!navigator.hid;
    }

    static filters(any) {
      if (any) return [{ vendorId: HX.VID }];
      return Object.keys(HX.PRODUCTS).map((pid) => ({ vendorId: HX.VID, productId: Number(pid) }));
    }

    static isKnown(device) {
      return device.vendorId === HX.VID && HX.PRODUCTS[device.productId] != null;
    }

    // Prefer the HIDDevice (an interface) that carries output report 0x0C.
    static pickBest(devices) {
      const withCmd = devices.find((d) => findReport(d, 'outputReports', HX.REPORT.CMD));
      return withCmd || devices.find((d) => HeadsetTransport.isKnown(d)) || devices[0] || null;
    }

    analyze() {
      const d = this.device;
      this.collections = describeCollections(d);
      const out = findReport(d, 'outputReports', HX.REPORT.CMD);
      const feat = findReport(d, 'featureReports', HX.REPORT.CMD);
      this.cmdCollection = out ? out.collection : feat ? feat.collection : null;
      this.mode = out ? 'output' : feat ? 'feature' : 'output-blind';
      const r = out ? out.report : feat ? feat.report : null;
      this.dataLen = r ? reportBytes(r) || HX.PACKET_LEN - 1 : HX.PACKET_LEN - 1;
      return this;
    }

    get opened() {
      return this.device.opened;
    }

    async open() {
      if (!this.device.opened) await this.device.open();
      this.device.removeEventListener('inputreport', this._onInput);
      this.device.addEventListener('inputreport', this._onInput);
      this.analyze();
    }

    async close() {
      this.device.removeEventListener('inputreport', this._onInput);
      if (this._pending) this._settle(null);
      if (this.device.opened) await this.device.close();
    }

    _onInput(e) {
      const data = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
      const pkt = new Uint8Array(data.length + 1);
      pkt[0] = e.reportId;
      pkt.set(data, 1);
      const parsed = HX.parseInput(pkt);
      this.dispatchEvent(new CustomEvent('input', { detail: { pkt, parsed } }));
      const p = this._pending;
      if (p && parsed.kind === 'reply' && parsed.op === p.op && pkt[3] === p.rw) this._settle(parsed);
    }

    _settle(value) {
      const p = this._pending;
      if (!p) return;
      this._pending = null;
      clearTimeout(p.timer);
      p.resolve(value);
    }

    // Low-level write. `pkt` includes the report id.
    async write(pkt, { feature = false } = {}) {
      const id = pkt[0];
      let data = pkt.slice(1);
      if (id === HX.REPORT.CMD && data.length !== this.dataLen) {
        const d2 = new Uint8Array(this.dataLen);
        d2.set(data.slice(0, this.dataLen));
        data = d2;
      }
      const useFeature = feature || (id === HX.REPORT.CMD && this.mode === 'feature');
      this.dispatchEvent(new CustomEvent('output', { detail: { pkt: Uint8Array.of(id, ...data), feature: useFeature } }));
      if (useFeature) await this.device.sendFeatureReport(id, data);
      else await this.device.sendReport(id, data);
    }

    /*
     * Send a 0x0C command and wait for its reply.
     * Resolves to the parsed reply, or null on timeout. Rejects on write errors.
     */
    request(pkt, opts = {}) {
      const run = () => this._request(pkt, opts);
      const p = this._chain.then(run, run);
      this._chain = p.catch(() => {});
      return p;
    }

    async _request(pkt, { timeout, feature = false, expectReply = true } = {}) {
      if (!this.device.opened) throw new Error('Device is not open');
      const rw = pkt[3];
      const op = pkt[5];
      const wait = timeout != null ? timeout : rw === HX.RW.GET ? this.replyTimeout : this.ackTimeout;
      let promise = Promise.resolve(null);
      if (expectReply && pkt[0] === HX.REPORT.CMD && wait > 0) {
        promise = new Promise((resolve) => {
          this._pending = { op, rw, resolve, timer: setTimeout(() => this._settle(null), wait) };
        });
      }
      try {
        await this.write(pkt, { feature });
      } catch (err) {
        this._settle(null);
        throw err;
      }
      const reply = await promise;
      if (this.gapMs) await new Promise((r) => setTimeout(r, this.gapMs));
      return reply;
    }

    // Queue a raw write (any report id) behind pending requests.
    rawWrite(pkt, opts = {}) {
      const run = () => this.write(pkt, opts);
      const p = this._chain.then(run, run);
      this._chain = p.catch(() => {});
      return p;
    }

    async readFeature(reportId) {
      const dv = await this.device.receiveFeatureReport(reportId);
      return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    }
  }

  root.HeadsetTransport = HeadsetTransport;
  root.HXTransportUtil = { reportBytes, describeCollections, findReport };
})(typeof window !== 'undefined' ? window : globalThis);
