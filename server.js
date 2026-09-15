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

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
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
    const db = readDb();
    const key = generateLicenseKey();
    db.licenses[key] = {
      key,
      stripeSessionId: session.id,
      stripeCustomerId: session.customer,
      customerEmail: session.customer_details?.email || null,
      plan: "pro",
      createdAt: Date.now(),
      // null = sin vencimiento fijo (útil si vendes "de por vida" o si el
      // control real de la suscripción lo hace Stripe/tu webhook de renovación).
      expiresAt: null,
      status: "active"
    };
    writeDb(db);
    console.log(`✅ Licencia generada para sesión ${session.id}: ${key}`);
  }

  // Ejemplo de cómo manejarías cancelaciones de suscripción, si vendes
  // OrtoMX Pro como suscripción recurrente en vez de pago único:
  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    const db = readDb();
    const entry = Object.values(db.licenses).find((l) => l.stripeCustomerId === sub.customer);
    if (entry) {
      entry.status = "cancelled";
      writeDb(db);
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

// --- Consultar la licencia generada para una sesión (página de éxito) --
app.get("/api/license/by-session", (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: "Falta session_id" });
  const db = readDb();
  const entry = Object.values(db.licenses).find((l) => l.stripeSessionId === session_id);
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
