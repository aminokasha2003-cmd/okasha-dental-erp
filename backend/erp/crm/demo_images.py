"""Small placeholder pictures and documents for the demo patient files, drawn
here in plain Python (no image library, nothing downloaded): panoramic and
periapical X-ray look-alikes, intra-oral photos, a signature, and one-page PDFs.
They are clearly demo material, not real images."""

import base64
import math
import random
import struct
import zlib


# ------------------------------------------------------------------ PNG

def png(width, height, rows, color=False):
    """rows: list of bytes, one per line (grey or RGB)."""
    raw = b"".join(b"\x00" + bytes(r) for r in rows)

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2 if color else 0, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


class Canvas:
    def __init__(self, width, height, base=0.0):
        self.w, self.h = width, height
        self.px = [base] * (width * height)

    def blob(self, cx, cy, rx, ry, value, soft=0.35, angle=0.0, mode="add"):
        """A soft-edged ellipse: added to the picture, or replacing it (mode 'max'/'set')."""
        r = max(rx, ry)
        x0, x1 = max(0, int(cx - r - 1)), min(self.w, int(cx + r + 2))
        y0, y1 = max(0, int(cy - r - 1)), min(self.h, int(cy + r + 2))
        ca, sa = math.cos(angle), math.sin(angle)
        px, w = self.px, self.w
        for y in range(y0, y1):
            dy = y - cy
            for x in range(x0, x1):
                dx = x - cx
                u = (dx * ca + dy * sa) / rx
                v = (-dx * sa + dy * ca) / ry
                d = u * u + v * v
                if d >= 1:
                    continue
                a = min(1.0, (1 - d) / soft)
                i = y * w + x
                if mode == "add":
                    px[i] += value * a
                elif mode == "max":
                    px[i] = max(px[i], value * a + px[i] * (1 - a))
                else:
                    px[i] = px[i] * (1 - a) + value * a

    def grey(self, rng, noise=6, gamma=1.0):
        rows = []
        for y in range(self.h):
            row = bytearray(self.w)
            for x in range(self.w):
                v = self.px[y * self.w + x] + (rng.random() - 0.5) * noise
                v = max(0.0, min(255.0, v))
                row[x] = int(255 * (v / 255) ** gamma)
            rows.append(row)
        return png(self.w, self.h, rows)


def tooth(c, cx, cy, up, width, rng, filling=False, crown=False, rct=False, implant=False, roots=1, angle=0.0):
    """One tooth seen from the side: crown, root(s), pulp. `up` is +1 for upper teeth (roots go up)."""
    s = -up
    if implant:
        for k in range(8):
            c.blob(cx, cy + s * (width * 0.55 + k * width * 0.17), width * 0.2, width * 0.07, 235, soft=0.3, mode="max")
        c.blob(cx, cy + s * width * 0.2, width * 0.24, width * 0.3, 220, soft=0.3, mode="max")
        c.blob(cx, cy, width * 0.46, width * 0.5, 248, soft=0.2, mode="max")
        return
    root_len = width * (1.25 if roots == 1 else 1.05)
    for k in range(roots):
        off = (k - (roots - 1) / 2) * width * 0.36
        rcx, rcy = cx + off, cy + s * (width * 0.35 + root_len * 0.75)
        c.blob(rcx, rcy, width * (0.19 if roots > 1 else 0.24), root_len, 115, soft=0.5, angle=angle + off * 0.004 * s)
        c.blob(rcx, rcy, width * 0.045, root_len * 0.85, 140 if rct else -40, soft=0.6, angle=angle)
    c.blob(cx, cy, width * 0.5, width * 0.66, 135, soft=0.35)
    c.blob(cx, cy + s * width * 0.12, width * 0.17, width * 0.25, -38, soft=0.7)
    if crown:
        c.blob(cx, cy, width * 0.52, width * 0.56, 248, soft=0.15, mode="max")
    if filling:
        c.blob(cx + rng.uniform(-3, 3), cy - s * width * 0.28, width * 0.26, width * 0.17, 255, soft=0.2, mode="max")


def panoramic(seed):
    rng = random.Random(seed)
    w, h = 620, 300
    c = Canvas(w, h, 12)
    # Jaw bones, sinuses and the spine shadows at the sides.
    c.blob(w / 2, h * 0.33, w * 0.47, h * 0.24, 50, soft=0.9)
    c.blob(w / 2, h * 0.68, w * 0.45, h * 0.30, 66, soft=0.9)
    c.blob(w * 0.33, h * 0.18, w * 0.11, h * 0.08, -20, soft=0.9)
    c.blob(w * 0.67, h * 0.18, w * 0.11, h * 0.08, -20, soft=0.9)
    for side in (0.05, 0.95):
        c.blob(w * side, h * 0.55, w * 0.05, h * 0.5, 32, soft=0.9)
    gone = set(rng.sample([0, 1, 7, 8, 16, 17, 23, 24], rng.randint(0, 3)))
    implants = {g for g in gone if rng.random() < 0.5}
    widths = [21, 20, 21, 23, 24, 31, 33, 31]  # central incisor to wisdom tooth
    for row, up in ((0, 1), (1, -1)):
        for side in (-1, 1):
            x = 2.0
            for k in range(8):
                width = widths[k] * (0.92 if up == -1 and k < 3 else 1)
                x += width * 0.5
                index = row * 16 + (0 if side < 0 else 8) + (7 - k)
                pos = x / 300
                cx = w / 2 + side * x
                x += width * 0.5 + 1
                if index in gone and index not in implants:
                    continue
                cy = (h * 0.45 if up == 1 else h * 0.575) - 26 * pos * pos
                tooth(c, cx, cy, up, width, rng, filling=k > 2 and rng.random() < 0.2, crown=k > 3 and rng.random() < 0.06,
                      rct=rng.random() < 0.05, implant=index in implants, roots=2 if k > 4 else 1, angle=-side * up * pos * 0.15)
    return c.grey(rng, noise=3, gamma=0.9)


