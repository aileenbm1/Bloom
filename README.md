# BLOOM · Portal de cuentas por cobrar

Aplicación web para controlar las deudas de prendas de BLOOM: un panel administrativo protegido con contraseña y un portal privado donde cada clienta consulta su estado de cuenta con un enlace único. Funciona en **Cloudflare Workers** (frontend + API en una sola aplicación) con base de datos **Cloudflare D1**, en el subdominio gratuito `workers.dev`. Moneda MXN, idioma español.

> **Estado del despliegue:** el proyecto está listo y probado en local (Wrangler + D1 local). Todavía **no** está desplegado en tu cuenta de Cloudflare: no hay URL pública ni base D1 remota hasta que ejecutes los pasos de la sección 3. No compartas contraseñas ni tokens en ningún chat.

---

## 0. Publicar desde GitHub Codespaces (la forma más fácil)

Todo se hace en el navegador; no necesitas instalar nada en tu computadora.

**Una sola vez: crear el token de Cloudflare**
1. En https://dash.cloudflare.com/profile/api-tokens → **Create Token** → **Create Custom Token**.
2. Permisos (Account → tu cuenta):
   - *Workers Scripts* → **Edit**
   - *D1* → **Edit**
   - *Account Settings* → **Read**
   - User → *User Details* → **Read** y *Memberships* → **Read**
3. Crea el token y cópialo (solo se muestra una vez). No lo pegues en ningún chat.
4. Copia también tu **Account ID** (dash.cloudflare.com → Workers & Pages → panel derecho).
5. Si nunca abriste **Workers & Pages**, entra una vez para que Cloudflare te asigne tu subdominio `*.workers.dev`.

**Una sola vez: guardar los secretos en GitHub**
1. GitHub → tu foto → **Settings → Codespaces → Secrets → New secret**.
2. `CLOUDFLARE_API_TOKEN` = el token; en *Repository access* elige tu repositorio de BLOOM.
3. `CLOUDFLARE_ACCOUNT_ID` = tu Account ID; mismo repositorio.

**Publicar (y cada vez que quieras actualizar)**
1. En tu repositorio: **Code → Codespaces → Create codespace on main**. Espera a que termine `npm install`.
2. En la terminal del codespace:
   ```bash
   npm run publicar
   ```
   El comando crea la base D1 (si no existe) y escribe su ID en `wrangler.jsonc`, aplica las migraciones, despliega con un `APP_SECRET` aleatorio, te pide crear el primer administrador (usuario y contraseña, que no se muestran) y comprueba que la URL pública y D1 responden. Al final imprime tu dirección real: `https://bloom-cuentas.TU-SUBDOMINIO.workers.dev/admin/`.
3. Guarda el ID de la base en el repositorio (el comando te lo recuerda):
   ```bash
   git commit -am "Configurar D1" && git push
   ```

**Probar en el codespace antes de publicar (opcional):** `npm run dev`, luego abre el puerto 8787 que ofrece Codespaces y crea un administrador local en otra terminal con `npm run admin:create -- --local --username leilani`.

Si prefieres trabajar desde tu computadora, sigue la sección 3.

## 1. Qué incluye

**Panel administrativo** (`/admin/`)
- Inicio y cierre de sesión; cambio de contraseña.
- Alta y edición de clientes; búsqueda por nombre o teléfono; filtro Pendientes / Liquidadas / Sin compras.
- Compras con varias prendas (descripción, talla, cantidad, precio), descuento y fecha límite opcional.
- Abonos parciales (efectivo, transferencia, tarjeta, depósito, otro) a la cuenta general o a una compra.
- Correcciones auditadas: anular abono, corregir abono (anula y registra el correcto en una sola transacción), cancelar compra.
- Saldo, estado y fecha límite de cada cuenta; indicadores de deuda total, pagos recibidos, saldo pendiente, abonos del mes y cuentas vencidas.
- Enlace privado por clienta: copiar, enviar por WhatsApp, regenerar y revocar.
- Exportación CSV para Excel (saldos, compras, abonos) e impresión / PDF del estado de cuenta.
- Historial de auditoría que no se puede editar ni borrar.

**Portal de la clienta** (`/cuenta/TOKEN`)
- Solo lectura: nombre, compras y prendas, total de compras, total abonado, saldo pendiente, historial de abonos, estado (pendiente/liquidada), fecha límite, botón de imprimir/descargar y botón de WhatsApp.

## 2. Estructura

