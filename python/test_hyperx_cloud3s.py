"""
Tests for hyperx_cloud3s.py against a fake hidapi module that behaves like the
dongle (same model as tests/mock-hid.js). Run:  python -m unittest -v
"""
import io
import os
import sys
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hyperx_cloud3s as hx  # noqa: E402


class FakeDongle:
    def __init__(self):
        self.st = dict(link=2, battery=87, charging=1, color=12, mic=0, sidetone=0, stl=0xFA, vp=1,
                       auto_off=1200, pbmute=0, slot=0, boom=1, eq=[0.0] * 10, depop=[0] * 10)
        self.sent = []
        self.queue = []

    def handle(self, p):
        self.sent.append(list(p))
        if p[0] != 0x0C:
            return
        rw, op = p[3], p[5]
        r = [0x0C, 2, 3, rw, 0, op] + [0] * 58
        s = self.st
        if rw == 1:
            m = {0x02: [s["link"]], 0x04: [s["mic"]], 0x06: [s["battery"]], 0x14: [s["vp"]], 0x16: [s["sidetone"]],
                 0x1C: [s["slot"]], 0x43: [s["boom"]], 0x45: [s["stl"]], 0x47: [s["pbmute"]], 0x48: [s["charging"]],
                 0x49: [3, 1, 2, 4], 0x4B: [s["auto_off"] >> 8, s["auto_off"] & 255], 0x4D: [s["color"]]}
            if op not in m:
                return
            for i, v in enumerate(m[op]):
                r[6 + i] = v
        else:
            v = p[6]
            if op == 0x4A:
                s["auto_off"] = (p[6] << 8) | p[7]
            elif op == 0x0D:
                s["sidetone"] = v
                self.queue.append([0x0D, 2, 3, 0, 5, v] + [0] * 58)
            elif op == 0x0B:
                s["vp"] = v
            elif op == 0x01:
                s["mic"] = v
            elif op == 0x44:
                s["stl"] = v
            elif op == 0x46:
                s["pbmute"] = v
            elif op == 0x0F:
                s["slot"] = v
            elif op == 0x5F:
                g = (p[7] << 8) | p[8]
                s["eq"][p[6]] = (g - 65536 if g > 32767 else g) / 100
                s["depop"][p[6]] = p[9]
            else:
                return
            r[6:10] = p[6:10]
        self.queue.append(r)


class FakeHid:
    """Mimics cython-hidapi: three collections, only the 0x01C0 one takes report 0x0C."""

    def __init__(self, dongle, pid=0x06BE):
        self.dongle = dongle
        self.pid = pid

    def enumerate(self, vid, pid):
        base = dict(vendor_id=0x03F0, product_id=self.pid, interface_number=3, product_string="HyperX Cloud III S Wireless")
        return [dict(base, path=b"col01", usage_page=0x000C, usage=1),
                dict(base, path=b"col02", usage_page=0xFF13, usage=1),
                dict(base, path=b"col05", usage_page=0x01C0, usage=1),
                dict(base, path=b"other", product_id=0x0001, usage_page=1, usage=2)]

    def device(self):
        hid = self

        class Dev:
            def open_path(self, path):
                self.path = path

            def set_nonblocking(self, on):
                pass

            def write(self, data):
                if self.path != b"col05":
                    return -1
                hid.dongle.handle(list(data))
                return len(data)

            def read(self, n):
                if self.path == b"col05" and hid.dongle.queue:
                    return hid.dongle.queue.pop(0)
                return []

            def close(self):
                pass

        return Dev()


def run(*argv, dongle=None, pid=0x06BE):
    dongle = dongle or FakeDongle()
    out = io.StringIO()
    with redirect_stdout(out):
        code = hx.main(["--timeout", "0.2", *argv], hid_module=FakeHid(dongle, pid))
    return code, out.getvalue(), dongle


