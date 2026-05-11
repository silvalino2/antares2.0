const express = require("express");
const router  = express.Router();
const axios   = require("axios");
const { getClientById, getOrdersByClient, updateOrder, verifyPayment, getClientStats } = require("../services/db");

async function auth(req, res, next) {
  if (!req.session?.clientId) return res.status(401).json({ error:"Unauthorized" });
  req.client = await getClientById(req.session.clientId);
  if (!req.client) return res.status(401).json({ error:"Not found" });
  next();
}

router.post("/login", async (req, res) => {
  const { clientId, password } = req.body;
  const client = await getClientById(clientId);
  if (!client || client.dashboardPassword !== password) return res.status(401).json({ error:"Invalid credentials" });
  req.session.clientId = client.id;
  const { twilioSid, twilioToken, paystackKey, dashboardPassword, ...safe } = client;
  res.json({ success:true, client:safe });
});

router.post("/logout", async (req, res) => { req.session.destroy(); res.json({ success:true }); });
router.get("/me",     auth, async (req, res) => { const { twilioSid, twilioToken, paystackKey, dashboardPassword, ...safe } = req.client; res.json(safe); });
router.get("/stats",  auth, async (req, res) => res.json(await getClientStats(req.session.clientId)));
router.get("/orders", auth, async (req, res) => res.json(await getOrdersByClient(req.session.clientId)));

router.patch("/orders/:orderId/status", auth, async (req, res) => {
  const valid = ["new","confirmed","preparing","ready","delivered","completed"];
  if (!valid.includes(req.body.status)) return res.status(400).json({ error:"Invalid status" });
  const order = await updateOrder(req.session.clientId, req.params.orderId, { status:req.body.status });
  if (!order) return res.status(404).json({ error:"Not found" });
  req.app.get("io").emit(`order_updated:${req.session.clientId}`, order);
  res.json(order);
});

router.post("/verify-payment", auth, async (req, res) => {
  const { orderId, paymentRef } = req.body;
  if (!orderId || !paymentRef) return res.status(400).json({ error:"Missing fields" });
  const order = await verifyPayment(req.session.clientId, orderId, paymentRef);
  if (!order) return res.status(404).json({ success:false, message:"Order not found" });
  req.app.get("io").emit(`payment_verified:${req.session.clientId}`, order);
  res.json({ success:true, order });
});

// ── Availability toggle ───────────────────────────────────
// PATCH /api/client/availability { itemName, available: true|false }
router.patch("/availability", auth, async (req, res) => {
  const { itemName, available } = req.body;
  if (!itemName || available === undefined) return res.status(400).json({ error: "itemName and available required" });

  const client = await getClientById(req.session.clientId);
  if (!client) return res.status(404).json({ error: "Client not found" });

  const menu = client.menuOrServices || [];
  const idx  = menu.findIndex(i => i.name === itemName);
  if (idx === -1) return res.status(404).json({ error: "Item not found" });

  menu[idx].available      = available;
  menu[idx].updatedAt      = new Date().toISOString();

  const updated = await updateClient(req.session.clientId, { menuOrServices: menu });
  if (!updated) return res.status(500).json({ error: "Update failed" });

  // Notify dashboard in real time
  req.app.get("io").to(req.session.clientId).emit("availability_updated", {
    itemName, available, updatedAt: menu[idx].updatedAt,
  });

  res.json({ success: true, itemName, available });
});

// ── Bulk availability reset ───────────────────────────────
// POST /api/client/availability/reset — marks all items available (start of day reset)
router.post("/availability/reset", auth, async (req, res) => {
  const client = await getClientById(req.session.clientId);
  if (!client) return res.status(404).json({ error: "Client not found" });

  const menu = (client.menuOrServices || []).map(i => ({ ...i, available: true }));
  const updated = await updateClient(req.session.clientId, { menuOrServices: menu });
  if (!updated) return res.status(500).json({ error: "Reset failed" });

  req.app.get("io").to(req.session.clientId).emit("availability_reset");
  res.json({ success: true, message: "All items reset to available" });
});

module.exports = router;
