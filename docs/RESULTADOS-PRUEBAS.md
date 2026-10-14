# Resultado de las pruebas (2026-10-14, local)

Entorno: Node 22, Wrangler 4.151.0, Vitest 4.1.11 + @cloudflare/vitest-plugin 1.4.2 (runtime workerd con D1 local), Chromium (modo móvil 390×844).

No incluye pruebas contra Cloudflare: el proyecto aún no está desplegado.

## npm run check (24 pruebas)
```
 ✓ test/app.test.ts > 1 · Autenticación administrativa > el administrador inicia sesión con cookie HttpOnly, Secure y SameSite=Strict 111ms
 ✓ test/app.test.ts > 1 · Autenticación administrativa > rechaza contraseña incorrecta sin revelar si el usuario existe 82ms
 ✓ test/app.test.ts > 1 · Autenticación administrativa > bloquea por fuerza bruta tras 5 intentos fallidos 185ms
 ✓ test/app.test.ts > 1 · Autenticación administrativa > las rutas administrativas exigen sesión 16ms
 ✓ test/app.test.ts > 1 · Autenticación administrativa > protege contra CSRF: exige token y mismo origen 67ms
 ✓ test/app.test.ts > 1 · Autenticación administrativa > cerrar sesión invalida la cookie 41ms
 ✓ test/app.test.ts > 2-4 · Clientes, compras y enlaces privados > registra clientes y compras con varias prendas 63ms
 ✓ test/app.test.ts > 2-4 · Clientes, compras y enlaces privados > cada cliente obtiene un enlace distinto, aleatorio y sin datos personales 47ms
 ✓ test/app.test.ts > 2-4 · Clientes, compras y enlaces privados > cada enlace muestra solo la cuenta autorizada 95ms
 ✓ test/app.test.ts > 2-4 · Clientes, compras y enlaces privados > el portal no se indexa y no filtra el token (encabezados de seguridad) 64ms
 ✓ test/app.test.ts > 5-7 · Abonos y saldos > un abono reduce el saldo correctamente 62ms
 ✓ test/app.test.ts > 5-7 · Abonos y saldos > no acepta importes inválidos 167ms
 ✓ test/app.test.ts > 5-7 · Abonos y saldos > una cuenta liquidada muestra saldo cero 111ms
 ✓ test/app.test.ts > 5-7 · Abonos y saldos > corrige un abono de forma atómica y auditada 110ms
 ✓ test/app.test.ts > 5-7 · Abonos y saldos > cancelar compra exige anular antes sus abonos 76ms
 ✓ test/app.test.ts > 5-7 · Abonos y saldos > la base de datos impide alterar importes o saldos sin operación registrada 58ms
 ✓ test/app.test.ts > 8-9 · Revocación y aislamiento del cliente > un enlace revocado deja de funcionar de inmediato (incluida la cookie ya emitida) 99ms
 ✓ test/app.test.ts > 8-9 · Revocación y aislamiento del cliente > el cliente no puede editar su saldo, registrar abonos ni consultar otras cuentas 119ms
 ✓ test/app.test.ts > 8-9 · Revocación y aislamiento del cliente > limita los intentos de adivinar enlaces 131ms
 ✓ test/app.test.ts > 11 · Exportaciones > el CSV contiene importes correctos y es compatible con Excel 91ms
 ✓ test/app.test.ts > 11 · Exportaciones > los indicadores suman correctamente 62ms
 ✓ test/app.test.ts > 11 · Exportaciones > busca por nombre y teléfono 52ms
 ✓ test/app.test.ts > Errores y encabezados > los errores no exponen datos internos 38ms
 ✓ test/app.test.ts > Errores y encabezados > los archivos del panel se sirven con encabezados de seguridad 6ms
      Tests  24 passed (24)
```

## npm run test:e2e (wrangler dev)
```
✔ Migraciones aplicadas y administrador creado con el script
✔ Inicio de sesión contra wrangler dev — 53 ms (incluye PBKDF2 100 000 iteraciones)
✔ Cliente, compra y abono registrados — saldo 1000 MXN
✔ Portal del cliente responde con su cuenta
✔ 10 · Los datos sobreviven al reinicio del servidor
✔ 10 · El enlace privado sigue funcionando tras el reinicio
✔ 11 · CSV exportado con importes correctos — Valeria Persistente,55 4433 2211,1,1599.90,599.90,1000.00,Pendiente,2026-11-10,2026-10-12
✔ 13 · Respaldo exportado — 12235 bytes
✔ 13 · La base restaurada no tiene migraciones pendientes
✔ 13 · La base restaurada conserva clientes, compras, abonos y saldo
✔ 13 · El enlace privado funciona en la base restaurada
✔ 13 · La auditoría se conserva
✔ 12 · Login en el panel desde un teléfono
✔ 12 · Compra y abono capturados desde el teléfono — saldo $250.00
✔ 12 · El panel no desborda horizontalmente a 390 px
✔ 12 · Portal móvil: el token desaparece de la barra de direcciones — http://localhost:8799/cuenta
✔ 12 · Portal móvil: no guarda nada en localStorage/sessionStorage
✔ 12 · Portal móvil: sin desbordamiento horizontal
✔ 12 · Portal móvil: la cookie del enlace no es accesible desde JavaScript
19/19 comprobaciones correctas.
```
