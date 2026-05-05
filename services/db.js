// DB — MongoDB Atlas (persistent across all Railway deployments)
const { MongoClient, ObjectId } = require("mongodb");
const { v4: uuidv4 } = require("uuid");

// ── Connection ────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) throw new Error("MONGODB_URI environment variable is not set.");

let _client = null;
let _db     = null;

async function connect() {
  if (_db) return _db;
  _client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS:         10000,
  });
  await _client.connect();
  _db = _client.db("antares");
  console.log("✦  MongoDB Atlas connected — antares database");

  // ── Indexes (idempotent — safe to run on every startup) ──
  await _db.collection("clients").createIndex({ id: 1 },        { unique: true });
  await _db.collection("clients").createIndex({ phone: 1 });
  await _db.collection("clients").createIndex({ whatsappNumber: 1 });
  await _db.collection("orders").createIndex({ clientId: 1 });
  await _db.collection("orders").createIndex({ "id": 1, "clientId": 1 }, { unique: true });
  await _db.collection("sessions").createIndex({ key: 1 },      { unique: true });

  return _db;
}

function db() {
  if (!_db) throw new Error("DB not connected. Await connect() first.");
  return _db;
}

// ── CLIENTS ───────────────────────────────────────────────
async function createClient(data) {
  const col = db().collection("clients");
  const id  = uuidv4();
  const client = {
    id,
    businessName:      data.businessName,
    businessType:      data.businessType,
    ownerName:         data.ownerName       || "",
    email:             data.email           || "",
    logoUrl:           data.logoUrl         || "",
    colors:            data.colors          || {},
    publicPhone:       data.publicPhone     || data.phone,
    phone:             data.phone,
    forwardingCode:    data.publicPhone     ? `*21*${data.phone}#` : null,
    whatsappNumber:    data.whatsappNumber  || "",
    twilioSid:         data.twilioSid       || "",
    twilioToken:       data.twilioToken     || "",
    plan:              data.plan            || "foundation",
    planActivatedAt:   data.plan            ? new Date().toISOString() : null,
    agentName:         data.agentName       || "Ada",
    personality:       data.personality     || "",
    menuOrServices:    data.menuOrServices  || [],
    extraInfo:         data.extraInfo       || "",
    paystackKey:       data.paystackKey     || "",
    bankName:          data.bankName        || "",
    bankAccount:       data.bankAccount     || "",
    bankAccountName:   data.bankAccountName || "",
    dashboardPassword: data.dashboardPassword,
    status:            "pending",
    active:            false,
    webhooksOk:        false,
    createdAt:         new Date().toISOString(),
    updatedAt:         new Date().toISOString(),
  };
  await col.insertOne(client);
  return client;
}

async function getAllClients() {
  return db().collection("clients")
    .find({}, { projection: { _id: 0 } })
    .sort({ createdAt: -1 })
    .toArray();
}

async function getClientById(id) {
  return db().collection("clients").findOne({ id }, { projection: { _id: 0 } });
}

async function getClientByPhone(phone) {
  return db().collection("clients").findOne(
    { $or: [{ phone }, { whatsappNumber: phone }] },
    { projection: { _id: 0 } }
  );
}

async function updateClient(id, updates) {
  const result = await db().collection("clients").findOneAndUpdate(
    { id },
    { $set: { ...updates, updatedAt: new Date().toISOString() } },
    { returnDocument: "after", projection: { _id: 0 } }
  );
  return result || null;
}

async function activateClient(id) {
  return updateClient(id, { active: true, status: "active" });
}

async function suspendClient(id) {
  return updateClient(id, { active: false, status: "suspended" });
}

// ── ORDERS ────────────────────────────────────────────────
async function createOrder(clientId, data) {
  const col    = db().collection("orders");
  const client = await getClientById(clientId);
  const count  = await col.countDocuments({ clientId });
  const order  = {
    id:            `ORD-${String(count + 1).padStart(3, "0")}`,
    clientId,
    businessName:  client?.businessName  || "",
    customer:      data.customer         || "Guest",
    phone:         data.phone,
    channel:       data.channel,
    items:         data.items            || [],
    total:         data.total            || 0,
    status:        "new",
    paymentStatus: "pending",
    paymentRef:    null,
    notes:         data.notes            || "",
    createdAt:     new Date().toISOString(),
    updatedAt:     new Date().toISOString(),
  };
  await col.insertOne(order);
  return order;
}

async function getOrdersByClient(clientId) {
  return db().collection("orders")
    .find({ clientId }, { projection: { _id: 0 } })
    .sort({ createdAt: -1 })
    .toArray();
}

