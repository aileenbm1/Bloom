"""Genera SVG y PNG finales y los copia a cada repositorio.
Uso: python3 aplicar.py DIR_TRABAJO RAIZ_REPOS [DIR_ENTREGABLES]
Requiere Chromium + Playwright (node rasterizar.mjs) y Pillow (solo para leer tamaños de splash)."""
import os, sys, json, glob, subprocess, shutil
sys.path.insert(0, os.path.dirname(__file__))
from generar_iconos import APPS, svg, symbol_svg
from PIL import Image

work, repos = sys.argv[1], sys.argv[2]
here = os.path.dirname(os.path.abspath(__file__))
entrega = sys.argv[3] if len(sys.argv) > 3 else os.path.join(work, "entregables")
os.makedirs(work, exist_ok=True)
jobs = []

def write_svg(app, kind, size_hint=None):
    size = 108 if kind in ("foreground", "background", "monochrome") else (64 if kind == "favicon" else 512)
    p = os.path.join(work, f"{app}-{kind}.svg")
    open(p, "w").write(svg(APPS[app], size, kind) + "\n")
    return p

def png(app, kind, dest, size, opaque=False):
    jobs.append({"svg": write_svg(app, kind), "png": dest, "size": size, "opaque": opaque})

def splash_svg(app, w, h, bg):
    m = min(w, h)
    defs, body = symbol_svg(APPS[app], "sp", 0.085 * m, w / 2, h / 2)
    p = os.path.join(work, f"splash-{w}x{h}.svg")
    open(p, "w").write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}"><defs>{defs}</defs>'
                       f'<rect width="{w}" height="{h}" fill="{bg}"/>{body}</svg>')
    return p

# ---------- Entregables individuales (PNG 1024 + SVG editables) ----------
for app in APPS:
    d = os.path.join(entrega, app)
    os.makedirs(d, exist_ok=True)
    for kind in ("any", "maskable", "foreground", "background", "monochrome", "favicon", "round"):
        shutil.copy(write_svg(app, kind), os.path.join(d, f"{app}-{kind}.svg"))
    png(app, "any", os.path.join(d, f"{app}-icono-1024.png"), 1024)
    png(app, "maskable", os.path.join(d, f"{app}-maskable-1024.png"), 1024, True)
    png(app, "foreground", os.path.join(d, f"{app}-adaptativo-primer-plano-432.png"), 432)
    png(app, "background", os.path.join(d, f"{app}-adaptativo-fondo-432.png"), 432, True)

# ---------- Ciclo Lunar: PWA + Android (Capacitor) ----------
cl = os.path.join(repos, "CicloLunar")
if os.path.isdir(cl):
    shutil.copy(write_svg("ciclolunar", "favicon"), os.path.join(cl, "public/favicon.svg"))
    png("ciclolunar", "any", os.path.join(cl, "public/icons/icon-192.png"), 192)
    png("ciclolunar", "any", os.path.join(cl, "public/icons/icon-512.png"), 512)
    png("ciclolunar", "maskable", os.path.join(cl, "public/icons/icon-maskable-512.png"), 512, True)
    png("ciclolunar", "maskable", os.path.join(cl, "public/apple-touch-icon.png"), 180, True)
    res = os.path.join(cl, "android/app/src/main/res")
    for dens, f in {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}.items():
        png("ciclolunar", "foreground", f"{res}/mipmap-{dens}/ic_launcher_foreground.png", int(108 * f))
        png("ciclolunar", "monochrome", f"{res}/mipmap-{dens}/ic_launcher_monochrome.png", int(108 * f))
        png("ciclolunar", "any", f"{res}/mipmap-{dens}/ic_launcher.png", int(48 * f))
        png("ciclolunar", "round", f"{res}/mipmap-{dens}/ic_launcher_round.png", int(48 * f))
    for sp in glob.glob(f"{res}/drawable*/splash.png"):
        im = Image.open(sp).convert("RGB")
        bg = "#%02x%02x%02x" % im.getpixel((2, 2))
        jobs.append({"svg": splash_svg("ciclolunar", im.width, im.height, bg), "png": sp, "w": im.width, "h": im.height, "opaque": True})

# ---------- BLOOM (cuentas): PWA en Cloudflare Workers ----------
bl = os.path.join(repos, "bloom")
if os.path.isdir(bl):
    png("bloom", "favicon", os.path.join(bl, "public/favicon.png"), 64)
    png("bloom", "any", os.path.join(bl, "public/icons/icon-192.png"), 192)
    png("bloom", "any", os.path.join(bl, "public/icons/icon-512.png"), 512)
    png("bloom", "maskable", os.path.join(bl, "public/icons/maskable-512.png"), 512, True)
    png("bloom", "maskable", os.path.join(bl, "public/icons/apple-touch-icon.png"), 180, True)

# ---------- BLOOM Multitienda: PWA en Cloudflare Workers ----------
bm = os.path.join(repos, "bloommultitienda")
if os.path.isdir(bm):
    shutil.copy(write_svg("bloommultitienda", "favicon"), os.path.join(bm, "public/favicon.svg"))
    png("bloommultitienda", "any", os.path.join(bm, "public/icons/icon-192.png"), 192)
    png("bloommultitienda", "any", os.path.join(bm, "public/icons/icon-512.png"), 512)
    png("bloommultitienda", "maskable", os.path.join(bm, "public/icons/icon-maskable-512.png"), 512, True)
    png("bloommultitienda", "maskable", os.path.join(bm, "public/icons/apple-touch-icon.png"), 180, True)

jp = os.path.join(work, "jobs.json")
json.dump(jobs, open(jp, "w"))
subprocess.run(["node", os.path.join(here, "rasterizar.mjs"), jp], check=True)
