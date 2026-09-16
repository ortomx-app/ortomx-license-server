// server.js — Servidor mínimo de licencias para OrtoMX Pro.
//
// Qué hace:
//  1. Crea una sesión de pago de Stripe Checkout (POST /api/checkout/session).
//  2. Escucha el webhook de Stripe (POST /webhook/stripe): cuando el pago se
//     completa, genera una clave de licencia y la guarda.
//  3. Expone POST /api/license/validate para que la extensión verifique una
//     clave (esto es lo que llama background.js de la extensión).
//  4. Expone GET /api/license/by-session para que tu página de "gracias por
//     tu compra" muestre la clave recién generada al cliente.
//
// Almacenamiento: un archivo JSON plano (licenses.json). Es suficiente para
// arrancar y para pocos cientos/miles de licencias. Para producción seria,
// cambia `readDb`/`writeDb` por una base de datos real (Postgres, SQLite,
// Redis, etc.) — la interfaz de estas dos funciones es la única cosa que
// tendrías que tocar.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const { MercadoPagoConfig, Preference, Payment, PreApproval, PreApprovalPlan } = require("mercadopago");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Mercado Pago es opcional: si no configuras MP_ACCESS_TOKEN, esas rutas
// simplemente responderán con un error claro en vez de tronar el servidor
// completo (así puedes seguir usando solo Stripe si prefieres).
const mpClient = process.env.MP_ACCESS_TOKEN
  ? new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN })
  : null;

const DB_PATH = path.join(__dirname, "licenses.json");

function readDb() {
  if (!fs.existsSync(DB_PATH)) return { licenses: {} };
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}
function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function generateLicenseKey() {
  // Formato tipo "ORTOMX-XXXX-XXXX-XXXX-XXXX"
  const part = () => crypto.randomBytes(2).toString("hex").toUpperCase();
  return `ORTOMX-${part()}-${part()}-${part()}-${part()}`;
}

const app = express();
app.use(cors()); // en producción, restringe esto a los orígenes que realmente necesitas

// --- Webhook de Stripe: necesita el body "crudo", por eso se monta ANTES
// del express.json() global y usa su propio parser raw. --------------------
app.post("/webhook/stripe", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Firma de webhook inválida:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const isSubscription = session.mode === "subscription";
    const db = readDb();
    const key = generateLicenseKey();
    db.licenses[key] = {
      key,
      stripeSessionId: session.id,
      stripeCustomerId: session.customer,
      // Solo existe cuando session.mode === "subscription"; nos sirve para
      // encontrar esta licencia exacta cuando el cliente cancele (en vez de
      // buscar por cliente, que podría tener otras compras/licencias).
      stripeSubscriptionId: session.subscription || null,
      customerEmail: session.customer_details?.email || null,
      plan: isSubscription ? "pro-mensual" : "pro",
      billing: isSubscription ? "subscription" : "one_time",
      createdAt: Date.now(),
      // null = sin vencimiento fijo. Para el pago único es "de por vida"; para
      // la suscripción, el control real de si sigue vigente lo hace el evento
      // "customer.subscription.deleted" de abajo, que marca status:"cancelled".
      expiresAt: null,
      status: "active"
    };
    writeDb(db);
    console.log(`✅ Licencia generada para sesión ${session.id} (${db.licenses[key].billing}): ${key}`);
  }

  // Se dispara cuando el cliente cancela su suscripción mensual (o Stripe la
  // cancela tras varios intentos de cobro fallidos). Buscamos por el ID de
  // la suscripción específica, no por cliente, para no afectar otras
  // licencias que ese mismo cliente pudiera tener (p. ej. si además compró
  // el acceso de por vida en otro momento).
  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    const db = readDb();
    const entry = Object.values(db.licenses).find((l) => l.stripeSubscriptionId === sub.id);
    if (entry) {
      entry.status = "cancelled";
      writeDb(db);
      console.log(`🛑 Suscripción cancelada, licencia desactivada: ${entry.key}`);
    }
  }

  res.json({ received: true });
});

