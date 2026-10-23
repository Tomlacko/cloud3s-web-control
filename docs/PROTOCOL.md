# HyperX Cloud III S Wireless — HID control protocol

Everything here comes from HyperX's own software, plus community captures that
confirm it on real hardware. Nothing was guessed without saying so.

## Where this comes from

| Source | What it gave |
|---|---|
| **NGENUITY Legacy 2.35** (`HyperX_NGENUITY_Installer_2.35.0.0.exe`, the Microsoft Store/UWP app) | The device code lives in `NGenuity2Helper.exe`, a plain .NET assembly, decompiled with ILSpy. Namespace `NGenuity2.Devices.Headset.Cloud3SWireless` has one class per command (`CMDHSCloud3SWirelessSetPowerAutoOff`, …) and `HeadsetCloud3SWireless.cs` has the reply/notification parser. The main UI (`NGenuity2.dll`) is .NET Native; its compiled XAML shows which controls the Cloud III S panel has. |
| **NGENUITY 3.1.0** (`ngenuity/stable/3.1.0/HyperX_NGENUITY_Installer.exe`, the new Avalonia app) | UI in `NGENUITY.dll` (.NET, decompiled). Device I/O moved into `hxn-srv-communication-hub.exe` (Rust). Disassembling it gave the packet builders (`mov dword [rax], 0x0103020C` etc.), the dispatcher that maps each "universal" command to an opcode, and the product table with PIDs and HID usages. This is where the sidetone-level and playback-mute opcodes come from. |
| [HaloBattery](https://github.com/HeyOkay/HaloBattery) (`providers/hyperx_cloud3s.py`, issues #106/#156) | Confirmed on hardware for both dongle PIDs: requests must be **output** reports; the dongle ignores the same bytes as a feature report. Charging value 2 = full. |
| [HeadsetControl #486](https://github.com/Sapd/HeadsetControl/issues/486) | USB captures of NGENUITY (EQ "commit" byte, a "Never" auto-off of `7A C0`), collection list, button reports. |
| [HyperHeadset](https://github.com/LennardKittner/HyperHeadset) (`cloud_iii_s_wireless.rs`, issue #36) | First open implementation of the basic reads; Linux enumeration problem. |

## USB identity

Vendor ID `0x03F0` (HP, Inc).

| PID | What | Notes |
|---|---|---|
| `0x06BE` | 2.4 GHz dongle, revision 1 | NGENUITY 3 calls it `CloudIIISWirelessDTS`. Legacy NGENUITY only supports this one. |
| `0x02CC` | 2.4 GHz dongle, revision 2 | `CloudIIISWireless` in NGENUITY 3. Same protocol (battery read confirmed on hardware). |
| `0x05BE` | Headset over USB-C, rev. 1 | NGENUITY only opens this for firmware updates (Airoha SDK). |
| `0x01CC` | Headset over USB-C, rev. 2 | Same. |
| `0x01BF` | "Emblems" 3-in-1 / OMEN Instant Pair dongle | Different, "universal" protocol (report `0x54`, `0x60`, …). Not covered here. |

The dongle's HID interface is **interface 3**, with six top-level collections. The control
collection is usage page `0x01C0`, usage `0x0001` (NGENUITY 3's device table; Windows path
`HID#VID_03F0&PID_06BE&MI_03&Col05`). It declares input reports `0x0C`/`0x0D` and output report
`0x0C`. Other collections carry consumer-control buttons (page `0x000C`, report `0x0F`) and
telephony mute (page `0x000B`).

## Packet format

Requests are **output reports** (HID `SET_REPORT` type Output / interrupt OUT), 64 bytes
including the report ID:

```
byte  0   0x0C     report id
byte  1   0x02
byte  2   0x03
byte  3   RW       0x01 = read (GET), 0x00 = write (SET)
byte  4   0x00
byte  5   opcode
byte  6+  arguments, zero padded
```

Replies arrive as **input report `0x0C`** with the same header (byte 3 echoes RW), the opcode in
byte 5 and the value from byte 6. A value of `0xFF` in byte 6 means "no value" — typically the
headset is off or out of range (NGENUITY ignores those replies).

Unsolicited events arrive as **input report `0x0D`**: `0D 02 03 00 <type> <value>`.

NGENUITY sends one request at a time and waits ~10 ms between writes.

## Opcodes

Source key: **L** = NGENUITY Legacy 2.35 uses it for this headset · **Ld** = Legacy has the
command class but never calls it · **N3** = NGENUITY 3.1 hub.

| Op | RW | Meaning | Arguments / reply | Source |
|---|---|---|---|---|
| `01` | SET | Microphone mute | `01` mute, `00` unmute | L, N3 |
| `02` | GET | Headset ↔ dongle link | `02` = connected, anything else = not | L, N3 |
| `04` | GET | Microphone mute | `01` = muted | L, N3 |
| `06` | GET | Battery | percent (bytes 7–8 change too; possibly millivolts, unconfirmed) | L, N3 |
| `0B` | SET | Voice prompts | `01` on, `00` off | L, N3 |
| `0D` | SET | Sidetone (mic monitoring) | `01` on, `00` off | L, N3 |
| `0F` | SET | Onboard EQ slot | index 0–5 (Legacy rejects others) | Ld, N3 |
| `14` | GET | Voice prompts | `01` = on | L, N3 |
| `16` | GET | Sidetone | `01` = on | L, N3 |
| `1C` | GET | Onboard EQ slot | index | Ld, N3 |
| `43` | GET | Mic boom status | raw, meaning not confirmed | Ld |
| `44` | SET | **Sidetone level** | signed byte (see below) | N3 |
| `45` | GET | Sidetone level | signed byte | N3 |
| `46` | SET | Playback (speaker) mute | `01` mute | Ld, N3 |
| `47` | GET | Playback mute | `01` = muted | N3 |
| `48` | GET | Charging | `00` not charging, `01` charging, `02` full | L |
| `49` | GET | Headset information | raw, format unknown | Ld |
| `4A` | SET | **Auto power-off** | seconds, 16-bit big-endian; `00 00` = never | L, N3 |
| `4B` | GET | Auto power-off | seconds, 16-bit big-endian | L, N3 |
| `4D` | GET | Color / SKU | see table | L, N3 |
| `5F` | SET | EQ band gain | `band, gain_hi, gain_lo, depop` | L, N3 |

### Auto power-off (`4A` / `4B`)

`0C 02 03 00 00 4A HH LL` with `HHLL` = seconds.

* Legacy: enum `Never = 0, TenMinutes = 600, TwentyMinutes = 1200, ThirtyMinutes = 1800`;
  reading back, anything below 600 is shown as "Never".
* NGENUITY 3.1: the hub only lets 600 / 1200 / 1800 through, maps its "Never" (internally
  18000 min) to `0`, and replaces **any other value with 1200**. An earlier NGENUITY 3 build sent
  "Never" as 1,080,000 s truncated to 16 bits = `7A C0` (≈ 8.7 h) — that's the value seen in the
  HeadsetControl #486 capture.
* The timer runs while the headset detects silence, so very quiet audio counts as silence. There
  is no threshold setting in either NGENUITY version; turning the timer off is the fix.
* Other values (e.g. 45 min) fit in the field but have never been sent by NGENUITY; behaviour
  is unknown. Read `4B` back to see what the headset kept.

### EQ (`5F`)

`0C 02 03 00 00 5F BB GH GL DP`

* `BB` band 0–9 = 32, 64, 125, 250, 500, 1k, 2k, 4k, 8k, 16k Hz.
* `GH GL` gain as a signed 16-bit big-endian number in **hundredths of a dB** (`+6.0 dB` =
  `02 58`, `−2.5 dB` = `FF 06`).
* One band per packet (Legacy and NGENUITY 3 both send ten packets).
* `DP` (byte 9): NGENUITY 3 sets it to `01` on the **last** band packet when its `withDepop`
  flag is set — used when switching presets or turning the EQ on/off, not while dragging a
  slider. Legacy never sets it.
* Range: NGENUITY 3 offers ±8 dB for this headset. Legacy multiplies its slider value by 8
  before encoding (slider range not recovered); HyperHeadset clamps at ±12 dB.
* There is no GET for the band gains.

### Sidetone level (`44` / `45`)

Present in NGENUITY 3's hub for this product and wired into its view model, but the current UI
doesn't show the slider. The view model converts a slider index `i` (0, 1, 2, …) with
`(250 + i) % 256`, so the byte is a signed value starting at **−6** (`FA`). The upper limit isn't
in the code. Legacy NGENUITY has empty `Get/SetSidetoneLevel` stubs, so this probably needs newer
firmware.

### Playback mute (`46` / `47`)

Legacy's `CMDHSCloud3SWirelessSetPlaybackMuteState` writes the flag into byte 2 by mistake
(`array[2] = mute`) and is never called; NGENUITY 3 puts it in byte 6, which is what this tool
does.

### Color (`4D`)

`CommunicationHub.SKUColor`: 0 Black, 1 White, 2 Black/Red, 3 Black/Blue, 4 Black/Green,
5 White/Pink, 6 White/Blue, 7 White/Green, 8 Gray/Green, 9 Black/White, 10 Silver/Black,
11 Blue/Black, 12 White/Purple, 13 White/Black, 14 Black/Purple, 15 Gray/Red, 16 Purple,
22 White/Silver. (Legacy only knows 0–2.)

## Notifications (input report `0x0D`)

`0D 02 03 00 TT VV`

| `TT` | Meaning | `VV` |
|---|---|---|
| 1 | Battery level | percent |
| 3 | Mic mute changed | `01` muted |
| 5 | Sidetone changed | `01` on |
| 10 | Charging changed | as opcode `48` |
| 12 | Headset link | `01` connected (NGENUITY re-reads everything on connect) |

Legacy ignores types 2, 4, 6–9, 11 and 13; their meaning is unknown.

## Buttons (input report `0x0F`, consumer collection)

Byte 1 bitmask: `01` volume up, `02` volume down, `08` play/pause.

## Things that are *not* headset settings

* **Active noise cancellation** — the Cloud III S doesn't have it; no opcode exists in either
  NGENUITY version. The mic's noise reduction is acoustic.
* **Noise suppression** in NGENUITY 3 is its PC-side "Audio Engine" (a virtual audio driver with
  ONNX models). It processes audio on the PC and isn't stored on the headset.
* **DTS / spatial sound** — a Windows audio processing object (APO) on the PC.
* **Output and mic volume sliders** — Windows endpoint volume.
* **Firmware update** — goes through the Airoha SDK (`AirohaHidCoreDll.dll`) on the dongle and
  the USB-C headset. Not implemented here: a failed update can brick the device.

## Transport notes

* **Windows:** each top-level collection is its own device path; writes must go to the one that
  declares report `0x0C`, replies can be delivered to another. Chrome's WebHID merges the
  collections into one `HIDDevice` and routes by report ID.
* **Linux:** needs udev rules (see `linux/`). HyperHeadset's maintainer reports that some kernels
  leave the dongle in a state where it stops forwarding the headset's replies after the first
  enumeration; their workaround is the `usbcore.quirks=03f0:06be:r` (or `03f0:02cc:r`) kernel
  parameter on recent kernels, then replugging. Not verified here.
* **Bluetooth:** no control channel; use the dongle.
