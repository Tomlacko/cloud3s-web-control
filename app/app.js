/* Cloud III S Control - UI */
(function () {
  'use strict';
  const HX = window.HX;
  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- storage
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem('hx3s.' + k);
        return v == null ? d : JSON.parse(v);
      } catch (_) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem('hx3s.' + k, JSON.stringify(v));
      } catch (_) { /* private mode etc. */ }
    },
  };

  // ------------------------------------------------------------------- state
  let transport = null;
  let pollTimer = null;
  let scanning = false;
  let plugTimer = null;
  const state = {};

  const NEEDS_CONN = [
    'btnRefresh', 'btnGetAutoOff', 'btnAutoOffCustom', 'btnGetMic', 'tgMicMute', 'tgSidetone', 'slSidetoneLevel',
    'btnGetPlayback', 'tgVoicePrompt', 'tgPlaybackMute', 'btnEqApply', 'btnEqSlotSet', 'btnEqSlotGet',
    'btnRawSend', 'btnRawReport', 'btnRawFeature', 'btnRawGetFeature', 'btnScan', 'btnDisconnect', 'btnForget',
  ];

  // --------------------------------------------------------------------- log
  const logEntries = [];
  const MAX_LOG = 1500;
  const logEl = $('log');

  function ts() {
    const d = new Date();
    return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  function log(cls, text, bytes) {
    const e = { t: ts(), cls, text, hex: bytes ? HX.hexTrim(bytes) : '' };
    logEntries.push(e);
    if (logEntries.length > MAX_LOG) logEntries.splice(0, logEntries.length - MAX_LOG);
    if (visible(e)) {
      logEl.appendChild(renderEntry(e));
      while (logEl.childNodes.length > MAX_LOG) logEl.removeChild(logEl.firstChild);
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  function visible(e) {
    if (e.cls === 'tx') return $('logTx').checked;
    if (e.cls === 'rx') return $('logRx').checked;
    if (e.cls === 'ev') return $('logEv').checked;
    return true;
  }

  function renderEntry(e) {
    const div = document.createElement('div');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = e.t + ' ';
    const m = document.createElement('span');
    m.className = e.cls;
    const arrow = { tx: '→ ', rx: '← ', ev: '★ ', er: '✖ ', in: '· ' }[e.cls] || '';
    m.textContent = arrow + e.text + ($('logHex').checked && e.hex ? '   [' + e.hex + ']' : '');
    div.append(t, m);
    return div;
  }

  function rerenderLog() {
    logEl.textContent = '';
    const frag = document.createDocumentFragment();
    for (const e of logEntries) if (visible(e)) frag.appendChild(renderEntry(e));
    logEl.appendChild(frag);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ---------------------------------------------------------------- helpers
  function setText(id, text, cls) {
    const el = $(id);
    el.textContent = text;
    el.classList.remove('ok', 'bad');
    if (cls) el.classList.add(cls);
  }

  function setSwitch(id, value) {
    const el = $(id);
    el.checked = !!value;
    el.closest('.switch').classList.toggle('unknown', value == null);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function opName(op) {
    const i = HX.OP_INFO[op];
    return i ? i.name : 'opcode 0x' + HX.hex(op);
  }

  function parseHexByte(str, what) {
    const v = parseInt(String(str).replace(/^0x/i, ''), 16);
    if (Number.isNaN(v) || v < 0 || v > 255) throw new Error(`${what}: enter a hex byte (00-FF)`);
    return v;
  }

  // -------------------------------------------------------- apply a reading
  function apply(p) {
    if (!p || !p.field) return;
    state[p.field] = p.parsed;
    switch (p.field) {
      case 'battery': {
        const v = p.parsed;
        setText('stBattery', v <= 100 ? `${v} %` : `? (${v})`);
        const fill = $('battFill');
        fill.style.width = Math.max(0, Math.min(100, v)) + '%';
        fill.className = v <= 15 ? 'low' : v <= 35 ? 'mid' : '';
        break;
      }
      case 'charging':
        setText('stCharging', HX.CHARGING[p.parsed] || `state ${p.parsed}`);
        break;
      case 'link':
        setText('stLink', p.parsed ? 'Headset connected' : 'Headset off / not paired', p.parsed ? 'ok' : 'bad');
        updatePill();
        break;
      case 'color':
        setText('stColor', p.text);
        break;
      case 'micMute':
        setSwitch('tgMicMute', p.parsed);
        break;
      case 'sidetone':
        setSwitch('tgSidetone', p.parsed);
        break;
      case 'sidetoneLevel':
        setText('stSidetoneLevel', p.text);
        if (p.parsed >= -128 && p.parsed <= 127) {
          const sl = $('slSidetoneLevel');
          if (p.parsed < +sl.min || p.parsed > +sl.max) {
            $('sidetoneExt').checked = true;
            sidetoneRange();
          }
          sl.value = p.parsed;
          $('outSidetoneLevel').textContent = p.parsed;
        }
        break;
      case 'voicePrompt':
        setSwitch('tgVoicePrompt', p.parsed);
        break;
      case 'playbackMute':
        setSwitch('tgPlaybackMute', p.parsed);
        break;
      case 'autoOff':
        setText('stAutoOff', p.text);
        document.querySelectorAll('#autoOffSeg button').forEach((b) => b.classList.toggle('active', +b.dataset.sec === p.parsed));
        break;
      case 'eqSlot':
        setText('stEqSlot', String(p.parsed));
        break;
      case 'micBoom':
        setText('stMicBoom', p.text);
        break;
      case 'info':
        setText('stInfo', p.text || '—');
        break;
    }
  }

  function updatePill() {
    const pill = $('connPill');
    if (!transport) {
      pill.textContent = 'Not connected';
      pill.className = 'pill off';
    } else if (state.link === false) {
      pill.textContent = 'Dongle only (headset off)';
      pill.className = 'pill partial';
    } else {
      pill.textContent = 'Connected';
      pill.className = 'pill on';
    }
  }

  // ---------------------------------------------------------------- requests
  async function req(pkt, quiet) {
    if (!transport) return null;
    try {
      const r = await transport.request(pkt);
      if (!r && !quiet && pkt[3] === HX.RW.GET) log('in', `No reply to ${opName(pkt[5])}`);
      if (r && r.noValue && !quiet) log('in', `${opName(pkt[5])}: no value (headset off or not supported)`);
      return r;
    } catch (err) {
      log('er', `${opName(pkt[5])} failed: ${err.message || err}`);
      return null;
    }
  }

  const FULL_READ = [
    HX.cmd.getLink, HX.cmd.getBattery, HX.cmd.getCharging, HX.cmd.getColor, HX.cmd.getMicMute,
    HX.cmd.getSidetone, HX.cmd.getSidetoneLevel, HX.cmd.getVoicePrompt, HX.cmd.getAutoOff,
    HX.cmd.getPlaybackMute, HX.cmd.getEqSlot, HX.cmd.getMicBoom, HX.cmd.getInfo,
  ];

  async function refreshAll() {
    if (!transport) return;
    const btn = $('btnRefresh');
    btn.disabled = true;
    try {
      const link = await req(HX.cmd.getLink());
      if (!link) {
        log('er', 'The dongle did not answer. Is the headset on? Is NGENUITY closed? Try replugging the dongle.');
      }
      for (const make of FULL_READ.slice(1)) {
        if (!transport) break;
        await req(make(), true);
      }
      log('in', 'Refreshed all values');
    } finally {
      btn.disabled = !transport;
    }
  }

  async function poll() {
    if (!transport || scanning) return;
    await req(HX.cmd.getLink(), true);
    await req(HX.cmd.getBattery(), true);
    await req(HX.cmd.getCharging(), true);
  }

  function setPoll() {
    const s = +$('pollInterval').value;
    store.set('poll', s);
    clearInterval(pollTimer);
    pollTimer = s > 0 ? setInterval(poll, s * 1000) : null;
  }

  // Write, then read back so the UI shows what the headset actually kept.
  async function setAndVerify(setPkt, getPkt, label) {
    log('in', label);
    await req(setPkt);
    await sleep(80);
    if (getPkt) await req(getPkt);
  }

  // -------------------------------------------------------------- connection
  function enableControls(on) {
    for (const id of NEEDS_CONN) $(id).disabled = !on;
    $('btnConnect').disabled = on || !HeadsetTransportAvailable();
    $('hint').hidden = on;
  }

  function HeadsetTransportAvailable() {
    return window.HeadsetTransport && window.HeadsetTransport.isSupported();
  }

  function resetState() {
    for (const k of Object.keys(state)) delete state[k];
    ['stBattery', 'stCharging', 'stLink', 'stDevice', 'stColor', 'stMicBoom', 'stInfo', 'stAutoOff', 'stSidetoneLevel', 'stEqSlot']
      .forEach((id) => setText(id, '—'));
    $('battFill').style.width = '0';
    ['tgMicMute', 'tgSidetone', 'tgVoicePrompt', 'tgPlaybackMute'].forEach((id) => setSwitch(id, null));
    document.querySelectorAll('#autoOffSeg button').forEach((b) => b.classList.remove('active'));
  }

  async function useDevice(device) {
    if (transport) await disconnect(true);
    const t = new window.HeadsetTransport(device, {
      replyTimeout: +$('replyTimeout').value || 1000,
      ackTimeout: +$('ackTimeout').value || 0,
    });
    try {
      await t.open();
    } catch (err) {
      log('er', `Could not open ${device.productName || 'device'}: ${err.message || err}`);
      if (/access|denied|NotAllowed/i.test(String(err))) {
        log('in', 'On Linux this usually means missing udev rules (see linux/99-hyperx-cloud3s.rules). On Windows, another app may have it open exclusively.');
      }
      return;
    }
    transport = t;
    t.addEventListener('input', onInput);
    t.addEventListener('output', (e) => {
      const p = e.detail.pkt;
      const what = p[0] === HX.REPORT.CMD ? `${p[3] === HX.RW.GET ? 'GET' : 'SET'} ${opName(p[5])}` : `report 0x${HX.hex(p[0])}`;
      log('tx', what + (e.detail.feature ? ' (feature)' : ''), p);
    });
    const prod = HX.PRODUCTS[device.productId];
    setText('stDevice', `${prod ? prod.name : device.productName} — ${HX.hex(device.vendorId, 4)}:${HX.hex(device.productId, 4)}`);
    log('in', `Opened ${device.productName} (${HX.hex(device.vendorId, 4)}:${HX.hex(device.productId, 4)}), sending via ${t.mode} report, ${t.dataLen + 1} bytes`);
    if (prod && prod.kind === 'wired') {
      log('in', 'This is the headset over USB-C. NGENUITY only uses this connection for firmware updates; control commands may not work here — the dongle is the supported path.');
    }
    if (t.mode === 'output-blind') {
      log('er', 'No collection declares report 0x0C. This is probably not the control interface; commands will most likely fail.');
    }
    renderCollections();
    enableControls(true);
    updatePill();
    setPoll();
    refreshAll();
  }

  async function disconnect(silent) {
    clearInterval(pollTimer);
    pollTimer = null;
    const t = transport;
    transport = null;
    if (t) {
      try {
        await t.close();
      } catch (_) { /* already gone */ }
    }
    resetState();
    enableControls(false);
    updatePill();
    if (!silent) log('in', 'Disconnected');
  }

  async function connectClicked() {
    try {
      const devices = await navigator.hid.requestDevice({ filters: window.HeadsetTransport.filters($('anyDevice').checked) });
      if (!devices.length) return;
      const best = window.HeadsetTransport.pickBest(devices);
      await useDevice(best);
    } catch (err) {
      log('er', `Connect failed: ${err.message || err}`);
    }
  }

  async function tryAutoConnect() {
    if (!$('autoConnect').checked) return;
    try {
      const devs = (await navigator.hid.getDevices()).filter((d) => window.HeadsetTransport.isKnown(d));
      if (devs.length) {
        log('in', 'Reconnecting to a previously allowed device');
        await useDevice(window.HeadsetTransport.pickBest(devs));
      }
    } catch (err) {
      log('er', `Auto-connect failed: ${err.message || err}`);
    }
  }

  function onInput(e) {
    const { pkt, parsed } = e.detail;
    if (parsed.kind === 'reply') {
      let text = `${parsed.ack ? 'ACK' : 'Reply'} ${parsed.name}`;
      if (!parsed.ack) text += parsed.noValue ? ': no value' : parsed.text ? `: ${parsed.text}` : `: ${parsed.value}`;
      log('rx', text, pkt);
      apply(parsed);
    } else if (parsed.kind === 'notify') {
      log('ev', parsed.text, pkt);
      apply(parsed);
      if (parsed.field === 'link' && parsed.parsed) setTimeout(refreshAll, 300);
    } else if (parsed.kind === 'button') {
      log('ev', `Button: ${parsed.text}`, pkt);
    } else {
      log('ev', parsed.text, pkt);
    }
  }

  function renderCollections() {
    const tb = $('colTable').querySelector('tbody');
    tb.textContent = '';
    const fmt = (arr) => arr.map((r) => `0x${HX.hex(r.id)} (${r.bytes} B)`).join(', ') || '—';
    for (const c of transport.collections) {
      const tr = document.createElement('tr');
      const cells = [
        `${'  '.repeat(c.depth)}0x${HX.hex(c.usagePage, 4)}:0x${HX.hex(c.usage, 4)}`,
        fmt(c.input), fmt(c.output), fmt(c.feature),
      ];
      for (const v of cells) {
        const td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      }
      if (c === transport.collections.find((x) => x.output.some((r) => r.id === HX.REPORT.CMD))) tr.style.fontWeight = '700';
      tb.appendChild(tr);
    }
    $('transportInfo').textContent = `Commands go out as ${transport.mode} report 0x0C with ${transport.dataLen} data bytes. Bold = control collection.`;
  }

  // ------------------------------------------------------------- auto power-off
  function bindPower() {
    $('btnGetAutoOff').onclick = () => req(HX.cmd.getAutoOff());
    document.querySelectorAll('#autoOffSeg button').forEach((b) => {
      b.onclick = () => {
        if (!transport) return;
        const s = +b.dataset.sec;
        setAndVerify(HX.cmd.setAutoOff(s), HX.cmd.getAutoOff(), `Setting auto power-off to ${HX.describeAutoOff(s)}`);
      };
    });
    $('btnAutoOffCustom').onclick = () => {
      const n = Number($('autoOffCustom').value);
      const unit = +$('autoOffUnit').value;
      const s = Math.round(n * unit);
      if (!Number.isFinite(s) || s < 0 || s > 65535) {
        log('er', `Custom timer must be 0–65535 seconds (got ${s}). That's at most 1092 minutes.`);
        return;
      }
      setAndVerify(HX.cmd.setAutoOff(s), HX.cmd.getAutoOff(), `Setting auto power-off to ${HX.describeAutoOff(s)} (custom)`);
    };
  }

  // ---------------------------------------------------------- mic / playback
  function bindToggles() {
    const pairs = [
      ['tgMicMute', (v) => HX.cmd.setMicMute(v), HX.cmd.getMicMute, 'mic mute'],
      ['tgSidetone', (v) => HX.cmd.setSidetone(v), HX.cmd.getSidetone, 'sidetone'],
      ['tgVoicePrompt', (v) => HX.cmd.setVoicePrompt(v), HX.cmd.getVoicePrompt, 'voice prompts'],
      ['tgPlaybackMute', (v) => HX.cmd.setPlaybackMute(v), HX.cmd.getPlaybackMute, 'playback mute'],
    ];
    for (const [id, mkSet, mkGet, label] of pairs) {
      $(id).onchange = (e) => {
        const v = e.target.checked;
        e.target.closest('.switch').classList.remove('unknown');
        setAndVerify(mkSet(v), mkGet(), `Turning ${label} ${v ? 'on' : 'off'}`);
      };
    }
    $('btnGetMic').onclick = async () => {
      await req(HX.cmd.getMicMute());
      await req(HX.cmd.getSidetone());
      await req(HX.cmd.getSidetoneLevel());
      await req(HX.cmd.getMicBoom());
    };
    $('btnGetPlayback').onclick = async () => {
      await req(HX.cmd.getVoicePrompt());
      await req(HX.cmd.getPlaybackMute());
    };

    const sl = $('slSidetoneLevel');
    sl.oninput = () => ($('outSidetoneLevel').textContent = sl.value);
    sl.onchange = () => {
      const v = +sl.value;
      setAndVerify(HX.cmd.setSidetoneLevel(v), HX.cmd.getSidetoneLevel(), `Setting sidetone level to ${v}`);
    };
    $('sidetoneExt').onchange = sidetoneRange;
  }

  function sidetoneRange() {
    const sl = $('slSidetoneLevel');
    const ext = $('sidetoneExt').checked;
    sl.min = ext ? -128 : HX.SIDETONE_LEVEL_MIN;
    sl.max = ext ? 127 : 6;
    $('outSidetoneLevel').textContent = sl.value;
  }

  // --------------------------------------------------------------------- EQ
  const BUILTIN_PRESETS = {
    Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    'Janice (NGENUITY 3)': [3.2, 1.9, 0.7, 0.5, 0.9, 3.7, 5.5, 3.0, 0, 0],
    'Vincent / Rainbow Six (NGENUITY 3)': [0, -3, -3, 0, 0, 0, 0, 0, 0, 0],
    'Bass boost': [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
    'Treble boost': [0, 0, 0, 0, 0, 0, 2, 4, 5, 6],
    'V-shape': [5, 4, 2, 0, -2, -2, 0, 2, 4, 5],
    'Voice / chat': [-3, -2, -1, 0, 2, 3, 3, 2, 0, -1],
    'Footsteps (FPS)': [-4, -4, -3, -1, 0, 2, 4, 5, 3, 1],
  };
  let eqCurve = store.get('eq.current', BUILTIN_PRESETS.Flat.slice());
  if (!Array.isArray(eqCurve) || eqCurve.length !== 10) eqCurve = BUILTIN_PRESETS.Flat.slice();
  const eqTimers = {};
  const eqEls = [];

  function eqRange() {
    return $('eqExt').checked ? 12 : HX.EQ_OFFICIAL_RANGE;
  }

  function fmtFreq(f) {
    return f >= 1000 ? f / 1000 + 'k' : String(f);
  }

  function buildEq() {
    const wrap = $('eqBands');
    wrap.textContent = '';
    HX.EQ_BANDS.forEach((f, i) => {
      const band = document.createElement('div');
      band.className = 'band';
      const val = document.createElement('div');
      val.className = 'val';
      const num = document.createElement('input');
      num.type = 'number';
      num.step = '0.1';
      num.setAttribute('aria-label', `${fmtFreq(f)} Hz gain in dB`);
      val.appendChild(num);
      const range = document.createElement('input');
      range.type = 'range';
      range.step = '0.1';
      range.setAttribute('aria-label', `${fmtFreq(f)} Hz`);
      const lab = document.createElement('div');
      lab.className = 'freq';
      lab.textContent = fmtFreq(f) + ' Hz';
      band.append(val, range, lab);
      wrap.appendChild(band);
      eqEls.push({ range, num });
      range.oninput = () => onBand(i, +range.value, 'range');
      num.onchange = () => onBand(i, +num.value, 'num');
    });
    applyEqRange();
  }

  function applyEqRange() {
    const r = eqRange();
    eqEls.forEach(({ range, num }, i) => {
      range.min = num.min = -r;
      range.max = num.max = r;
      eqCurve[i] = Math.max(-r, Math.min(r, eqCurve[i]));
      range.value = eqCurve[i];
      num.value = eqCurve[i].toFixed(1);
    });
  }

  function onBand(i, v, from) {
    const r = eqRange();
    if (!Number.isFinite(v)) v = 0;
    v = Math.round(Math.max(-r, Math.min(r, v)) * 10) / 10;
    eqCurve[i] = v;
    if (from !== 'range') eqEls[i].range.value = v;
    eqEls[i].num.value = v.toFixed(1);
    store.set('eq.current', eqCurve);
    if ($('eqLive').checked && transport) {
      clearTimeout(eqTimers[i]);
      eqTimers[i] = setTimeout(() => req(HX.cmd.setEqBand(i, eqCurve[i], false)), 120);
    }
  }

  function setCurve(vals) {
    eqCurve = vals.slice(0, 10).map((v) => Number(v) || 0);
    while (eqCurve.length < 10) eqCurve.push(0);
    const max = Math.max(...eqCurve.map(Math.abs));
    if (max > HX.EQ_OFFICIAL_RANGE && !$('eqExt').checked) $('eqExt').checked = true;
    applyEqRange();
    store.set('eq.current', eqCurve);
  }

  async function sendCurve() {
    if (!transport) return;
    const depop = $('eqDepop').checked;
    log('in', `Applying EQ: ${eqCurve.map((v) => v.toFixed(1)).join(' / ')} dB`);
    for (const p of HX.eqPackets(eqCurve, depop)) await req(p);
  }

  function userPresets() {
    const u = store.get('eq.user', {});
    return u && typeof u === 'object' ? u : {};
  }

  function fillPresetSelect(selectName) {
    const sel = $('eqPreset');
    sel.textContent = '';
    const ph = new Option('Presets…', '');
    sel.add(ph);
    const g1 = document.createElement('optgroup');
    g1.label = 'Built-in';
    for (const k of Object.keys(BUILTIN_PRESETS)) g1.appendChild(new Option(k, 'b:' + k));
    sel.appendChild(g1);
    const u = userPresets();
    if (Object.keys(u).length) {
      const g2 = document.createElement('optgroup');
      g2.label = 'Saved';
      for (const k of Object.keys(u)) g2.appendChild(new Option(k, 'u:' + k));
      sel.appendChild(g2);
    }
    sel.value = selectName || '';
  }

  function bindEq() {
    buildEq();
    fillPresetSelect();
    $('eqExt').checked = store.get('eq.ext', false) || Math.max(...eqCurve.map(Math.abs)) > HX.EQ_OFFICIAL_RANGE;
    applyEqRange();
    $('eqExt').onchange = () => {
      store.set('eq.ext', $('eqExt').checked);
      applyEqRange();
      store.set('eq.current', eqCurve);
    };
    $('eqPreset').onchange = () => {
      const v = $('eqPreset').value;
      if (!v) return;
      const name = v.slice(2);
      const vals = v[0] === 'b' ? BUILTIN_PRESETS[name] : userPresets()[name];
      if (!vals) return;
      setCurve(vals);
      if ($('eqLive').checked) sendCurve();
    };
    $('btnEqApply').onclick = sendCurve;
    $('btnEqFlat').onclick = () => {
      setCurve(BUILTIN_PRESETS.Flat);
      $('eqPreset').value = 'b:Flat';
      if ($('eqLive').checked) sendCurve();
    };
    $('btnEqSave').onclick = () => {
      const name = (prompt('Name for this EQ preset:') || '').trim();
      if (!name) return;
      const u = userPresets();
      u[name] = eqCurve.slice();
      store.set('eq.user', u);
      fillPresetSelect('u:' + name);
    };
    $('btnEqDelete').onclick = () => {
      const v = $('eqPreset').value;
      if (!v.startsWith('u:')) {
        alert('Select one of your saved presets first.');
        return;
      }
      const u = userPresets();
      delete u[v.slice(2)];
      store.set('eq.user', u);
      fillPresetSelect();
    };
    $('btnEqExport').onclick = () => {
      const blob = new Blob([JSON.stringify({ current: eqCurve, presets: userPresets(), bands: HX.EQ_BANDS }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'cloud3s-eq.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    $('eqImport').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        const u = userPresets();
        if (j.presets && typeof j.presets === 'object') {
          for (const [k, v] of Object.entries(j.presets)) if (Array.isArray(v) && v.length === 10) u[k] = v.map(Number);
        }
        store.set('eq.user', u);
        if (Array.isArray(j.current) && j.current.length === 10) setCurve(j.current);
        fillPresetSelect();
        log('in', `Imported ${Object.keys(j.presets || {}).length} EQ preset(s)`);
      } catch (err) {
        log('er', `Import failed: ${err.message}`);
      }
      e.target.value = '';
    };
    $('btnEqSlotSet').onclick = () => {
      const i = +$('eqSlot').value;
      setAndVerify(HX.cmd.setEqSlot(i), HX.cmd.getEqSlot(), `Selecting onboard EQ slot ${i}`);
    };
    $('btnEqSlotGet').onclick = () => req(HX.cmd.getEqSlot());
    $('eqDepop').checked = store.get('eq.depop', true);
    $('eqDepop').onchange = () => store.set('eq.depop', $('eqDepop').checked);
    $('eqLive').checked = store.get('eq.live', true);
    $('eqLive').onchange = () => store.set('eq.live', $('eqLive').checked);
  }

  // -------------------------------------------------------------- raw console
  function rawCommandPacket() {
    const rw = +$('rawRw').value;
    const op = parseHexByte($('rawOp').value, 'Opcode');
    const args = HX.parseHex($('rawArgs').value);
    if (args.length > HX.PACKET_LEN - 6) throw new Error('Too many argument bytes');
    return HX.buildPacket(rw, op, args);
  }

  function updatePreview() {
    try {
      $('rawPreview').textContent = HX.hexTrim(rawCommandPacket(), 8);
    } catch (err) {
      $('rawPreview').textContent = err.message;
    }
  }

  function bindRaw() {
    const list = $('rawOpList');
    list.add(new Option('Known opcodes…', ''));
    for (const [op, info] of Object.entries(HX.OP_INFO).sort((a, b) => a[0] - b[0])) {
      const label = `0x${HX.hex(+op)}  ${info.rw === HX.RW.GET ? 'GET' : 'SET'}  ${info.name}${info.args ? '  [' + info.args + ']' : ''}  — ${info.src}`;
      list.add(new Option(label, op));
    }
    list.onchange = () => {
      if (!list.value) return;
      const op = +list.value;
      const info = HX.OP_INFO[op];
      $('rawOp').value = HX.hex(op);
      $('rawRw').value = String(info.rw);
      if (info.rw === HX.RW.GET) $('rawArgs').value = '';
      updatePreview();
    };
    ['rawRw', 'rawOp', 'rawArgs'].forEach((id) => ($(id).oninput = updatePreview));
    updatePreview();

    $('btnRawSend').onclick = async () => {
      let pkt;
      try {
        pkt = rawCommandPacket();
      } catch (err) {
        log('er', err.message);
        return;
      }
      if (pkt[3] === HX.RW.SET && !HX.OP_INFO[pkt[5]] && !confirm(`Send SET to unknown opcode 0x${HX.hex(pkt[5])}? Unknown writes can change settings in ways this tool can't undo.`)) return;
      try {
        const r = await transport.request(pkt, { feature: $('rawFeature').checked });
        if (!r) log('in', 'No matching reply (check the log for anything else that came back)');
      } catch (err) {
        log('er', `Send failed: ${err.message || err}`);
      }
    };

    const readRaw = () => {
      const rid = parseHexByte($('rawRid').value, 'Report ID');
      const data = HX.parseHex($('rawData').value);
      return { rid, data };
    };
    $('btnRawReport').onclick = async () => {
      try {
        const { rid, data } = readRaw();
        await transport.rawWrite(Uint8Array.of(rid, ...data));
      } catch (err) {
        log('er', `Output report failed: ${err.message || err}`);
      }
    };
    $('btnRawFeature').onclick = async () => {
      try {
        const { rid, data } = readRaw();
        await transport.rawWrite(Uint8Array.of(rid, ...data), { feature: true });
      } catch (err) {
        log('er', `Feature report failed: ${err.message || err}`);
      }
    };
    $('btnRawGetFeature').onclick = async () => {
      try {
        const rid = parseHexByte($('rawRid').value, 'Report ID');
        const bytes = await transport.readFeature(rid);
        log('rx', `Feature report 0x${HX.hex(rid)}: ${bytes.length} bytes`, Uint8Array.of(rid, ...bytes));
      } catch (err) {
        log('er', `Read feature report failed: ${err.message || err}`);
      }
    };

    $('btnScan').onclick = scan;
    $('btnScanStop').onclick = () => (scanning = false);
  }

  async function scan() {
    let from, to;
    try {
      from = parseHexByte($('scanFrom').value, 'From');
      to = parseHexByte($('scanTo').value, 'To');
    } catch (err) {
      log('er', err.message);
      return;
    }
    if (to < from) [from, to] = [to, from];
    if (!confirm(`Send GET for opcodes 0x${HX.hex(from)}–0x${HX.hex(to)}?\n\nRead requests should not change anything, but opcodes nobody has documented could do anything. Continue?`)) return;
    const timeout = Math.max(50, +$('scanTimeout').value || 250);
    const tb = $('scanTable').querySelector('tbody');
    tb.textContent = '';
    scanning = true;
    $('btnScan').disabled = true;
    $('btnScanStop').disabled = false;
    log('in', `Scanning GET opcodes 0x${HX.hex(from)}–0x${HX.hex(to)}`);
    let hits = 0;
    try {
      for (let op = from; op <= to && scanning && transport; op++) {
        const r = await transport.request(HX.buildPacket(HX.RW.GET, op), { timeout });
        if (r) {
          hits++;
          const tr = document.createElement('tr');
          const known = HX.OP_INFO[op] ? HX.OP_INFO[op].name : '';
          for (const v of [`0x${HX.hex(op)}`, known, HX.hexTrim(r.raw.slice(6), 4)]) {
            const td = document.createElement('td');
            td.textContent = v;
            tr.appendChild(td);
          }
          tb.appendChild(tr);
        }
      }
    } catch (err) {
      log('er', `Scan stopped: ${err.message || err}`);
    } finally {
      log('in', `Scan finished: ${hits} opcode(s) answered`);
      scanning = false;
      $('btnScan').disabled = !transport;
      $('btnScanStop').disabled = true;
    }
  }

  // -------------------------------------------------------------- settings
  function bindSettings() {
    $('pollInterval').value = String(store.get('poll', 30));
    $('pollInterval').onchange = setPoll;
    $('autoConnect').checked = store.get('autoConnect', true);
    $('autoConnect').onchange = () => store.set('autoConnect', $('autoConnect').checked);
    $('replyTimeout').value = store.get('replyTimeout', 1000);
    $('ackTimeout').value = store.get('ackTimeout', 300);
    $('replyTimeout').onchange = () => {
      store.set('replyTimeout', +$('replyTimeout').value);
      if (transport) transport.replyTimeout = +$('replyTimeout').value || 1000;
    };
    $('ackTimeout').onchange = () => {
      store.set('ackTimeout', +$('ackTimeout').value);
      if (transport) transport.ackTimeout = +$('ackTimeout').value || 0;
    };
    ['logTx', 'logRx', 'logEv', 'logHex'].forEach((id) => {
      $(id).checked = store.get('log.' + id, $(id).checked);
      $(id).onchange = () => {
        store.set('log.' + id, $(id).checked);
        rerenderLog();
      };
    });
    $('btnLogClear').onclick = () => {
      logEntries.length = 0;
      rerenderLog();
    };
    $('btnLogCopy').onclick = async () => {
      const text = logEntries.map((e) => `${e.t} ${e.cls} ${e.text}${e.hex ? '  [' + e.hex + ']' : ''}`).join('\n');
      try {
        await navigator.clipboard.writeText(text);
        log('in', 'Log copied to clipboard');
      } catch (_) {
        log('er', 'Clipboard not available');
      }
    };
    $('btnRefresh').onclick = refreshAll;
  }

  // ------------------------------------------------------------------ init
  function init() {
    bindSettings();
    bindPower();
    bindToggles();
    bindEq();
    bindRaw();
    resetState();
    enableControls(false);

    if (!window.isSecureContext || location.protocol === 'file:') $('insecure').hidden = false;
    if (!HeadsetTransportAvailable()) {
      $('unsupported').hidden = false;
      $('btnConnect').disabled = true;
      log('er', 'WebHID is not available in this browser');
      return;
    }
    $('btnConnect').onclick = connectClicked;
    $('btnDisconnect').onclick = () => disconnect(false);
    $('btnForget').onclick = async () => {
      const d = transport && transport.device;
      await disconnect(true);
      if (d && d.forget) {
        await d.forget();
        log('in', 'Permission revoked. Press Connect to pick the device again.');
      }
    };
    navigator.hid.addEventListener('disconnect', (e) => {
      if (transport && e.device === transport.device) {
        log('er', 'Dongle unplugged');
        disconnect(true);
      }
    });
    navigator.hid.addEventListener('connect', (e) => {
      if (!transport && window.HeadsetTransport.isKnown(e.device) && $('autoConnect').checked) {
        log('in', 'Dongle plugged in');
        // the dongle may show up as several HIDDevices; let tryAutoConnect pick the control one
        clearTimeout(plugTimer);
        plugTimer = setTimeout(tryAutoConnect, 500);
      }
    });
    log('in', 'Ready. Press Connect.');
    tryAutoConnect();
  }

  // expose a little for debugging from the console
  window.cloud3s = {
    get transport() { return transport; },
    state,
    send: (hexStr) => transport && transport.request(Uint8Array.from(HX.parseHex(hexStr))),
    refreshAll,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