// A partir de aquí sí usamos JSON normal
app.use(express.json());

// --- Crear una sesión de Stripe Checkout ------------------------------
app.post("/api/checkout/session", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment", // cambia a "subscription" si vendes OrtoMX Pro por mensualidad
      payment_method_types: ["card"],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: process.env.SUCCESS_URL,
      cancel_url: process.env.CANCEL_URL
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo crear la sesión de pago." });
  }
});

// --- Crear una sesión de Stripe Checkout para la SUSCRIPCIÓN MENSUAL ----
// Igual que la de arriba, pero en modo "subscription": usa un precio
// recurrente (STRIPE_PRICE_ID_MONTHLY, creado en el Dashboard de Stripe
// como precio "Mensual") en vez del precio de pago único.
app.post("/api/checkout/session/subscription", async (req, res) => {
  if (!process.env.STRIPE_PRICE_ID_MONTHLY) {
    return res.status(500).json({ error: "Falta configurar STRIPE_PRICE_ID_MONTHLY en el servidor." });
  }
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: process.env.STRIPE_PRICE_ID_MONTHLY, quantity: 1 }],
      success_url: process.env.SUCCESS_URL,
      cancel_url: process.env.CANCEL_URL
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Error creando sesión de suscripción de Stripe:", err);
    res.status(500).json({ error: "No se pudo crear la sesión de suscripción." });
  }
});

// --- Consultar la licencia generada para una sesión (página de éxito) --
app.get("/api/license/by-session", (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: "Falta session_id" });
  const db = readDb();
  const entry = Object.values(db.licenses).find((l) => l.stripeSessionId === session_id);
  if (!entry) return res.status(404).json({ error: "Licencia no encontrada (¿el webhook ya se procesó?)" });
  res.json({ key: entry.key, plan: entry.plan });
});

// --- Mercado Pago: crear una "preferencia" de pago (equivalente a la
// sesión de Stripe Checkout) --------------------------------------------
app.post("/api/checkout/mercadopago/session", async (req, res) => {
  if (!mpClient) {
    return res.status(500).json({ error: "Mercado Pago no está configurado en el servidor (falta MP_ACCESS_TOKEN)." });
  }
  try {
    // Generamos nuestra propia referencia para poder encontrar la licencia
    // después, ya que Mercado Pago nos la regresa tal cual en la URL de
    // regreso (parámetro external_reference) y también en el webhook.
    const externalReference = crypto.randomUUID();
    const preference = new Preference(mpClient);
    const result = await preference.create({
      body: {
        items: [
          {
            title: "OrtoMX Pro — acceso de por vida",
            quantity: 1,
            unit_price: Number(process.env.MP_PRICE_MXN || 99),
            currency_id: "MXN"
          }
        ],
        external_reference: externalReference,
        back_urls: {
          success: process.env.MP_SUCCESS_URL || process.env.SUCCESS_URL,
          failure: process.env.MP_FAILURE_URL || process.env.CANCEL_URL,
          pending: process.env.MP_SUCCESS_URL || process.env.SUCCESS_URL
        },
        auto_return: "approved",
        notification_url: process.env.MP_WEBHOOK_URL // ej. https://TU-DOMINIO/webhook/mercadopago
      }
    });
    res.json({ url: result.init_point, externalReference });
  } catch (err) {
    console.error("Error creando preferencia de Mercado Pago:", err);
    res.status(500).json({ error: "No se pudo crear la preferencia de pago." });
  }
});

