// End-to-end test of the web app against the fake dongle in tests/mock-hid.js.
// Run:  node tests/e2e.mjs   (needs the `playwright` package and a Chromium build)
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  const { execSync } = await import('node:child_process');
  const globalRoot = execSync('npm root -g').toString().trim();
  playwright = require(path.join(globalRoot, 'playwright'));
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pageUrl = pathToFileURL(path.join(root, 'index.html')).href;
const shotDir = process.env.SHOT_DIR || path.join(here, 'out');
fs.mkdirSync(shotDir, { recursive: true });

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('  ok   ' + msg);
  else {
    failures++;
    console.log('  FAIL ' + msg);
  }
}

const hex = (a) => a.map((b) => (typeof b === 'number' ? b.toString(16).padStart(2, '0') : b)).join(' ');
const head = (pkt, n) => hex(pkt.slice(0, n));

const browser = await playwright.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: 'dark' });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(String(e)));
page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'My preset' : undefined));
await page.addInitScript({ path: path.join(here, 'mock-hid.js') });
await page.goto(pageUrl);

const sent = () => page.evaluate(() => window.__sent.map((p) => Array.from(p)));
const clearSent = () => page.evaluate(() => (window.__sent.length = 0));
const devState = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__dev.st)));
const text = (id) => page.locator('#' + id).evaluate((el) => el.textContent);

console.log('connect + initial read');
await page.click('#btnConnect');
const refreshed = () => page.waitForFunction(() => [...document.querySelectorAll('#log div')].some((d) => d.textContent.includes('Refreshed all values')), null, { timeout: 10000 });
await refreshed();
check((await text('stBattery')) === '87 %', 'battery decoded');
check((await text('stLink')).includes('connected'), 'link shows connected');
check((await text('stColor')) === 'Black / Red', 'color decoded');
check((await text('stAutoOff')).startsWith('20 min'), 'auto-off read as 20 min');
check((await text('stCharging')) === 'Not charging', 'charging decoded');
check((await text('stSidetoneLevel')) === '-6', 'sidetone level decoded as signed (-6)');
check(await page.isChecked('#tgVoicePrompt'), 'voice prompt switch on');
check(!(await page.isChecked('#tgSidetone')), 'sidetone switch off');
let s = await sent();
check(s.length >= 13, `13 reads sent (${s.length})`);
check(s.every((p) => p[0] === 0x0c && p.length === 64), 'every packet is report 0x0C, 63 data bytes');
check(head(s[0], 7) === '0c 02 03 01 00 02 00', 'first packet = GET link: ' + head(s[0], 7));
check(s.some((p) => head(p, 6) === '0c 02 03 01 00 06'), 'GET battery sent');

console.log('auto power-off');
await clearSent();
await page.click('#autoOffSeg button[data-sec="0"]');
await page.waitForFunction(() => document.getElementById('stAutoOff').textContent.startsWith('Never'));
s = await sent();
check(head(s[0], 8) === '0c 02 03 00 00 4a 00 00', 'SET auto-off never = 4A 00 00: ' + head(s[0], 8));
check(head(s[1], 6) === '0c 02 03 01 00 4b', 'followed by GET auto-off');
check((await devState()).autoOff === 0, 'device stored 0');
check(await page.locator('#autoOffSeg button[data-sec="0"]').evaluate((b) => b.classList.contains('active')), 'Never button highlighted');

await clearSent();
await page.click('#autoOffSeg button[data-sec="1800"]');
await page.waitForFunction(() => document.getElementById('stAutoOff').textContent.startsWith('30 min'));
s = await sent();
check(head(s[0], 8) === '0c 02 03 00 00 4a 07 08', '30 min = 07 08 (1800 s)');

await clearSent();
await page.locator('#cardPower details summary').click();
await page.fill('#autoOffCustom', '45');
await page.selectOption('#autoOffUnit', '60');
await page.click('#btnAutoOffCustom');
await page.waitForFunction(() => document.getElementById('stAutoOff').textContent.startsWith('45 min'));
s = await sent();
check(head(s[0], 8) === '0c 02 03 00 00 4a 0a 8c', 'custom 45 min = 0A 8C (2700 s)');

