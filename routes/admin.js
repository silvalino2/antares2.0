const express = require("express");
const router  = express.Router();
const { fetchBrandData, generatePersonality, suggestAgentName } = require("../services/brand");
const { configureWebhooks } = require("../services/twilio");
const {
  createClient, getAllClients, getClientById, updateClient,
  activateClient, suspendClient, getPlatformStats, getAllOrders
} = require("../services/db");
const { generateMonthlyReport } = require("../services/report");

function auth(req, res, next) {
  if (req.session?.isAdmin) return next();
  res.status(401).json({ error: "Unauthorized" });
}

router.post("/login",  (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) { req.session.isAdmin=true; res.json({success:true}); }
  else res.status(401).json({ error: "Wrong password" });
});
router.post("/logout", (req, res) => { req.session.destroy(); res.json({success:true}); });

router.get("/stats",   auth, async (req, res) => { try { res.json(await getPlatformStats()); } catch(e) { res.status(500).json({error:e.message}); }});
router.get("/orders",  auth, async (req, res) => { try { res.json(await getAllOrders());     } catch(e) { res.status(500).json({error:e.message}); }});
router.get("/clients", auth, async (req, res) => { try { res.json(await getAllClients());    } catch(e) { res.status(500).json({error:e.message}); }});

router.get("/clients/:id", auth, async (req, res) => {
  try {
    const c = await getClientById(req.params.id);
    if (!c) return res.status(404).json({ error: "Not found" });
    res.json(c);
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── Auto-fetch brand ───────────────────────────
router.post("/fetch-brand", auth, async (req, res) => {
  const { businessName } = req.body;
  if (!businessName) return res.status(400).json({ error: "Business name required" });
  try {
    const brand            = await fetchBrandData(businessName);
    const personality      = generatePersonality(businessName, brand.businessType);
    const suggestedAgentName = suggestAgentName(brand.businessType);
    res.json({ ...brand, personality, suggestedAgentName });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Add client ─────────────────────────────────
router.post("/clients", auth, async (req, res) => {
  try {
    const data = req.body;
    if (!data.personality) data.personality = generatePersonality(data.businessName, data.businessType, data.extraInfo);
    const client = await createClient(data);
    res.json({ success: true, client });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Activate ───────────────────────────────────
router.post("/clients/:id/activate", auth, async (req, res) => {
  try {
    const client = await activateClient(req.params.id);
    if (!client) return res.status(404).json({ error: "Not found" });
    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT||3000}`;
    const wh      = await configureWebhooks(client, baseUrl);
    if (wh.success) await updateClient(client.id, { webhooksOk: true });
    req.app.get("io").emit("client_activated", client);
    res.json({ success: true, client, webhooks: wh });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Suspend ────────────────────────────────────
router.post("/clients/:id/suspend", auth, async (req, res) => {
  try {
    const client = await suspendClient(req.params.id);
    res.json({ success: true, client });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Edit client ────────────────────────────────
router.patch("/clients/:id", auth, async (req, res) => {
  try {
    const updated = await updateClient(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    if (req.body.twilioSid || req.body.phone) {
      const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT||3000}`;
      const wh = await configureWebhooks(updated, baseUrl);
      if (wh.success) await updateClient(updated.id, { webhooksOk: true });
    }
    res.json({ success: true, client: updated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Rewire webhooks ────────────────────────────
router.post("/clients/:id/webhooks", auth, async (req, res) => {
  try {
    const client = await getClientById(req.params.id);
    if (!client) return res.status(404).json({ error: "Not found" });
    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT||3000}`;
    const result  = await configureWebhooks(client, baseUrl);
    if (result.success) await updateClient(client.id, { webhooksOk: true });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Monthly report (Premium only) ─────────────
router.get("/clients/:id/report", auth, async (req, res) => {
  try {
    const now   = new Date();
    const year  = parseInt(req.query.year  || now.getFullYear());
    const month = parseInt(req.query.month || now.getMonth() + 1);
    const report = await generateMonthlyReport(req.params.id, year, month);
    if (report.error) return res.status(403).json({ error: report.error });
    res.json(report);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