```
bloom/
├── wrangler.jsonc            Configuración de Cloudflare (Worker, assets, D1, cron)
├── package.json              Scripts npm
├── migrations/
│   └── 0001_esquema_inicial.sql   Tablas, índices y reglas de integridad
├── src/
│   ├── index.ts              Entrada del Worker (rutas, errores, cron de limpieza)
│   ├── env.ts                Tipos de bindings
│   ├── lib/
│   │   ├── crypto.ts         Tokens, PBKDF2, AES-GCM, hash de IP
│   │   ├── db.ts             Cálculo de saldos y consultas
│   │   ├── http.ts           Encabezados de seguridad, sesión, CSRF, límites de intentos
│   │   ├── links.ts          Enlaces privados
│   │   ├── csv.ts            Exportación compatible con Excel
│   │   └── validate.ts       Validación de importes, fechas, textos
│   └── routes/
│       ├── auth.ts           /api/auth/* (login, logout, sesión, contraseña)
│       ├── admin.ts          /api/admin/* (todas exigen sesión)
│       └── portal.ts         /cuenta (portal de clientas, HTML generado en servidor)
├── public/                   Archivos estáticos
│   ├── admin/index.html, app.js, styles.css   Panel (sin dependencias externas)
│   ├── portal.css, portal.js, favicon.svg, robots.txt
├── scripts/                  create-admin, set-secret, setup-local, backup
├── test/                     Pruebas automáticas (Vitest dentro del runtime de Workers)
├── e2e/run.mjs               Prueba de extremo a extremo (reinicio, respaldo, teléfono)
├── .env.example, .dev.vars.example, .gitignore, .npmrc
```

## 3. Instalación y publicación en Cloudflare (workers.dev)

Ejecuta los comandos en una terminal dentro de la carpeta `bloom` (en Windows: PowerShell o Terminal).

### 3.1 Comprobar Node.js y npm
```bash
node -v    # debe ser v20 o superior
npm -v
```
Si no los tienes, instala la versión LTS desde https://nodejs.org.

### 3.2 Instalar dependencias
```bash
npm install
```
(El archivo `.npmrc` incluye `legacy-peer-deps=true` para evitar un conflicto conocido de dependencias de prueba.)

### 3.3 Probar en tu computadora (opcional, recomendado)
```bash
npm run dev                                           # prepara .dev.vars y la D1 local, y arranca el servidor
npm run admin:create -- --local --username leilani --name "Leilani"   # solo la primera vez (en otra terminal)
```
Abre http://localhost:8787/admin/ e inicia sesión. `npm run dev` ejecuta antes `scripts/setup-local.mjs` automáticamente: crea `.dev.vars` con un `APP_SECRET` local si falta, aplica las migraciones pendientes y te avisa si aún no hay administrador. Para salir, pulsa `x` en la terminal.

Para comprobar que el paquete para Cloudflare se genera bien sin publicar nada:
```bash
npm run build      # = wrangler deploy --dry-run --outdir dist
npm run check      # tipos + pruebas automáticas
```

### 3.4 Autenticar Wrangler con tu cuenta de Cloudflare
```bash
npx wrangler login       # abre el navegador; inicia sesión y autoriza
npx wrangler whoami      # confirma la cuenta
```
Si nunca usaste Workers, entra una vez a https://dash.cloudflare.com → **Workers & Pages** para que Cloudflare te asigne tu subdominio `TU-SUBDOMINIO.workers.dev`.

### 3.5 Crear la base D1
```bash
npm run db:create        # = npx wrangler d1 create bloom-db
```
Wrangler imprime un bloque con `"database_id": "xxxxxxxx-xxxx-..."`. Si pregunta si quieres que agregue la base a la configuración, responde **No** y haz este paso a mano:

### 3.6 Configurar el binding
Abre `wrangler.jsonc` y reemplaza `PENDIENTE-EJECUTA-wrangler-d1-create` por el `database_id` real. El ID no es secreto; puedes subirlo al repositorio. Opcional: escribe el número de WhatsApp de BLOOM en `WHATSAPP_NUMBER` (solo dígitos, ej. `5215512345678`).

### 3.7 Aplicar las migraciones
```bash
npm run db:migrate:remote
```

### 3.8 Ejecutar las pruebas
```bash
npm run check
```

### 3.9 Desplegar
```bash
npm run deploy
```
Al terminar, Wrangler muestra la URL real, por ejemplo `https://bloom-cuentas.TU-SUBDOMINIO.workers.dev`. Esa es tu dirección pública. Hasta completar el paso 3.10 la aplicación muestra "Configuración pendiente" y no muestra datos: es lo esperado.

### 3.10 Configurar el secreto y el primer administrador
```bash
npm run secret:set       # genera APP_SECRET aleatorio y lo guarda cifrado en Cloudflare (no se muestra)
npm run admin:create -- --remote --username leilani --name "Leilani"
```
`admin:create` te pide la contraseña sin mostrarla (mínimo 12 caracteres). La convierte en hash PBKDF2-SHA256 en tu computadora y solo envía el hash a D1. Puedes repetir el comando para restablecer una contraseña olvidada o crear otra cuenta. (El secreto se configura después del primer despliegue porque Cloudflare necesita que el Worker exista.)

