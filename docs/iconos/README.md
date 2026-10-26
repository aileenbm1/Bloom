# Iconos

Fuente editable de los iconos de la app. Los tres proyectos (BLOOM, BLOOM Multitienda y Ciclo Lunar)
comparten el mismo lenguaje: fondo con degradado sutil, símbolo geométrico centrado, sin texto.

- `*-any.svg`: icono con esquinas redondeadas (manifiesto, `purpose: any`).
- `*-maskable.svg`: sangrado completo, símbolo dentro de la zona segura (maskable e iOS).
- `*-foreground.svg`, `*-background.svg`, `*-monochrome.svg`: capas del icono adaptativo de Android (108 dp; zona segura 66 dp).
- `*-round.svg`: icono redondo heredado (Android 7 y anteriores).
- `*-favicon.svg`: favicon, con el símbolo más grande para leerse a 16–32 px.
- `generar_iconos.py`: define colores y formas. Para regenerar los PNG del proyecto:
  `python3 docs/iconos/aplicar.py /tmp/iconos <carpeta que contiene este repositorio>`
  (necesita Python con Pillow y Node con Playwright/Chromium).

Los iconos anteriores están en `docs/iconos-anteriores/` como respaldo.
