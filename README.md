# Cloud III S Control

Configure a **HyperX Cloud III S Wireless** without NGENUITY — from a browser tab (WebHID) or
from the command line (Python).

The protocol was recovered from HyperX's own software (NGENUITY Legacy 2.35 decompiled,
NGENUITY 3.1 disassembled); details and sources are in [docs/PROTOCOL.md](docs/PROTOCOL.md).

## What you can change

| Setting | Notes |
|---|---|
| **Auto power-off** | Never / 10 / 20 / 30 min, plus custom values (unofficial, up to ~18 h). |
| **Sidetone** (hear your own mic) | On/off. |
| Sidetone level | Experimental — from NGENUITY 3's code; may need newer firmware. |
| **Mic mute** | Same as the button on the headset. |
| **Voice prompts** | The spoken "power on", "battery low", … announcements. |
| Playback mute | Experimental. |
| **10-band EQ** (onboard) | 32 Hz–16 kHz, ±8 dB (±12 dB optional), presets, save/import/export. |
| Onboard EQ slot | Experimental (0–5). |
| Status | Battery, charging, headset link, color, raw info; live events (mute, battery, buttons). |
| Raw console | Send any packet, read feature reports, scan opcodes, see the HID descriptor. |

## Common questions

* **Why does the headset switch off while I'm listening to something quiet?** That's the auto
  power-off timer. It counts down while the headset hears *silence*, and quiet audio counts as
  silence. There's no separate threshold setting in the firmware protocol (neither NGENUITY
  version has one); set auto power-off to **Never** and it stops.
* **Can I choose how long it waits?** 10, 20 or 30 minutes officially. The firmware field is in
  seconds, so the app also lets you try other values; it reads the value back so you see what
  the headset kept.
* **Can I turn off noise cancellation?** There's nothing to turn off. The Cloud III S has no active
  noise cancellation, and there's no noise-cancelling command for it in either NGENUITY version.
  The mic's noise reduction is acoustic (part of the mic). NGENUITY 3's "noise suppression" is
  processing in its own PC audio driver, so without NGENUITY it isn't running.

## Browser app

Works in desktop **Chrome, Edge, Opera, Brave, Vivaldi** on Windows, macOS, Linux and ChromeOS.
Firefox and Safari don't support WebHID — use the Python CLI there.

1. Open the page:
   * **Hosted**: enable GitHub Pages for this repo (Settings → Pages → *Deploy from a branch*,
     `main`, `/ (root)`), then open the URL GitHub shows.
   * **Locally**: download the repo, run `python -m http.server` in its folder and open
     <http://localhost:8000>. (Opening `index.html` straight from disk may not be allowed to use
     WebHID.)
2. Plug in the dongle, switch the headset on (2.4 GHz mode), close NGENUITY if it's running.
3. Click **Connect** and choose *HyperX Cloud III S Wireless*.

Settings are written to the headset, so this is a one-time job — you don't need to keep the page
open. The page reconnects automatically next time.

## Python CLI

```
pip install hidapi
python python/hyperx_cloud3s.py status
python python/hyperx_cloud3s.py auto-off never
python python/hyperx_cloud3s.py auto-off 20          # minutes; also 90m, 45s, 2h (unofficial)
python python/hyperx_cloud3s.py sidetone on
python python/hyperx_cloud3s.py voice-prompts off
python python/hyperx_cloud3s.py eq --preset bass
python python/hyperx_cloud3s.py eq 3 2 1 0 0 0 1 2 3 3
python python/hyperx_cloud3s.py listen               # live events
python python/hyperx_cloud3s.py get 49               # any GET opcode
python python/hyperx_cloud3s.py -v status            # show raw packets
```

`python python/hyperx_cloud3s.py --help` lists everything (`mic-mute`, `playback-mute`,
`sidetone-level`, `eq-slot`, `set`, `raw`, `scan`, `list`).

## Linux

* Permissions: `sudo cp linux/99-hyperx-cloud3s.rules /etc/udev/rules.d/ && sudo udevadm control --reload-rules && sudo udevadm trigger`, then replug the dongle.
* If the dongle answers "headset link" but nothing else, HyperHeadset's maintainer found that some
  kernels confuse the dongle on first enumeration. Their workaround (newer kernels only):
  add `usbcore.quirks=03f0:06be:r` (or `03f0:02cc:r`) to the kernel command line and replug.
  See [HyperHeadset #36](https://github.com/LennardKittner/HyperHeadset/issues/36).

## Troubleshooting

* **Everything shows "—" / "did not answer"** — headset off or not paired, or NGENUITY is open.
  Unplug and replug the dongle; the dongle can stop answering until it's re-plugged.
* **"Dongle only (headset off)"** — the dongle is fine but the headset isn't connected to it.
* **Bluetooth mode** — there's no control path to the PC over Bluetooth; use the dongle.
* **USB-C cable** — NGENUITY only uses the wired connection for firmware updates; control
  commands are meant for the dongle.

## Safety

Everything the app sends by default is something NGENUITY itself sends. Items marked
*experimental* or *unofficial* use opcodes or values NGENUITY has in its code but doesn't show,
or values it never sends. The raw console and opcode scanner can send anything; GETs should be
harmless, unknown SETs might not be. Firmware updates are deliberately not implemented.

## Tests

No headset needed — `tests/mock-hid.js` is a fake dongle that answers like the real one.

```
npm install          # playwright
npm test             # browser end-to-end test + Python unit tests
```

## License

Public domain ([The Unlicense](LICENSE)): use, copy, change or sell it however you like, no
attribution needed.

## Credits

* [HyperHeadset](https://github.com/LennardKittner/HyperHeadset), [HaloBattery](https://github.com/HeyOkay/HaloBattery)
  and the contributors in [HeadsetControl #486](https://github.com/Sapd/HeadsetControl/issues/486)
  for hardware captures and confirmations.
* Not affiliated with HyperX or HP. HyperX and NGENUITY are trademarks of HP Inc.