### 3.11 Verificar el despliegue
1. Abre `https://bloom-cuentas.TU-SUBDOMINIO.workers.dev/admin/` e inicia sesión.
2. Registra un cliente de prueba, una compra y un abono.
3. Copia su enlace privado y ábrelo en tu teléfono (datos móviles, no wifi) para confirmar el acceso desde Internet.
4. Ejecuta `npm run deploy` otra vez y recarga: los datos deben seguir ahí (están en D1, no en el navegador).
5. Comprueba desde la terminal que los datos están en D1:
   ```bash
   npx wrangler d1 execute bloom-db --remote --command "SELECT name FROM clients"
   ```
6. Revoca el enlace de prueba y comprueba que deja de abrir.

## 4. Uso diario

**Registrar una compra:** Clientes → elige o crea la clienta → *Registrar compra* → agrega cada prenda con **+ Agregar prenda** → descuento y fecha límite si aplican → *Guardar compra*.

**Registrar un abono (después de recibir el dinero):** en la ficha de la clienta → *Registrar abono* → importe, fecha, método, a qué compra se aplica (o cuenta general) y nota opcional. No se aceptan importes en cero, negativos, con más de dos decimales ni mayores que el saldo pendiente.

**Corregir un error:** en la tabla de abonos usa *Corregir* (cambia importe, fecha o método) o *Anular*. Siempre se pide un motivo y todo queda en la auditoría. Los importes nunca se editan directamente: la base de datos lo impide.

**Cancelar una compra:** botón *Cancelar compra*; si ya tiene abonos asociados, anúlalos primero.

**Estado de cuenta en PDF:** en la ficha de la clienta, *Imprimir / PDF estado de cuenta* y elige "Guardar como PDF". La clienta puede hacer lo mismo desde su portal.

**Exportar a Excel:** Resumen → *Exportar a Excel (CSV)*. Los archivos usan UTF-8 con BOM, coma como separador y punto decimal; Excel en español de México los abre directamente.

## 5. Enviar enlaces por WhatsApp

1. En la ficha de la clienta, sección *Enlace privado del cliente*.
2. Si la clienta tiene teléfono, toca **Enviar por WhatsApp**: se abre WhatsApp con un mensaje listo que incluye su enlace. Si no tiene teléfono, usa **Copiar mensaje** o **Copiar enlace** y pégalo en el chat.
3. Envíalo solo a esa clienta.

**Importante:** el enlace funciona como una credencial. Cualquier persona que lo reciba puede ver esa cuenta (no puede modificar nada). Si se envió a la persona equivocada o la clienta lo compartió, toca **Revocar** (deja de funcionar al instante, incluso en teléfonos que ya lo habían abierto) y luego **Regenerar** para enviar uno nuevo.

## 6. Modelo de datos

| Tabla | Contenido |
|---|---|
| `admins` | Usuarios administrativos; contraseña como hash PBKDF2-SHA256 con sal |
| `admin_sessions` | Sesiones (solo el SHA-256 del identificador de cookie), token CSRF, expiración |
| `clients` | Nombre, teléfono (solo dígitos), notas |
| `purchases` | Compra de una clienta: fecha, fecha límite, subtotal, descuento, total, estado (activa/cancelada) |
| `purchase_items` | Prendas de cada compra: descripción, talla, cantidad, precio unitario, importe |
| `payments` | Abonos: importe, fecha, método, nota, compra opcional, estado (válido/anulado), motivo, abono que reemplaza |
| `access_tokens` | Enlaces privados: SHA-256 del token (para validar) y copia cifrada AES-GCM (para poder copiarlo en el panel); fecha de revocación |
| `audit_log` | Toda operación administrativa, login y login fallido |
| `rate_limits` | Contadores de intentos de login y de enlaces inválidos (IP guardada como HMAC, no en claro) |

- Todos los importes son **enteros en centavos**; los textos de importe se convierten sin aritmética de punto flotante.
- El saldo **no se guarda**: siempre es `compras activas − abonos válidos`.
- Disparadores (triggers) en SQL impiden modificar importes de compras, prendas o abonos, borrar abonos o compras, reactivar registros anulados y alterar la auditoría.
- Registrar o corregir un abono y cancelar una compra se hace con lotes atómicos de D1 (`batch`), y la validación del saldo ocurre dentro de la misma sentencia SQL, sin condiciones de carrera.

## 7. Seguridad

