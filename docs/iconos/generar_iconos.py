"""Genera los iconos de BLOOM, BLOOM Multitienda y Ciclo Lunar.

Cada símbolo se define en coordenadas unitarias (centro 0,0; cabe en un círculo de radio 1)
y se coloca en cada formato con la escala que respeta su zona segura:
  - icono «any» (esquinas redondeadas)      : radio del símbolo 0.31 del lado
  - maskable / iOS (sangrado completo)      : radio 0.27 (zona segura W3C: 0.40)
  - primer plano adaptativo Android (108dp) : radio 0.25 (zona segura: 33dp = 0.305)
  - icono redondo heredado (Android < 8)    : radio 0.29
  - favicon                                 : radio 0.36 (más grande para leerse a 16-32 px)
Uso: python3 generar_iconos.py SALIDA_DIR
"""
import math, sys, os, json

def crescent(cx, cy, R, theta, d, r):
    """Media luna = círculo (cx,cy,R) menos círculo desplazado d en la dirección theta, radio r."""
    ux, uy = math.cos(theta), math.sin(theta)
    nx, ny = -uy, ux
    a = (R*R - r*r + d*d) / (2*d)
    h = math.sqrt(R*R - a*a)
    p1 = (cx + a*ux + h*nx, cy + a*uy + h*ny)
    p2 = (cx + a*ux - h*nx, cy + a*uy - h*ny)
    large_inner = 1 if a > d else 0
    f = lambda v: f"{v:.4f}".rstrip('0').rstrip('.')
    return (f"M{f(p1[0])} {f(p1[1])}A{f(R)} {f(R)} 0 1 1 {f(p2[0])} {f(p2[1])}"
            f"A{f(r)} {f(r)} 0 {large_inner} 0 {f(p1[0])} {f(p1[1])}Z")

def star(cx, cy, L, w=0.16):
    """Estrella de cuatro puntas con lados cóncavos (curvas cuadráticas)."""
    k = L * w
    f = lambda v: f"{v:.4f}".rstrip('0').rstrip('.')
    pts = [(cx, cy-L), (cx+L, cy), (cx, cy+L), (cx-L, cy)]
    ctl = [(cx+k, cy-k), (cx+k, cy+k), (cx-k, cy+k), (cx-k, cy-k)]
    s = f"M{f(pts[0][0])} {f(pts[0][1])}"
    for i in range(4):
        c, p = ctl[i], pts[(i+1) % 4]
        s += f"Q{f(c[0])} {f(c[1])} {f(p[0])} {f(p[1])}"
    return s + "Z"

# ---------- Paletas y símbolos (coordenadas unitarias) ----------
APPS = {
  "bloom": {
    "nombre": "BLOOM · luna y estrella",
    "fondo": ("#341A40", "#1F0F27"),          # berenjena
    "capas": [
      # media luna lavanda abierta a la izquierda, contorno dorado mate
      {"d": crescent(0.12, 0.0, 0.80, math.radians(196), 0.42, 0.70),
       "relleno": ("#D9C8EE", "#B59CD8"), "trazo": "#C2A36B", "grosor": 0.035},
      {"d": star(-0.54, -0.16, 0.34), "relleno": ("#F0DDB4", "#D9BC84")},  # champán
    ],
  },
  "bloommultitienda": {
    "nombre": "BLOOM · estrella",
    "fondo": ("#66587A", "#4D4060"),          # violeta grisáceo
    "capas": [
      {"d": star(0.0, 0.0, 0.92), "relleno": ("#EED9AE", "#C9A466"), "trazo": "#B8955C", "grosor": 0.035},
    ],
  },
  "ciclolunar": {
    "nombre": "Ciclo Lunar",
    "fondo": ("#231C48", "#130F2A"),          # índigo muy oscuro
    "capas": [
      {"d": crescent(-0.10, 0.06, 0.84, math.radians(-38), 0.40, 0.70),
       "relleno": ("#D3C4FF", "#9F88EE")},
      {"d": star(0.52, -0.44, 0.20), "relleno": ("#ECE6FF", "#CFC4F5")},
    ],
  },
}

def symbol_svg(app, gid, scale, cx, cy, mono=False):
    out = []
    for i, c in enumerate(app["capas"]):
        g = f"{gid}s{i}"
        stroke = ""
        if c.get("trazo") and not mono:
            stroke = (f' stroke="{c["trazo"]}" stroke-width="{c["grosor"]}" stroke-linejoin="round"'
                      ' paint-order="stroke"')
        fill = "#FFFFFF" if mono else f"url(#{g})"
        out.append(f'<path d="{c["d"]}" fill="{fill}"{stroke}/>')
    defs = "" if mono else "".join(
        f'<linearGradient id="{gid}s{i}" x1="-1" y1="-1" x2="1" y2="1" gradientUnits="userSpaceOnUse">'
        f'<stop offset="0" stop-color="{c["relleno"][0]}"/><stop offset="1" stop-color="{c["relleno"][1]}"/></linearGradient>'
        for i, c in enumerate(app["capas"]))
    body = f'<g transform="translate({cx} {cy}) scale({scale})">{"".join(out)}</g>'
    return defs, body

def svg(app, size, kind, gid="i"):
    """kind: any | round | maskable | foreground | background | monochrome | favicon"""
    W = size
    bg0, bg1 = app["fondo"]
    bgdef = (f'<linearGradient id="{gid}bg" x1="0" y1="0" x2="{W}" y2="{W}" gradientUnits="userSpaceOnUse">'
             f'<stop offset="0" stop-color="{bg0}"/><stop offset="1" stop-color="{bg1}"/></linearGradient>')
    radius = {"any": 0.31, "round": 0.29, "maskable": 0.27, "foreground": 0.25, "monochrome": 0.25, "favicon": 0.36}.get(kind, 0)
    defs, body = ("", "")
    if kind != "background":
        defs, body = symbol_svg(app, gid, radius*W, W/2, W/2, mono=(kind == "monochrome"))
    rect = ""
    if kind in ("any", "favicon"):
        rect = f'<rect width="{W}" height="{W}" rx="{W*0.225:g}" fill="url(#{gid}bg)"/>'
    elif kind == "round":
        rect = f'<circle cx="{W/2:g}" cy="{W/2:g}" r="{W/2:g}" fill="url(#{gid}bg)"/>'
    elif kind in ("maskable", "background"):
        rect = f'<rect width="{W}" height="{W}" fill="url(#{gid}bg)"/>'
    if kind in ("foreground", "monochrome"):
        bgdef = ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {W}" width="{W}" height="{W}">'
            f'<defs>{bgdef}{defs}</defs>{rect}{body}</svg>')

if __name__ == "__main__":
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    for key, app in APPS.items():
        for kind in ("any", "round", "maskable", "foreground", "background", "monochrome", "favicon"):
            size = 108 if kind in ("foreground", "background", "monochrome") else (64 if kind == "favicon" else 512)
            with open(os.path.join(out, f"{key}-{kind}.svg"), "w") as fh:
                fh.write(svg(app, size, kind) + "\n")
    with open(os.path.join(out, "paletas.json"), "w") as fh:
        json.dump({k: {"nombre": a["nombre"], "fondo": a["fondo"]} for k, a in APPS.items()}, fh, ensure_ascii=False, indent=2)