async function getAllOrders() {
  return db().collection("orders")
    .find({}, { projection: { _id: 0 } })
    .sort({ createdAt: -1 })
    .toArray();
}

async function getOrderById(clientId, orderId) {
  return db().collection("orders").findOne(
    { clientId, id: orderId },
    { projection: { _id: 0 } }
  );
}

async function updateOrder(clientId, orderId, updates) {
  const result = await db().collection("orders").findOneAndUpdate(
    { clientId, id: orderId },
    { $set: { ...updates, updatedAt: new Date().toISOString() } },
    { returnDocument: "after", projection: { _id: 0 } }
  );
  return result || null;
}

async function verifyPayment(clientId, orderId, ref) {
  return updateOrder(clientId, orderId, {
    paymentStatus: "verified",
    paymentRef:    ref,
    status:        "confirmed",
  });
}

// ── SESSIONS ──────────────────────────────────────────────
// Sessions store conversation history per client+phone
// TTL index automatically removes sessions inactive for 7 days
async function ensureSessionTTL() {
  try {
    await db().collection("sessions").createIndex(
      { lastActive: 1 },
      { expireAfterSeconds: 604800 } // 7 days
    );
  } catch(e) { /* index may already exist */ }
}

async function getSession(clientId, phone) {
  const key = `${clientId}:${phone}`;
  let session = await db().collection("sessions").findOne({ key }, { projection: { _id: 0 } });
  if (!session) {
    session = { key, clientId, phone, history: [], lastActive: new Date().toISOString() };
    await db().collection("sessions").insertOne(session);
  }
  return session;
}

async function saveSession(clientId, phone, updates) {
  const key = `${clientId}:${phone}`;
  await db().collection("sessions").updateOne(
    { key },
    { $set: { ...updates, lastActive: new Date().toISOString() } },
    { upsert: true }
  );
}

// ── STATS ─────────────────────────────────────────────────
async function getClientStats(clientId) {
  const orders = await getOrdersByClient(clientId);
  const today  = new Date(); today.setHours(0, 0, 0, 0);
  const td     = orders.filter(o => new Date(o.createdAt) >= today);
  return {
    totalToday:   td.length,
    totalAllTime: orders.length,
    pending:      orders.filter(o => ["new","confirmed","preparing"].includes(o.status)).length,
    verified:     orders.filter(o => o.paymentStatus === "verified").length,
    todayRevenue: td.filter(o => o.paymentStatus === "verified").reduce((s,o) => s + o.total, 0),
    totalRevenue: orders.filter(o => o.paymentStatus === "verified").reduce((s,o) => s + o.total, 0),
    calls:        td.filter(o => o.channel === "call").length,
    sms:          td.filter(o => o.channel === "sms").length,
    wa:           td.filter(o => o.channel === "whatsapp").length,
  };
}

async function getPlatformStats() {
  const clients = await getAllClients();
  const orders  = await getAllOrders();
  const today   = new Date(); today.setHours(0, 0, 0, 0);
  return {
    total:       clients.length,
    active:      clients.filter(c => c.active).length,
    pending:     clients.filter(c => c.status === "pending").length,
    orders:      orders.length,
    todayOrders: orders.filter(o => new Date(o.createdAt) >= today).length,
    revenue:     orders.filter(o => o.paymentStatus === "verified").reduce((s,o) => s + o.total, 0),
  };
}

// ── PLAN FEATURES ─────────────────────────────────────────
function getPlanFeatures(plan) {
  const features = {
    foundation: {
      whatsapp:          true,
      voice:             false,
      voiceNotes:        true,
      sms:               false,
      paymentSms:        false,
      monthlyReport:     false,
      brandedAgent:      false,
      customPersonality: false,
    },
    growth: {
      whatsapp:          true,
      voice:             true,
      voiceNotes:        true,
      sms:               true,
      paymentSms:        false,
      monthlyReport:     false,
      brandedAgent:      true,
      customPersonality: false,
    },
    premium: {
      whatsapp:          true,
      voice:             true,
      voiceNotes:        true,
      sms:               true,
      paymentSms:        true,
      monthlyReport:     true,
      brandedAgent:      true,
      customPersonality: true,
    },
  };
  return features[plan] || features.foundation;
}

module.exports = {
  connect,
  createClient, getAllClients, getClientById, getClientByPhone, updateClient, activateClient, suspendClient,
  createOrder, getOrdersByClient, getAllOrders, getOrderById, updateOrder, verifyPayment,
  getSession, saveSession,
  getClientStats, getPlatformStats, getPlanFeatures,
};