// --- Webhook de Mercado Pago: nos avisa cuando un pago cambia de estado.
// A diferencia de Stripe, aquí solo nos llega un id — hay que consultar el
// pago completo a la API para confirmar que de verdad está "approved"
// antes de generar la licencia (nunca confíes solo en la notificación). ---
app.post("/webhook/mercadopago", async (req, res) => {
  try {
    if (!mpClient) return res.sendStatus(200);

    const topic = req.query.topic || req.query.type || req.body?.type;
    const paymentId = req.query["data.id"] || req.body?.data?.id || req.query.id;

    if (topic === "payment" && paymentId) {
      const payment = new Payment(mpClient);
      const info = await payment.get({ id: paymentId });

      if (info.status === "approved") {
        const db = readDb();
        const yaExiste = Object.values(db.licenses).some((l) => l.mpPaymentId === String(paymentId));
        if (!yaExiste) {
          const key = generateLicenseKey();
          db.licenses[key] = {
            key,
            mpPaymentId: String(paymentId),
            mpExternalReference: info.external_reference || null,
            customerEmail: info.payer?.email || null,
            plan: "pro",
            billing: "one_time",
            createdAt: Date.now(),
            expiresAt: null,
            status: "active"
          };
          writeDb(db);
          console.log(`✅ Licencia generada (Mercado Pago) para pago ${paymentId}: ${key}`);
        }
      }
    }

    // --- Suscripción mensual (API de Suscripciones / Preapproval) ---------
    // Mercado Pago manda un aviso separado cuando cambia el estado de una
    // suscripción (se autoriza al suscribirse, o se cancela/pausa después).
    // El nombre exacto de "type" puede variar un poco entre integraciones
    // (subscription_preapproval / preapproval) — aceptamos ambos para no
    // perder el aviso.
    const isPreapprovalNotification =
      topic === "subscription_preapproval" ||
      topic === "preapproval" ||
      req.body?.entity === "preapproval";
    const preapprovalId = req.query["data.id"] || req.body?.data?.id || req.query.id;

    if (isPreapprovalNotification && preapprovalId) {
      const preapproval = new PreApproval(mpClient);
      const info = await preapproval.get({ id: preapprovalId });

      if (info.status === "authorized") {
        const db = readDb();
        const yaExiste = Object.values(db.licenses).some((l) => l.mpPreapprovalId === String(preapprovalId));
        if (!yaExiste) {
          const key = generateLicenseKey();
          db.licenses[key] = {
            key,
            mpPreapprovalId: String(preapprovalId),
            customerEmail: info.payer_email || null,
            plan: "pro-mensual",
            billing: "subscription",
            createdAt: Date.now(),
            expiresAt: null,
            status: "active"
          };
          writeDb(db);
          console.log(`✅ Licencia generada (Mercado Pago, suscripción) ${preapprovalId}: ${key}`);
        }
      } else if (info.status === "cancelled" || info.status === "paused") {
        const db = readDb();
        const entry = Object.values(db.licenses).find((l) => l.mpPreapprovalId === String(preapprovalId));
        if (entry && entry.status !== "cancelled") {
          entry.status = "cancelled";
          writeDb(db);
          console.log(`🛑 Suscripción de Mercado Pago cancelada, licencia desactivada: ${entry.key}`);
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    // Respondemos 200 igual para que Mercado Pago no reintente en bucle;
    // el error ya queda registrado en los logs del servidor para revisarlo.
    console.error("Error procesando webhook de Mercado Pago:", err);
    res.sendStatus(200);
  }
});

// --- Consultar la licencia generada para una suscripción de Mercado Pago
// (equivalente a /api/license/by-session, pero para la suscripción) ------
app.get("/api/license/by-preapproval", (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: "Falta id" });
  const db = readDb();
  const entry = Object.values(db.licenses).find((l) => l.mpPreapprovalId === id);
  if (!entry) return res.status(404).json({ error: "Licencia no encontrada (¿el webhook ya se procesó?)" });
  res.json({ key: entry.key, plan: entry.plan });
});

// --- Suscripción mensual con Mercado Pago -------------------------------
// A diferencia del pago único (Preference), las suscripciones usan un
// "plan" reutilizable que se crea UNA SOLA VEZ (ver /admin/setup-mercadopago-plan
// más abajo). Esta ruta solo construye el link público de ese plan para que
// el botón de la página redirija ahí — Mercado Pago se encarga de pedirle
// el correo y la tarjeta al cliente en su propia página.
app.get("/api/checkout/mercadopago/subscription-link", (req, res) => {
  if (!process.env.MP_PREAPPROVAL_PLAN_ID) {
    return res.status(500).json({
      error: "Falta configurar MP_PREAPPROVAL_PLAN_ID (usa /admin/setup-mercadopago-plan una vez para crearlo)."
    });
  }
  const base = process.env.MP_SUBSCRIPTION_CHECKOUT_BASE || "https://www.mercadopago.com.mx/subscriptions/checkout";
  res.json({ url: `${base}?preapproval_plan_id=${process.env.MP_PREAPPROVAL_PLAN_ID}` });
});

// --- Herramienta de un solo uso: crea el "plan" de suscripción mensual en
// Mercado Pago. Se visita UNA VEZ desde el navegador después de desplegar
// (con ?secret=... para que no cualquiera pueda crear planes a lo loco);
// copia el "id" que regresa a la variable de entorno MP_PREAPPROVAL_PLAN_ID
// y ya no se vuelve a necesitar esta ruta.
app.get("/admin/setup-mercadopago-plan", async (req, res) => {
  if (!process.env.ADMIN_SETUP_SECRET || req.query.secret !== process.env.ADMIN_SETUP_SECRET) {
    return res.status(403).json({ error: "Secreto inválido o falta configurar ADMIN_SETUP_SECRET." });
  }
  if (!mpClient) {
    return res.status(500).json({ error: "Mercado Pago no está configurado en el servidor (falta MP_ACCESS_TOKEN)." });
  }
  try {
    const plan = new PreApprovalPlan(mpClient);
    const result = await plan.create({
      body: {
        reason: "OrtoMX Pro — suscripción mensual",
        auto_recurring: {
          frequency: 1,
          frequency_type: "months",
          transaction_amount: Number(process.env.MP_SUBSCRIPTION_PRICE_MXN || 39),
          currency_id: "MXN"
        },
        back_url: process.env.MP_SUCCESS_URL || process.env.SUCCESS_URL
      }
    });
    res.json({
      id: result.id,
      init_point: result.init_point,
      instrucciones: "Copia este 'id' a la variable de entorno MP_PREAPPROVAL_PLAN_ID en Render y redeploy."
    });
  } catch (err) {
    console.error("Error creando el plan de suscripción de Mercado Pago:", err);
    res.status(500).json({ error: "No se pudo crear el plan de suscripción.", detalle: String(err) });
  }
});

// --- Consultar la licencia generada para una referencia de Mercado Pago
// (equivalente a /api/license/by-session, pero para MP) ------------------
app.get("/api/license/by-reference", (req, res) => {
  const { ref } = req.query;
  if (!ref) return res.status(400).json({ error: "Falta ref" });
  const db = readDb();
  const entry = Object.values(db.licenses).find((l) => l.mpExternalReference === ref);
  if (!entry) return res.status(404).json({ error: "Licencia no encontrada (¿el webhook ya se procesó?)" });
  res.json({ key: entry.key, plan: entry.plan });
});

// --- Validar una clave de licencia (llamado desde la extensión) --------
app.post("/api/license/validate", (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ valid: false, reason: "EMPTY_KEY" });
  const db = readDb();
  const entry = db.licenses[key];
  if (!entry || entry.status !== "active") {
    return res.json({ valid: false });
  }
  res.json({ valid: true, plan: entry.plan, expiresAt: entry.expiresAt });
});

app.get("/", (_req, res) => res.send("OrtoMX license server OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OrtoMX license server escuchando en puerto ${PORT}`));