await clearSent();
await page.fill('#autoOffCustom', '2000');
await page.click('#btnAutoOffCustom');
await page.waitForTimeout(150);
check((await sent()).length === 0, '2000 min (> 65535 s) rejected without sending');

console.log('toggles');
await clearSent();
await page.locator('#tgSidetone').check();
await page.waitForFunction(() => [...document.querySelectorAll('#log div')].some((d) => d.textContent.includes('Sidetone on')));
s = await sent();
check(head(s[0], 7) === '0c 02 03 00 00 0d 01', 'SET sidetone on = 0D 01');
check((await devState()).sidetone === 1, 'device sidetone on');

await clearSent();
await page.locator('#tgVoicePrompt').uncheck();
await page.waitForTimeout(500);
s = await sent();
check(head(s[0], 7) === '0c 02 03 00 00 0b 00', 'SET voice prompt off = 0B 00');
check(!(await page.isChecked('#tgVoicePrompt')), 'voice prompt switch off after read-back');

await clearSent();
await page.locator('#tgMicMute').check();
await page.waitForTimeout(500);
check(head((await sent())[0], 7) === '0c 02 03 00 00 01 01', 'SET mic mute = 01 01');

await clearSent();
await page.locator('#tgPlaybackMute').check();
await page.waitForTimeout(500);
check(head((await sent())[0], 7) === '0c 02 03 00 00 46 01', 'SET playback mute = 46 01 (value in byte 6)');

console.log('sidetone level');
await page.locator('#sidetoneLevelBox summary').click();
await clearSent();
await page.locator('#slSidetoneLevel').evaluate((el) => {
  el.value = '-3';
  el.dispatchEvent(new Event('input'));
  el.dispatchEvent(new Event('change'));
});
await page.waitForFunction(() => document.getElementById('stSidetoneLevel').textContent === '-3');
s = await sent();
check(head(s[0], 7) === '0c 02 03 00 00 44 fd', 'SET sidetone level -3 = 44 FD');

console.log('equalizer');
await clearSent();
await page.selectOption('#eqPreset', 'b:Bass boost');
await page.waitForTimeout(800);
s = (await sent()).filter((p) => p[5] === 0x5f);
check(s.length === 10, '10 band packets for a preset');
check(head(s[0], 9) === '0c 02 03 00 00 5f 00 02 58', 'band 0 +6 dB = 02 58 (600)');
check(s[9][9] === 1 && s.slice(0, 9).every((p) => p[9] === 0), 'de-pop flag only on the last band');
const st = await devState();
check(JSON.stringify(st.eq) === JSON.stringify([6, 5, 4, 2, 0, 0, 0, 0, 0, 0]), 'device EQ = bass boost');

await clearSent();
const band3 = page.locator('#eqBands .band').nth(3).locator('input[type=number]');
await band3.fill('-2.5');
await band3.dispatchEvent('change');
await page.waitForTimeout(400);
s = (await sent()).filter((p) => p[5] === 0x5f);
check(s.length === 1 && head(s[0], 10) === '0c 02 03 00 00 5f 03 ff 06 00', 'live single band -2.5 dB = FF 06, no de-pop');

await band3.fill('11');
await band3.dispatchEvent('change');
check((await band3.inputValue()) === '8.0', 'clamped to +8 dB in official range');
await page.locator('#eqExt').check();
await band3.fill('11');
await band3.dispatchEvent('change');
check((await band3.inputValue()) === '11.0', '±12 dB allows 11');

await page.click('#btnEqSave');
check((await page.locator('#eqPreset option', { hasText: 'My preset' }).count()) === 1, 'saved user preset listed');

console.log('raw console + scanner');
await clearSent();
await page.fill('#rawOp', '48');
await page.selectOption('#rawRw', '1');
await page.dispatchEvent('#rawOp', 'input');
check((await text('rawPreview')).startsWith('0C 02 03 01 00 48'), 'preview shows built packet');
await page.click('#btnRawSend');
await page.waitForTimeout(300);
check(head((await sent())[0], 6) === '0c 02 03 01 00 48', 'raw command sent');