- **Sesión administrativa:** cookie `__Host-bloom_admin` HttpOnly, Secure, SameSite=Strict; 12 h máximo y 2 h de inactividad.
- **CSRF:** toda operación de escritura exige el encabezado `X-CSRF-Token` y que el `Origin` sea el propio sitio.
- **Fuerza bruta:** 5 intentos fallidos por usuario y 20 por IP cada 15 minutos; misma respuesta si el usuario no existe.
- **Enlaces privados:** 256 bits aleatorios (`crypto.getRandomValues`), sin nombres, teléfonos ni consecutivos; en la base solo el hash; comparación en tiempo constante; 20 enlaces inválidos por IP cada 15 minutos.
- **Protección del token:** al abrir `/cuenta/TOKEN` el servidor guarda el token en una cookie HttpOnly y redirige a `/cuenta`, así desaparece de la barra de direcciones y del historial. Nunca se guarda en localStorage. El portal no carga recursos externos y envía `Referrer-Policy: no-referrer`. Los registros de invocación de Workers están desactivados (`observability.enabled: false`) para que las URL con token no queden almacenadas.
- **Encabezados:** CSP estricta sin recursos externos, `X-Robots-Tag: noindex`, `robots.txt` que bloquea todo, `X-Frame-Options: DENY`, HSTS, `nosniff`, `Cache-Control: no-store` en API, panel y portal.
- **Validación en servidor** de todos los campos y **consultas SQL parametrizadas** en todo el código.
- **Errores** genéricos sin datos personales, SQL ni trazas.
- **Secretos:** `APP_SECRET` vive como secreto cifrado de Cloudflare; en local, en `.dev.vars` (ignorado por git).

## 8. Respaldo y restauración

**Time Travel (automático):** D1 guarda un historial para restaurar la base a cualquier minuto de los últimos 30 días (7 días en el plan gratuito).
```bash
npx wrangler d1 time-travel info bloom-db                                # marcador actual
npx wrangler d1 time-travel restore bloom-db --timestamp=2026-10-14T12:00:00Z
```
El restore reemplaza la base actual; antes, guarda un respaldo con el paso siguiente.

**Respaldo en archivo (recomendado cada semana):**
```bash
npm run backup           # crea backups/bloom-remote-AAAA-MM-DDTHH-MM-SS.sql
```
Guarda el archivo fuera de la computadora (por ejemplo, en tu nube personal). Contiene datos personales: no lo compartas.

**Restaurar un archivo en una base nueva:**
```bash
npx wrangler d1 create bloom-db-restaurada
npx wrangler d1 execute bloom-db-restaurada --remote --file backups/bloom-remote-....sql
```
Después cambia en `wrangler.jsonc` `database_name` y `database_id` por los de la base restaurada y ejecuta `npm run deploy`. Los enlaces de las clientas siguen funcionando si no cambiaste `APP_SECRET`.

Este procedimiento se probó en local (exportar → base vacía → importar → mismo saldo, enlaces y auditoría): ver `e2e/run.mjs`.

## 9. Pruebas

```bash
npm run check        # TypeScript + 24 pruebas en el runtime de Workers con D1
npm run test:e2e     # wrangler dev real: reinicio, respaldo/restauración y teléfono (requiere Chromium)
```

## 10. Solución de problemas

- **"Configuración pendiente" / error 503 en local:** falta `APP_SECRET` en `.dev.vars`. Arranca con `npm run dev` (lo crea solo) o ejecuta `npm run setup:local`. Si arrancas con `npx wrangler dev` directamente, ese paso no se ejecuta.
- **"Configuración pendiente" en Cloudflare:** falta el secreto → `npm run secret:set`.
- **`npm run deploy` dice "Falta el ID real de la base D1":** sigue los pasos 3.5 a 3.7.
- **Error 1102 o "Worker exceeded resource limits" al iniciar sesión (plan gratuito):** el hash de contraseña usa 100 000 iteraciones y puede rebasar el límite de CPU del plan gratuito. Ejecuta `npm run admin:create -- --remote --username leilani --iterations 50000` (o el plan Workers Paid).
- **Cambiar APP_SECRET:** los enlaces existentes siguen funcionando para las clientas, pero el panel ya no podrá mostrarlos; usa *Regenerar* y envía el nuevo.
- **Ver errores en vivo:** `npm run tail` (muestra peticiones en tiempo real, incluidas URL; úsalo solo para depurar).

## 11. Limitaciones pendientes

- Sin pagos en línea (por decisión del proyecto); los abonos se capturan manualmente.
- Sin dominio propio: la URL es `*.workers.dev`. Se puede agregar un dominio después sin cambiar el código.
- El PDF se genera con la función de imprimir del navegador ("Guardar como PDF").
- No hay recuperación de contraseña por correo: se restablece con `npm run admin:create`.
- No hay roles distintos entre administradores (todos tienen acceso completo).
- Los clientes no se eliminan (se conservan para la contabilidad); se puede editar su información.
- Los respaldos en archivo son manuales (`npm run backup`); Time Travel sí es automático.
- El límite de intentos usa D1; ante un ataque distribuido grande convendría activar reglas de Cloudflare WAF.