class PacketTests(unittest.TestCase):
    def test_header(self):
        p = hx.packet(hx.RW_GET, 0x06)
        self.assertEqual(p[:7], [0x0C, 0x02, 0x03, 0x01, 0x00, 0x06, 0x00])
        self.assertEqual(len(p), 64)

    def test_auto_off(self):
        self.assertEqual(hx.auto_off_packet(0)[5:8], [0x4A, 0x00, 0x00])
        self.assertEqual(hx.auto_off_packet(1800)[5:8], [0x4A, 0x07, 0x08])
        with self.assertRaises(ValueError):
            hx.auto_off_packet(70000)

    def test_eq_encoding(self):
        self.assertEqual(hx.eq_band_packet(0, 6)[5:10], [0x5F, 0, 0x02, 0x58, 0])
        self.assertEqual(hx.eq_band_packet(3, -2.5)[5:10], [0x5F, 3, 0xFF, 0x06, 0])
        pk = hx.eq_packets([1] * 10, depop=True)
        self.assertEqual([p[9] for p in pk], [0] * 9 + [1])

    def test_durations(self):
        self.assertEqual(hx.parse_duration("never"), 0)
        self.assertEqual(hx.parse_duration("20"), 1200)
        self.assertEqual(hx.parse_duration("90m"), 5400)
        self.assertEqual(hx.parse_duration("10min"), 600)
        self.assertEqual(hx.parse_duration("45s"), 45)
        self.assertEqual(hx.parse_duration("2h"), 7200)

    def test_decode(self):
        self.assertEqual(hx.decode_reply([0x0C, 2, 3, 1, 0, 0x45, 0xFD, 0]), "-3")
        self.assertEqual(hx.decode_reply([0x0C, 2, 3, 1, 0, 0x4B, 0, 0]), "never (0 s)")
        self.assertIn("no value", hx.decode_reply([0x0C, 2, 3, 1, 0, 0x06, 0xFF, 0]))
        self.assertEqual(hx.describe_input([0x0D, 2, 3, 0, 1, 55]), "event battery: 55 %")
        self.assertEqual(hx.describe_input([0x0F, 0x08]), "button play/pause")


class CliTests(unittest.TestCase):
    def test_status(self):
        code, out, d = run("status")
        self.assertEqual(code, 0)
        self.assertIn("87 %", out)
        self.assertIn("White / Purple", out)
        self.assertIn("20 min (1200 s)", out)
        self.assertIn("charging", out)
        self.assertTrue(all(p[0] == 0x0C and len(p) == 64 for p in d.sent))

    def test_rev2_pid(self):
        code, out, _ = run("status", pid=0x02CC)
        self.assertEqual(code, 0)
        self.assertIn("rev. 2", out)

    def test_auto_off_never(self):
        code, out, d = run("auto-off", "never")
        self.assertEqual(code, 0)
        self.assertEqual(d.st["auto_off"], 0)
        self.assertIn("never (0 s)", out)
        self.assertEqual(d.sent[0][:8], [0x0C, 2, 3, 0, 0, 0x4A, 0, 0])

    def test_auto_off_custom(self):
        code, out, d = run("auto-off", "90m")
        self.assertEqual(d.st["auto_off"], 5400)
        self.assertIn("not one of NGENUITY's values", out)
        code, _, _ = run("auto-off", "2000m")
        self.assertEqual(code, 2)

    def test_toggles(self):
        _, out, d = run("sidetone", "on")
        self.assertEqual(d.st["sidetone"], 1)
        self.assertIn("Sidetone: on", out)
        _, out, d = run("voice-prompts", "off")
        self.assertEqual(d.st["vp"], 0)
        _, _, d = run("playback-mute", "on")
        self.assertEqual(d.sent[0][5:7], [0x46, 1])

    def test_sidetone_level(self):
        _, out, d = run("sidetone-level", "-3")
        self.assertEqual(d.st["stl"], 0xFD)
        self.assertIn("Sidetone level: -3", out)

    def test_eq(self):
        _, _, d = run("eq", "--preset", "bass")
        self.assertEqual(d.st["eq"], [6, 5, 4, 2, 0, 0, 0, 0, 0, 0])
        self.assertEqual(d.st["depop"], [0] * 9 + [1])
        code, _, _ = run("eq", "1", "2")
        self.assertEqual(code, 2)
        code, _, _ = run("eq", *(["10"] * 10))
        self.assertEqual(code, 2)
        code, _, d = run("eq", "--allow-12db", *(["10"] * 10))
        self.assertEqual(code, 0)
        self.assertEqual(d.st["eq"], [10.0] * 10)

    def test_get_set_scan(self):
        _, out, _ = run("get", "48")
        self.assertIn("charging", out)
        code, _, _ = run("set", "77", "01")
        self.assertEqual(code, 2)
        _, out, _ = run("scan", "00", "1f", "--op-timeout", "0.02", "--yes")
        self.assertEqual(len(out.strip().splitlines()), 6)

    def test_no_device(self):
        class Empty(FakeHid):
            def enumerate(self, vid, pid):
                return []
        out = io.StringIO()
        err = io.StringIO()
        from contextlib import redirect_stderr
        with redirect_stdout(out), redirect_stderr(err):
            code = hx.main(["status"], hid_module=Empty(FakeDongle()))
        self.assertEqual(code, 1)
        self.assertIn("No Cloud III S dongle found", err.getvalue())


if __name__ == "__main__":
    unittest.main()
