OrtoMX — Servidor de licencias Pro
Este es el backend mínimo necesario para cobrar por OrtoMX Pro y para que la extensión pueda validar la clave de licencia que el usuario compró. Google ya no permite vender extensiones de pago directamente desde el Chrome Web Store (ver el README principal del proyecto), así que este es el mecanismo recomendado: pago externo con Stripe + licencia propia.
1. Requisitos
Una cuenta de Stripe (gratis, sin costo mensual — cobra comisión solo por transacción, ~3.6% + $3 MXN aprox. en México; revisa las tarifas vigentes en tu país).
Node.js 18+ instalado donde vayas a correr o desplegar este servidor.
2. Configura Stripe
Entra al Dashboard de Stripe en modo de prueba.
Ve a Productos → crea un producto "OrtoMX Pro" con un precio (ej. $79 MXN/mes o un pago único de $199 MXN). Copia el price_id.
Ve a Desarrolladores → Claves de API y copia tu sk_test_....
Ve a Desarrolladores → Webhooks → agrega un endpoint apuntando a https://TU-DOMINIO/webhook/stripe, escucha el evento checkout.session.completed (y customer.subscription.deleted si vendes suscripción). Copia el whsec_... que te da Stripe.
2a. Configura la suscripción mensual (opcional, además del pago único)
Si además del pago único de por vida quieres ofrecer una suscripción mensual que el cliente pueda cancelar cuando quiera, hay un paso extra por cada procesador:

Stripe: en el Dashboard, dentro del mismo producto "OrtoMX Pro" donde ya tienes tu precio de pago único, agrega otro precio y elige facturación "Mensual" (recurrente) en vez de "Único". Copia el ID de ese precio nuevo (empieza con price_...) a la variable STRIPE_PRICE_ID_MONTHLY.

Mercado Pago: las suscripciones usan un "plan" que solo se crea una vez (a diferencia del pago único, que no necesita nada de esto):

Define ADMIN_SETUP_SECRET en tu .env (cualquier palabra secreta que inventes) y MP_SUBSCRIPTION_PRICE_MXN (el precio mensual).
Despliega el servidor con esas variables ya puestas.
Visita una sola vez, desde tu navegador: https://TU-BACKEND/admin/setup-mercadopago-plan?secret=LA-PALABRA-QUE-PUSISTE
Te va a regresar un JSON con un "id" — copia ese valor a la variable MP_PREAPPROVAL_PLAN_ID y vuelve a desplegar. Ya no necesitas visitar esa URL de nuevo (si la vuelves a visitar por accidente, no pasa nada grave: solo crea otro plan igual, así que mejor evítalo una vez que ya tengas tu MP_PREAPPROVAL_PLAN_ID).
2b. Configura Mercado Pago (opcional, recomendado si vendes en México)
Sirve para cobrar mientras terminas de registrar tus datos bancarios en Stripe (Mercado Pago no te los pide para empezar a recibir dinero, solo para retirarlo), o simplemente para ofrecer OXXO/tarjetas nacionales.

Crea o entra a tu cuenta en mercadopago.com.mx.
Ve a Tu negocio → Configuración → Credenciales (o mercadopago.com.mx/developers/panel) y copia tu Access Token (empieza con APP_USR-... en modo producción, o TEST-... en modo prueba).
No necesitas crear un "producto" como en Stripe — el precio se define en tu propia variable de entorno MP_PRICE_MXN.
El webhook se configura también desde ese panel de credenciales, en la sección de notificaciones (o simplemente se manda automáticamente a MP_WEBHOOK_URL cuando la preferencia de pago lo especifica, que es lo que hace este servidor). Si vas a usar también la suscripción mensual (paso 2a), en esa misma sección de notificaciones asegúrate de que el evento de "Suscripciones" esté marcado, no solo el de "Pagos" — si no, nunca te llegará el aviso de que alguien se suscribió.
3. Configura el proyecto
cd backend-license-server

cp .env.example .env

# edita .env con tus claves reales (sk_test_..., whsec_..., price_...)

npm install

npm start

El servidor queda escuchando en http://localhost:3000.
4. Pruébalo localmente con Stripe CLI (opcional pero muy recomendable)
stripe listen --forward-to localhost:3000/webhook/stripe

stripe trigger checkout.session.completed

Revisa que se haya creado licenses.json con una clave nueva.
5. Despliega el servidor en algún lugar público
Necesitas que api.languagetool.org no sea el único host externo: tu propio servidor también debe tener una URL pública para que:

Stripe le pueda mandar el webhook.
La extensión (background.js, constante LICENSE_API_URL) pueda llamarlo.

Opciones gratuitas o muy económicas para empezar:

Render.com (plan gratuito/"Starter"): conecta este repo, build command npm install, start command npm start, agrega las variables de entorno del .env en su panel.
Railway.app: similar a Render, despliegue por git push.
Fly.io: requiere un Dockerfile sencillo (Node 18-slim + npm ci + CMD node server.js).
Un VPS propio (DigitalOcean, etc.) con pm2 o systemd para mantenerlo corriendo.

Cuando tengas la URL pública (ej. https://ortomx-licencias.onrender.com):

Actualiza el webhook en Stripe para que apunte a esa URL + /webhook/stripe.
Actualiza LICENSE_API_URL en extension/background.js para que apunte a https://ortomx-licencias.onrender.com/api/license/validate.
Actualiza PRO_UPGRADE_URL en extension/content.js, popup.js y options.js para que apunten a tu página de ventas (una landing simple que llame a POST /api/checkout/session y redirija al usuario a la URL de Stripe Checkout que te devuelve).
6. Importante sobre seguridad y escalado
licenses.json es un almacenamiento de archivo plano — bueno para arrancar, pero no es apto para mucho tráfico simultáneo (riesgo de condiciones de carrera al escribir). Antes de crecer, migra a una base de datos real (Postgres/MySQL/SQLite con better-sqlite3, o un servicio como Supabase/PlanetScale).
Este servidor no envía el correo con la clave automáticamente; la página de éxito (success_url) debe llamar a GET /api/license/by-session?session_id=... para mostrarle la clave al cliente. Si quieres enviarla también por correo, agrega nodemailer o un servicio como Resend/SendGrid en el webhook.
Protege /api/checkout/session y /api/license/by-session con límites de tasa (rate limiting) si esperas tráfico alto, para evitar abuso.

