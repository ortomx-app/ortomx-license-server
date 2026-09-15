# OrtoMX — Servidor de licencias Pro

Este es el backend mínimo necesario para **cobrar** por OrtoMX Pro y para que
la extensión pueda **validar** la clave de licencia que el usuario compró.
Google ya no permite vender extensiones de pago directamente desde el Chrome
Web Store (ver el README principal del proyecto), así que este es el
mecanismo recomendado: pago externo con Stripe + licencia propia.

## 1. Requisitos

- Una cuenta de [Stripe](https://stripe.com) (gratis, sin costo mensual — cobra
  comisión solo por transacción, ~3.6% + $3 MXN aprox. en México; revisa las
  tarifas vigentes en tu país).
- Node.js 18+ instalado donde vayas a correr o desplegar este servidor.

## 2. Configura Stripe

1. Entra al [Dashboard de Stripe](https://dashboard.stripe.com/) en modo de prueba.
2. Ve a **Productos** → crea un producto "OrtoMX Pro" con un precio (ej. $79 MXN/mes o un pago único de $199 MXN). Copia el `price_id`.
3. Ve a **Desarrolladores → Claves de API** y copia tu `sk_test_...`.
4. Ve a **Desarrolladores → Webhooks** → agrega un endpoint apuntando a
   `https://TU-DOMINIO/webhook/stripe`, escucha el evento
   `checkout.session.completed` (y `customer.subscription.deleted` si vendes
   suscripción). Copia el `whsec_...` que te da Stripe.

## 3. Configura el proyecto

```bash
cd backend-license-server
cp .env.example .env
# edita .env con tus claves reales (sk_test_..., whsec_..., price_...)
npm install
npm start
```

El servidor queda escuchando en `http://localhost:3000`.

## 4. Pruébalo localmente con Stripe CLI (opcional pero muy recomendable)

```bash
stripe listen --forward-to localhost:3000/webhook/stripe
stripe trigger checkout.session.completed
```

Revisa que se haya creado `licenses.json` con una clave nueva.

## 5. Despliega el servidor en algún lugar público

Necesitas que `api.languagetool.org` no sea el único host externo: tu propio
servidor también debe tener una URL pública para que:

- Stripe le pueda mandar el webhook.
- La extensión (`background.js`, constante `LICENSE_API_URL`) pueda llamarlo.

Opciones gratuitas o muy económicas para empezar:

- **Render.com** (plan gratuito/"Starter"): conecta este repo, build command
  `npm install`, start command `npm start`, agrega las variables de entorno
  del `.env` en su panel.
- **Railway.app**: similar a Render, despliegue por git push.
- **Fly.io**: requiere un `Dockerfile` sencillo (Node 18-slim + `npm ci` + `CMD node server.js`).
- **Un VPS propio** (DigitalOcean, etc.) con `pm2` o `systemd` para mantenerlo corriendo.

Cuando tengas la URL pública (ej. `https://ortomx-licencias.onrender.com`):

1. Actualiza el webhook en Stripe para que apunte a esa URL + `/webhook/stripe`.
2. Actualiza `LICENSE_API_URL` en `extension/background.js` para que apunte a
   `https://ortomx-licencias.onrender.com/api/license/validate`.
3. Actualiza `PRO_UPGRADE_URL` en `extension/content.js`, `popup.js` y
   `options.js` para que apunten a tu página de ventas (una landing simple
   que llame a `POST /api/checkout/session` y redirija al usuario a la URL
   de Stripe Checkout que te devuelve).

## 6. Importante sobre seguridad y escalado

- `licenses.json` es un almacenamiento de archivo plano — bueno para
  arrancar, pero **no es apto para mucho tráfico simultáneo** (riesgo de
  condiciones de carrera al escribir). Antes de crecer, migra a una base de
  datos real (Postgres/MySQL/SQLite con `better-sqlite3`, o un servicio como
  Supabase/PlanetScale).
- Este servidor no envía el correo con la clave automáticamente; la página de
  éxito (`success_url`) debe llamar a `GET /api/license/by-session?session_id=...`
  para mostrarle la clave al cliente. Si quieres enviarla también por correo,
  agrega `nodemailer` o un servicio como Resend/SendGrid en el webhook.
- Protege `/api/checkout/session` y `/api/license/by-session` con límites de
  tasa (rate limiting) si esperas tráfico alto, para evitar abuso.