def periapical(seed):
    rng = random.Random(seed)
    w, h = 300, 380
    c = Canvas(w, h, 30)
    c.blob(w / 2, h / 2, w * 0.7, h * 0.7, 45, soft=1)
    for k, cx in enumerate((w * 0.2, w * 0.5, w * 0.8)):
        tooth(c, cx, h * 0.28, -1, 62, rng, filling=k == 1 and rng.random() < 0.7, crown=k == 2 and rng.random() < 0.4,
              rct=k == 1 and rng.random() < 0.5, roots=2)
    return c.grey(rng, noise=4, gamma=0.95)


def intraoral(seed):
    """A front-teeth photo look-alike in colour: lips, gums and teeth."""
    rng = random.Random(seed)
    w, h = 420, 280
    shade = rng.uniform(0.92, 1.0)
    # Tooth edges from the midline outwards, narrowing with the curve of the arch.
    edges = [0.0]
    for k in range(7):
        edges.append(edges[-1] + [0.17, 0.135, 0.12, 0.105, 0.1, 0.095, 0.09][k] * (1 - 0.25 * edges[-1]))
    cy = h * 0.5
    rows = []
    for y in range(h):
        row = bytearray()
        for x in range(w):
            nx, ny = (x - w / 2) / (w / 2), (y - cy) / (h / 2)
            r, g, b = 64, 16, 24
            if nx * nx + (ny / 0.78) ** 2 < 1:
                r, g, b = 190, 86, 98  # lips
            if nx * nx / 0.86 + (ny / 0.6) ** 2 < 1:
                r, g, b = 120, 34, 44  # inside the mouth
                ax = abs(nx)
                k = next((i for i in range(7) if edges[i] <= ax < edges[i + 1]), None)
                if k is not None:
                    t = (ax - edges[k]) / (edges[k + 1] - edges[k])
                    arch = math.sin(math.pi * t)
                    up_h = 0.42 * (1 - 0.45 * ax) * (0.72 + 0.28 * arch)
                    lo_h = 0.33 * (1 - 0.45 * ax) * (0.72 + 0.28 * arch)
                    gum_up, gum_lo = up_h + 0.12, lo_h + 0.12
                    if -gum_up < ny < gum_lo:
                        r, g, b = 222, 128, 136  # gums
                    tooth_up = -up_h < ny < -0.01 - 0.03 * (1 - arch) ** 3
                    tooth_lo = 0.02 + 0.03 * (1 - arch) ** 3 < ny < lo_h and k < 6
                    if tooth_up or tooth_lo:
                        depth = 1 - 0.22 * ax - 0.18 * (1 - arch) ** 2
                        tone = (246 * shade * depth, 240 * shade * depth, 222 * shade * depth)
                        if tooth_lo:
                            tone = tuple(v * 0.9 for v in tone)
                        r, g, b = (int(v) for v in tone)
            j = rng.randint(-3, 3)
            row += bytes((max(0, min(255, r + j)), max(0, min(255, g + j)), max(0, min(255, b + j))))
        rows.append(row)
    return png(w, h, rows, color=True)


def signature_data_url(seed):
    rng = random.Random(seed)
    w, h = 260, 80
    c = Canvas(w, h, 255)
    x, y = 20.0, 45.0
    for _ in range(140):
        x += rng.uniform(0.8, 1.9)
        y += math.sin(x / rng.uniform(5, 9)) * 2.2 + rng.uniform(-1, 1)
        y = min(max(y, 15), 65)
        c.blob(x, y, 1.8, 1.8, 30, soft=0.6, mode="set")
    return "data:image/png;base64," + base64.b64encode(c.grey(rng, noise=0)).decode()


# ------------------------------------------------------------------ PDF

def _pdf_text(value):
    return value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)").encode("latin-1", "replace").decode("latin-1")


def pdf(title, lines, footer="Okasha Dental Clinic - demo document"):
    """A one-page A4 PDF with a heading and lines of text (English only)."""
    ops = ["0.11 0.36 0.33 rg", "0 800 595 42 re f", "BT /F2 16 Tf 1 1 1 rg 40 814 Td (Okasha Dental Clinic) Tj ET",
           f"BT /F2 18 Tf 0.1 0.1 0.1 rg 40 760 Td ({_pdf_text(title)}) Tj ET"]
    y = 728
    for line in lines:
        bold = line.startswith("**")
        text = line.strip("*")
        ops.append(f"BT /{'F2' if bold else 'F1'} 11 Tf 0.15 0.15 0.15 rg 40 {y} Td ({_pdf_text(text)}) Tj ET")
        y -= 20 if text else 12
    ops.append("0.6 0.6 0.6 RG 40 90 m 250 90 l S")
    ops.append(f"BT /F1 9 Tf 0.4 0.4 0.4 rg 40 60 Td ({_pdf_text(footer)}) Tj ET")
    stream = "\n".join(ops).encode("latin-1")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for n, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{n} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)