await page.fill('#scanFrom', '00');
await page.fill('#scanTo', '1F');
await page.fill('#scanTimeout', '60');
await page.click('#btnScan');
await page.waitForFunction(() => !document.getElementById('btnScan').disabled, null, { timeout: 15000 });
const rows = await page.locator('#scanTable tbody tr').count();
check(rows === 6, `scanner found 6 answering GETs in 00-1F (${rows})`);

console.log('notifications and buttons');
await page.evaluate(() => window.__dev.notify(1, 42));
await page.waitForFunction(() => document.getElementById('stBattery').textContent === '42 %');
check(true, 'battery notification updates status');
await page.evaluate(() => window.__dev.notify(10, 1));
await page.waitForFunction(() => document.getElementById('stCharging').textContent === 'Charging');
check(true, 'charging notification');
await page.evaluate(() => window.__dev.button(0x08));
await page.waitForFunction(() => [...document.querySelectorAll('#log div')].some((d) => d.textContent.includes('Play/pause')));
check(true, 'button report logged');

console.log('headset off');
await page.evaluate(() => { window.__dev.st.link = 1; window.__dev.notify(12, 0); });
await page.waitForFunction(() => document.getElementById('connPill').textContent.includes('headset off'));
check(true, 'pill shows dongle only when headset disconnects');
await page.evaluate(() => { window.__dev.st.link = 2; window.__dev.notify(12, 1); });
await page.waitForFunction(() => document.getElementById('connPill').textContent === 'Connected');
check(true, 'reconnect notification restores state');
await page.waitForTimeout(1500); // the re-read triggered by the reconnect

await page.screenshot({ path: path.join(shotDir, 'desktop-dark.png'), fullPage: true });

console.log('no reply handling');
await page.evaluate(() => (window.__dev.silent = true));
await page.click('#btnRefresh');
await page.waitForFunction(() => [...document.querySelectorAll('#log div')].some((d) => d.textContent.includes('did not answer')), null, { timeout: 20000 });
check(true, 'silent dongle reported');
await page.evaluate(() => (window.__dev.silent = false));

console.log('disconnect');
await page.click('#btnDisconnect');
check((await text('connPill')) === 'Not connected', 'pill resets');
check(await page.isDisabled('#btnRefresh'), 'controls disabled');
await page.evaluate(() => {
  window.__granted = true;
  const ev = new Event('connect');
  ev.device = window.__dev;
  navigator.hid.dispatchEvent(ev);
});
await page.waitForFunction(() => document.getElementById('connPill').textContent === 'Connected', null, { timeout: 5000 });
check(true, 'replugging the dongle reconnects automatically');

// light theme + phone width
const ctx2 = await browser.newContext({ viewport: { width: 390, height: 900 }, colorScheme: 'light' });
const p2 = await ctx2.newPage();
await p2.addInitScript({ path: path.join(here, 'mock-hid.js') });
await p2.goto(pageUrl);
await p2.click('#btnConnect');
await p2.waitForFunction(() => [...document.querySelectorAll('#log div')].some((d) => d.textContent.includes('Refreshed all values')));
const overflow = await p2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check(overflow <= 0, `no horizontal scroll on phone width (${overflow}px)`);
await p2.screenshot({ path: path.join(shotDir, 'phone-light.png'), fullPage: true });

// auto-reconnect when the browser already granted permission
const ctx3 = await browser.newContext();
const p3 = await ctx3.newPage();
await p3.addInitScript(() => (window.__granted = true));
await p3.addInitScript({ path: path.join(here, 'mock-hid.js') });
await p3.goto(pageUrl);
await p3.waitForFunction(() => document.getElementById('connPill').textContent === 'Connected', null, { timeout: 5000 });
check(await p3.isDisabled('#btnConnect'), 'auto-reconnect on load, Connect disabled while connected');

check(consoleErrors.length === 0, 'no console errors' + (consoleErrors.length ? ': ' + consoleErrors.join(' | ') : ''));
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
