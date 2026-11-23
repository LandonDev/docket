"""Boxes the pixels of each target's fill in the slide's picture and sets them beside the outline's box."""
import json, sys
import fitz
import numpy as np
pdf, outline, targets, width = sys.argv[1], json.load(open(sys.argv[2])), json.load(open(sys.argv[3])), int(sys.argv[4])
page = fitz.open(pdf)[0]
z = width / page.rect.width
pix = page.get_pixmap(matrix=fitz.Matrix(z, z), alpha=False)
a = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3).astype('int16')
rows = []
for t in targets:
    sh = next(s for s in outline['slides'][0]['shapes'] if s['id'] == t['shape'])
    px = np.array([int(t['fill'][i:i + 2], 16) for i in (0, 2, 4)], dtype='int16')
    y, x = np.where(np.max(np.abs(a - px), axis=2) <= 3)
    if len(x) == 0:
        rows.append({**t, 'kind': sh['kind'], 'found': False})
        continue
    # In the shape's own frame: along its top edge and down its left edge, so a turned shape is held to its own box
    # (the box around a turned ellipse's pixels is smaller than the box around its turned box).
    q = [(px_ * pix.width, py_ * pix.height) for px_, py_ in sh['quad']]
    (ax, ay), (bx, by), _, (dx, dy) = q
    w = float(np.hypot(bx - ax, by - ay)); h = float(np.hypot(dx - ax, dy - ay))
    ux, uy = (bx - ax) / w, (by - ay) / w
    vx, vy = (dx - ax) / h, (dy - ay) / h
    # pixel centres
    lx = (x + 0.5 - ax) * ux + (y + 0.5 - ay) * uy
    ly = (x + 0.5 - ax) * vx + (y + 0.5 - ay) * vy
    drawn = [float(lx.min() - 0.5), float(ly.min() - 0.5), float(lx.max() + 0.5), float(ly.max() + 0.5)]
    ours = [0.0, 0.0, w, h]
    rows.append({**t, 'kind': sh['kind'], 'found': True, 'rot': sh.get('rot', 0), 'box': [round(w, 1), round(h, 1)], 'drawn': [round(v, 1) for v in drawn], 'px': round(max(abs(ours[i] - drawn[i]) for i in range(4)), 2)})
json.dump({'width': pix.width, 'height': pix.height, 'shapes': rows}, open(sys.argv[5], 'w'), indent=1)
for r in rows:
    print(r['name'], r['kind'], r.get('px'), r.get('found'))
