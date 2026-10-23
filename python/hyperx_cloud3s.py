#!/usr/bin/env python3
"""
HyperX Cloud III S Wireless control from the command line (no NGENUITY).

Same protocol as the browser app; see docs/PROTOCOL.md.
Needs hidapi:  pip install hidapi

Examples:
  python hyperx_cloud3s.py status
  python hyperx_cloud3s.py auto-off never          # stop it switching off during quiet audio
  python hyperx_cloud3s.py auto-off 20             # minutes (10/20/30 are the official values)
  python hyperx_cloud3s.py auto-off 90m            # custom, unofficial (max 65535 s)
  python hyperx_cloud3s.py sidetone on
  python hyperx_cloud3s.py eq 3 2 1 0 0 0 1 2 3 3
  python hyperx_cloud3s.py eq --preset bass
  python hyperx_cloud3s.py listen                  # print button/battery/mute events
  python hyperx_cloud3s.py get 49                  # any GET opcode (hex)
  python hyperx_cloud3s.py set 0d 01               # any SET opcode + args (hex)
"""
from __future__ import annotations

import argparse
import sys
import time
from typing import Callable, Dict, Iterable, List, Optional, Sequence

try:
    import hid  # cython-hidapi: pip install hidapi
except ImportError:  # pragma: no cover - reported at runtime
    hid = None

VID = 0x03F0
PRODUCTS = {
    0x06BE: "Cloud III S Wireless (2.4 GHz dongle, rev. 1)",
    0x02CC: "Cloud III S Wireless (2.4 GHz dongle, rev. 2)",
    0x05BE: "Cloud III S Wireless (USB-C cable, rev. 1)",
    0x01CC: "Cloud III S Wireless (USB-C cable, rev. 2)",
}
CONTROL_USAGE_PAGE = 0x01C0  # from NGENUITY 3's device table

REPORT_CMD = 0x0C
REPORT_NOTIFY = 0x0D
REPORT_BUTTONS = 0x0F
PACKET_LEN = 64
RW_SET, RW_GET = 0x00, 0x01

OP = dict(
    SET_MIC_MUTE=0x01, GET_LINK=0x02, GET_MIC_MUTE=0x04, GET_BATTERY=0x06, SET_VOICE_PROMPT=0x0B,
    SET_SIDETONE=0x0D, SET_EQ_SLOT=0x0F, GET_VOICE_PROMPT=0x14, GET_SIDETONE=0x16, GET_EQ_SLOT=0x1C,
    GET_MIC_BOOM=0x43, SET_SIDETONE_LEVEL=0x44, GET_SIDETONE_LEVEL=0x45, SET_PLAYBACK_MUTE=0x46,
    GET_PLAYBACK_MUTE=0x47, GET_CHARGING=0x48, GET_INFO=0x49, SET_AUTO_OFF=0x4A, GET_AUTO_OFF=0x4B,
    GET_COLOR=0x4D, SET_EQ_BAND=0x5F,
)
OP_NAMES = {v: k for k, v in OP.items()}

COLORS = {
    0: "Black", 1: "White", 2: "Black / Red", 3: "Black / Blue", 4: "Black / Green", 5: "White / Pink",
    6: "White / Blue", 7: "White / Green", 8: "Gray / Green", 9: "Black / White", 10: "Silver / Black",
    11: "Blue / Black", 12: "White / Purple", 13: "White / Black", 14: "Black / Purple", 15: "Gray / Red",
    16: "Purple", 22: "White / Silver",
}
CHARGING = {0: "not charging", 1: "charging", 2: "fully charged"}
NOTIFY = {1: "battery", 3: "mic mute", 5: "sidetone", 10: "charging", 12: "headset link"}

EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
EQ_PRESETS = {
    "flat": [0] * 10,
    "janice": [3.2, 1.9, 0.7, 0.5, 0.9, 3.7, 5.5, 3.0, 0, 0],
    "vincent": [0, -3, -3, 0, 0, 0, 0, 0, 0, 0],
    "bass": [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
    "treble": [0, 0, 0, 0, 0, 0, 2, 4, 5, 6],
    "v-shape": [5, 4, 2, 0, -2, -2, 0, 2, 4, 5],
    "voice": [-3, -2, -1, 0, 2, 3, 3, 2, 0, -1],
    "fps": [-4, -4, -3, -1, 0, 2, 4, 5, 3, 1],
}


# --------------------------------------------------------------------------- packets
def packet(rw: int, op: int, args: Sequence[int] = ()) -> List[int]:
    p = [0] * PACKET_LEN
    p[0:6] = [REPORT_CMD, 0x02, 0x03, rw, 0x00, op]
    for i, a in enumerate(args):
        if 6 + i < PACKET_LEN:
            p[6 + i] = a & 0xFF
    return p


def auto_off_packet(seconds: int) -> List[int]:
    if not 0 <= seconds <= 0xFFFF:
        raise ValueError("auto-off must be 0..65535 seconds")
    return packet(RW_SET, OP["SET_AUTO_OFF"], [seconds >> 8, seconds & 0xFF])


def eq_band_packet(band: int, gain_db: float, depop: bool = False) -> List[int]:
    if not 0 <= band <= 9:
        raise ValueError("band must be 0..9")
    centi = max(-32768, min(32767, int(round(gain_db * 100))))
    v = centi & 0xFFFF
    return packet(RW_SET, OP["SET_EQ_BAND"], [band, v >> 8, v & 0xFF, 1 if depop else 0])


def eq_packets(gains: Sequence[float], depop: bool = True) -> List[List[int]]:
    return [eq_band_packet(i, g, depop and i == len(gains) - 1) for i, g in enumerate(gains)]


def s8(b: int) -> int:
    return b - 256 if b > 127 else b


def describe_seconds(s: int) -> str:
    if s == 0:
        return "never"
    if s % 60 == 0:
        return f"{s // 60} min"
    return f"{s // 60} min {s % 60} s" if s >= 60 else f"{s} s"


def decode_reply(p: Sequence[int]) -> Optional[str]:
    """Human-readable value of a 0x0C reply."""
    op, v = p[5], p[6]
    if p[3] == RW_SET:
        return "ack"
    if op == OP["GET_AUTO_OFF"]:
        s = (p[6] << 8) | p[7]
        return "no value" if s == 0xFFFF else f"{describe_seconds(s)} ({s} s)"
    if op == OP["GET_SIDETONE_LEVEL"]:
        return str(s8(v))
    if v == 0xFF:
        return "no value (headset off?)"
    if op == OP["GET_LINK"]:
        return "connected" if v == 2 else f"not connected ({v})"
    if op == OP["GET_BATTERY"]:
        return f"{v} %"
    if op == OP["GET_CHARGING"]:
        return CHARGING.get(v, f"state {v}")
    if op == OP["GET_COLOR"]:
        return COLORS.get(v, f"code {v}")
    if op in (OP["GET_MIC_MUTE"], OP["GET_PLAYBACK_MUTE"]):
        return "muted" if v == 1 else "not muted"
    if op in (OP["GET_SIDETONE"], OP["GET_VOICE_PROMPT"]):
        return "on" if v == 1 else "off"
    if op == OP["GET_INFO"]:
        return hexs(trim(p[6:38]))
    return str(v)


def hexs(b: Iterable[int]) -> str:
    return " ".join(f"{x:02X}" for x in b)


def trim(b: Sequence[int], keep: int = 1) -> List[int]:
    b = list(b)
    while len(b) > keep and b[-1] == 0:
        b.pop()
    return b


def describe_input(p: Sequence[int]) -> str:
    if not p:
        return ""
    if p[0] == REPORT_CMD and len(p) > 6:
        name = OP_NAMES.get(p[5], f"op 0x{p[5]:02X}")
        return f"reply {name}: {decode_reply(p)}"
    if p[0] == REPORT_NOTIFY and len(p) > 5:
        t, v = p[4], p[5]
        what = NOTIFY.get(t, f"type {t}")
        if t == 1:
            val = f"{v} %"
        elif t == 10:
            val = CHARGING.get(v, str(v))
        elif t in (3, 5, 12):
            val = "on" if v == 1 else "off"
        else:
            val = str(v)
        return f"event {what}: {val}"
    if p[0] == REPORT_BUTTONS and len(p) > 1:
        b = p[1]
        names = [n for bit, n in ((1, "volume up"), (2, "volume down"), (8, "play/pause")) if b & bit]
        return "button " + (" + ".join(names) if names else "released")
    return f"report 0x{p[0]:02X}: {hexs(trim(p, 2))}"


# ------------------------------------------------------------------------- transport
class NoDevice(Exception):
    pass


class Headset:
    """Opens every HID path of the dongle; writes go to the one that accepts report 0x0C."""

    def __init__(self, timeout: float = 1.0, verbose: bool = False, hid_module=None):
        self.hid = hid_module or hid
        if self.hid is None:
            raise NoDevice("Python package 'hidapi' is missing: pip install hidapi")
        self.timeout = timeout
        self.verbose = verbose
        self.handles: List[tuple] = []
        self.writer = None
        self.on_input: Optional[Callable[[List[int]], None]] = None
        self._open()

    def _open(self):
        infos = [d for d in self.hid.enumerate(VID, 0) if d.get("product_id") in PRODUCTS]
        if not infos:
            raise NoDevice("No Cloud III S dongle found (VID 03F0, PID 06BE/02CC). Is it plugged in?"
                           " On Linux, install linux/99-hyperx-cloud3s.rules.")
        pid = infos[0]["product_id"]
        self.product_id = pid
        self.product_name = PRODUCTS[pid]
        seen = set()
        mine = []
        for d in infos:
            if d["product_id"] != pid or d["path"] in seen:
                continue
            seen.add(d["path"])
            mine.append(d)

        def rank(d):
            page = d.get("usage_page") or 0
            return (0 if page == CONTROL_USAGE_PAGE else 1 if page >= 0xFF00 else 2, page)

        errors = []
        for d in sorted(mine, key=rank):
            dev = self.hid.device()
            try:
                dev.open_path(d["path"])
                dev.set_nonblocking(True)
            except (OSError, IOError) as e:
                errors.append(f"{d.get('usage_page', 0):04X}:{d.get('usage', 0):04X} {e}")
                continue
            self.handles.append((d, dev))
        if not self.handles:
            raise NoDevice("Could not open the dongle: " + "; ".join(errors) +
                           (" (Linux: missing udev rules?)" if sys.platform.startswith("linux") else ""))

    def close(self):
        for _, dev in self.handles:
            try:
                dev.close()
            except Exception:
                pass
        self.handles = []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()

    def _log(self, msg: str):
        if self.verbose:
            print("  " + msg, file=sys.stderr)

    def write(self, pkt: Sequence[int]) -> None:
        pkt = list(pkt)
        if pkt[0] == REPORT_CMD and len(pkt) < PACKET_LEN:
            pkt += [0] * (PACKET_LEN - len(pkt))
        candidates = ([self.writer] if self.writer else []) + [h for h in self.handles if h is not self.writer]
        for h in candidates:
            d, dev = h
            try:
                n = dev.write(pkt)
            except (OSError, IOError, ValueError) as e:
                self._log(f"write on {d.get('usage_page', 0):04X} failed: {e}")
                continue
            if n is not None and n < 0:
                self._log(f"write refused by {d.get('usage_page', 0):04X}:{d.get('usage', 0):04X}")
                continue
            self.writer = h
            self._log("→ " + hexs(trim(pkt, 8)))
            return
        raise IOError("No HID collection of the dongle accepted output report 0x0C")

    def read_all(self) -> List[List[int]]:
        out = []
        for _, dev in self.handles:
            while True:
                try:
                    r = dev.read(PACKET_LEN)
                except (OSError, IOError, ValueError):
                    break
                if not r:
                    break
                r = list(r)
                out.append(r)
                self._log("← " + hexs(trim(r, 8)))
                if self.on_input:
                    self.on_input(r)
        return out

    def request(self, pkt: Sequence[int], timeout: Optional[float] = None) -> Optional[List[int]]:
        self.read_all()  # drop stale input
        self.write(pkt)
        rw, op = pkt[3], pkt[5]
        end = time.monotonic() + (self.timeout if timeout is None else timeout)
        while time.monotonic() < end:
            for r in self.read_all():
                if len(r) > 6 and r[0] == REPORT_CMD and r[5] == op and r[3] == rw:
                    time.sleep(0.01)
                    return r
            time.sleep(0.005)
        return None

    def get(self, op: int, timeout: Optional[float] = None) -> Optional[List[int]]:
        return self.request(packet(RW_GET, op), timeout)

    def set(self, op: int, args: Sequence[int] = (), timeout: float = 0.3) -> Optional[List[int]]:
        return self.request(packet(RW_SET, op, args), timeout)


# --------------------------------------------------------------------------- commands
STATUS_READS = [
    ("Headset link", "GET_LINK"), ("Battery", "GET_BATTERY"), ("Charging", "GET_CHARGING"),
    ("Color", "GET_COLOR"), ("Auto power-off", "GET_AUTO_OFF"), ("Mic mute", "GET_MIC_MUTE"),
    ("Sidetone", "GET_SIDETONE"), ("Sidetone level", "GET_SIDETONE_LEVEL"), ("Voice prompts", "GET_VOICE_PROMPT"),
    ("Playback mute", "GET_PLAYBACK_MUTE"), ("Onboard EQ slot", "GET_EQ_SLOT"), ("Mic boom (raw)", "GET_MIC_BOOM"),
    ("Headset info (raw)", "GET_INFO"),
]


def cmd_status(h: Headset, _a) -> int:
    print(f"{h.product_name}  [03F0:{h.product_id:04X}]")
    link = h.get(OP["GET_LINK"])
    if link is None:
        print("The dongle did not answer. Is the headset on? Close NGENUITY and replug the dongle."
              " (Linux: see README about usbcore quirks.)")
        return 1
    for label, key in STATUS_READS:
        r = link if key == "GET_LINK" else h.get(OP[key])
        print(f"  {label:<20} {decode_reply(r) if r else '(no reply)'}")
    return 0


def parse_duration(s: str) -> int:
    s = s.strip().lower()
    if s in ("never", "off", "0", "disable", "disabled"):
        return 0
    if s.endswith("s"):
        return int(float(s[:-1]))
    if s.endswith("h"):
        return int(round(float(s[:-1]) * 3600))
    if s.endswith("m") or s.endswith("min"):
        return int(round(float(s.rstrip("min")) * 60))
    return int(round(float(s) * 60))  # bare number = minutes


def onoff(s: str) -> bool:
    s = s.lower()
    if s in ("on", "1", "true", "yes", "enable"):
        return True
    if s in ("off", "0", "false", "no", "disable"):
        return False
    raise argparse.ArgumentTypeError("expected on/off")


def verify(h: Headset, set_pkt: List[int], get_op: int, label: str) -> int:
    h.request(set_pkt, 0.3)
    time.sleep(0.08)
    r = h.get(get_op)
    print(f"{label}: {decode_reply(r) if r else '(no reply — is the headset on?)'}")
    return 0 if r else 1


def cmd_auto_off(h, a):
    secs = parse_duration(a.value)
    if not 0 <= secs <= 0xFFFF:
        print("Auto-off must be between 0 and 65535 seconds (about 18 h).", file=sys.stderr)
        return 2
    if secs not in (0, 600, 1200, 1800):
        print(f"Note: {secs} s is not one of NGENUITY's values (never/10/20/30 min); check the read-back.")
    return verify(h, auto_off_packet(secs), OP["GET_AUTO_OFF"], "Auto power-off")


def simple_toggle(set_key, get_key, label):
    def run(h, a):
        return verify(h, packet(RW_SET, OP[set_key], [1 if a.state else 0]), OP[get_key], label)
    return run


def cmd_sidetone_level(h, a):
    if not -128 <= a.level <= 127:
        print("level must be -128..127", file=sys.stderr)
        return 2
    return verify(h, packet(RW_SET, OP["SET_SIDETONE_LEVEL"], [a.level & 0xFF]), OP["GET_SIDETONE_LEVEL"], "Sidetone level")


def cmd_eq_slot(h, a):
    if not 0 <= a.slot <= 5:
        print("slot must be 0..5", file=sys.stderr)
        return 2
    return verify(h, packet(RW_SET, OP["SET_EQ_SLOT"], [a.slot]), OP["GET_EQ_SLOT"], "Onboard EQ slot")


def cmd_eq(h, a):
    if a.preset:
        gains = EQ_PRESETS[a.preset]
    else:
        if len(a.gains) != 10:
            print(f"Give 10 gains in dB for {', '.join(str(f) for f in EQ_BANDS)} Hz (or --preset).", file=sys.stderr)
            return 2
        gains = a.gains
    limit = 12 if a.allow_12db else 8
    if any(abs(g) > limit for g in gains):
        print(f"Gains must be within ±{limit} dB (NGENUITY 3 uses ±8; --allow-12db for ±12).", file=sys.stderr)
        return 2
    for p in eq_packets(gains, depop=not a.no_depop):
        h.request(p, 0.3)
    print("EQ set: " + "  ".join(f"{f if f < 1000 else str(f // 1000) + 'k'}:{g:+.1f}" for f, g in zip(EQ_BANDS, gains)))
    return 0


def parse_hex_bytes(tokens: Sequence[str]) -> List[int]:
    out = []
    for t in tokens:
        t = t.lower().replace("0x", "").replace(",", "")
        if len(t) > 2:
            if len(t) % 2:
                raise ValueError(f"odd-length hex '{t}'")
            out += [int(t[i:i + 2], 16) for i in range(0, len(t), 2)]
        elif t:
            out.append(int(t, 16))
    if any(not 0 <= b <= 255 for b in out):
        raise ValueError("bytes must be 00..FF")
    return out


def cmd_get(h, a):
    op = parse_hex_bytes([a.opcode])[0]
    r = h.get(op)
    if not r:
        print("(no reply)")
        return 1
    print(f"{hexs(trim(r, 8))}\n=> {decode_reply(r)}")
    return 0


def cmd_set(h, a):
    op = parse_hex_bytes([a.opcode])[0]
    args = parse_hex_bytes(a.args)
    if op not in OP_NAMES and not a.yes:
        print(f"0x{op:02X} is not a known SET opcode; add --yes if you're sure.", file=sys.stderr)
        return 2
    r = h.set(op, args)
    print(hexs(trim(r, 8)) if r else "(sent, no ack)")
    return 0


def cmd_raw(h, a):
    data = parse_hex_bytes(a.bytes)
    if not data:
        return 2
    if data[0] == REPORT_CMD and len(data) > 5:
        r = h.request(data, 1.0)
        print(hexs(trim(r, 8)) if r else "(no matching reply)")
    else:
        h.write(data)
        time.sleep(0.3)
        for r in h.read_all():
            print(hexs(trim(r, 8)))
    return 0


def cmd_scan(h, a):
    lo, hi = parse_hex_bytes([a.start])[0], parse_hex_bytes([a.end])[0]
    if not a.yes:
        print(f"This sends GET for opcodes 0x{lo:02X}-0x{hi:02X}. GETs should be read-only, but unknown opcodes are"
              " unknown. Re-run with --yes to go ahead.")
        return 2
    for op in range(lo, hi + 1):
        r = h.get(op, a.op_timeout)
        if r:
            name = OP_NAMES.get(op, "")
            print(f"0x{op:02X} {name:<20} {hexs(trim(r[6:], 4))}")
    return 0


def cmd_listen(h, a):
    print("Listening for events (Ctrl+C to stop)…")
    h.on_input = lambda r: print(time.strftime("%H:%M:%S"), describe_input(r), flush=True)
    try:
        while True:
            h.read_all()
            time.sleep(0.02)
    except KeyboardInterrupt:
        return 0


def cmd_list(_h, _a):
    if hid is None:
        print("pip install hidapi")
        return 1
    found = False
    for d in hid.enumerate(VID, 0):
        tag = PRODUCTS.get(d.get("product_id"), "")
        found = found or bool(tag)
        print(f"03F0:{d['product_id']:04X} if={d.get('interface_number')} usage={d.get('usage_page', 0):04X}:"
              f"{d.get('usage', 0):04X} {d.get('product_string')!s:<30} {tag}")
    if not found:
        print("No Cloud III S found.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="Control a HyperX Cloud III S Wireless without NGENUITY.")
    ap.add_argument("-v", "--verbose", action="store_true", help="print raw packets")
    ap.add_argument("--timeout", type=float, default=1.0, help="reply timeout in seconds (default 1)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="read everything").set_defaults(fn=cmd_status)
    sub.add_parser("list", help="list HP/HyperX HID interfaces").set_defaults(fn=cmd_list, no_device=True)

    p = sub.add_parser("auto-off", help="auto power-off: never | 10 | 20 | 30 | 90m | 45s | 2h")
    p.add_argument("value")
    p.set_defaults(fn=cmd_auto_off)

    for name, sk, gk, label, helptext in [
        ("sidetone", "SET_SIDETONE", "GET_SIDETONE", "Sidetone", "hear your own mic: on|off"),
        ("mic-mute", "SET_MIC_MUTE", "GET_MIC_MUTE", "Mic mute", "on|off"),
        ("voice-prompts", "SET_VOICE_PROMPT", "GET_VOICE_PROMPT", "Voice prompts", "on|off"),
        ("playback-mute", "SET_PLAYBACK_MUTE", "GET_PLAYBACK_MUTE", "Playback mute", "on|off (experimental)"),
    ]:
        p = sub.add_parser(name, help=helptext)
        p.add_argument("state", type=onoff)
        p.set_defaults(fn=simple_toggle(sk, gk, label))

    p = sub.add_parser("sidetone-level", help="sidetone level, signed (experimental; NGENUITY 3 starts at -6)")
    p.add_argument("level", type=int)
    p.set_defaults(fn=cmd_sidetone_level)

    p = sub.add_parser("eq", help="10-band EQ in dB (32 64 125 250 500 1k 2k 4k 8k 16k)")
    p.add_argument("gains", nargs="*", type=float)
    p.add_argument("--preset", choices=sorted(EQ_PRESETS))
    p.add_argument("--allow-12db", action="store_true", help="allow ±12 dB instead of NGENUITY's ±8")
    p.add_argument("--no-depop", action="store_true", help="don't set the de-pop flag on the last band")
    p.set_defaults(fn=cmd_eq)

    p = sub.add_parser("eq-slot", help="onboard EQ slot 0-5 (experimental)")
    p.add_argument("slot", type=int)
    p.set_defaults(fn=cmd_eq_slot)

    p = sub.add_parser("get", help="send GET for an opcode (hex)")
    p.add_argument("opcode")
    p.set_defaults(fn=cmd_get)

    p = sub.add_parser("set", help="send SET opcode + args (hex)")
    p.add_argument("opcode")
    p.add_argument("args", nargs="*")
    p.add_argument("--yes", action="store_true", help="allow unknown opcodes")
    p.set_defaults(fn=cmd_set)

    p = sub.add_parser("raw", help="send raw bytes, report id first (hex)")
    p.add_argument("bytes", nargs="+")
    p.set_defaults(fn=cmd_raw)

    p = sub.add_parser("scan", help="probe GET opcodes in a range")
    p.add_argument("start", nargs="?", default="00")
    p.add_argument("end", nargs="?", default="7F")
    p.add_argument("--op-timeout", type=float, default=0.25, help="seconds to wait per opcode")
    p.add_argument("--yes", action="store_true")
    p.set_defaults(fn=cmd_scan)

    sub.add_parser("listen", help="print events until Ctrl+C").set_defaults(fn=cmd_listen)
    return ap


def main(argv: Optional[Sequence[str]] = None, hid_module=None) -> int:
    a = build_parser().parse_args(argv)
    if getattr(a, "no_device", False):
        return a.fn(None, a)
    try:
        with Headset(timeout=a.timeout, verbose=a.verbose, hid_module=hid_module) as h:
            return a.fn(h, a)
    except NoDevice as e:
        print(e, file=sys.stderr)
        return 1
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
