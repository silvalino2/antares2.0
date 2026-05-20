const express = require("express");
const router  = express.Router();
const { getClientById, getOrdersByClient, updateOrder, verifyPayment, getClientStats, updateClient } = require("../services/db");

async function auth(req, res, next) {
  if (!req.session?.clientId) return res.status(401).json({ error: "Unauthorized" });
  req.client = await getClientById(req.session.clientId);
  if (!req.client) return res.status(401).json({ error: "Not found" });
  next();
}

router.post("/login", async (req, res) => {
  const { clientId, password } = req.body;
  const client = await getClientById(clientId);
  if (!client || client.dashboardPassword !== password) return res.status(401).json({ error: "Invalid credentials" });
  req.session.clientId = client.id;
  const { twilioSid, twilioToken, paystackKey, dashboardPassword, ...safe } = client;
  res.json({ success: true, client: safe });
});

router.post("/logout", async (req, res) => { req.session.destroy(); res.json({ success: true }); });
router.get("/me",     auth, async (req, res) => { const { twilioSid, twilioToken, paystackKey, dashboardPassword, ...safe } = req.client; res.json(safe); });
router.get("/stats",  auth, async (req, res) => res.json(await getClientStats(req.session.clientId)));
router.get("/orders", auth, async (req, res) => res.json(await getOrdersByClient(req.session.clientId)));

router.patch("/orders/:orderId/status", auth, async (req, res) => {
  const valid = ["new", "confirmed", "preparing", "ready", "delivered", "completed"];
  if (!valid.includes(req.body.status)) return res.status(400).json({ error: "Invalid status" });
  const order = await updateOrder(req.session.clientId, req.params.orderId, { status: req.body.status });
  if (!order) return res.status(404).json({ error: "Not found" });
  req.app.get("io").emit(`order_updated:${req.session.clientId}`, order);
  res.json(order);
});

router.post("/verify-payment", auth, async (req, res) => {
  const { orderId, paymentRef } = req.body;
  if (!orderId || !paymentRef) return res.status(400).json({ error: "Missing fields" });
  const order = await verifyPayment(req.session.clientId, orderId, paymentRef);
  if (!order) return res.status(404).json({ success: false, message: "Order not found" });
  req.app.get("io").emit(`payment_verified:${req.session.clientId}`, order);
  res.json({ success: true, order });
});

// ── Toggle single item availability ──────────────────────
router.patch("/availability", auth, async (req, res) => {
  const { itemName, available } = req.body;
  if (!itemName || available === undefined) return res.status(400).json({ error: "itemName and available required" });
  const client = await getClientById(req.session.clientId);
  if (!client) return res.status(404).json({ error: "Client not found" });
  const menu = client.menuOrServices || [];
  const idx  = menu.findIndex(i => i.name === itemName);
  if (idx === -1) return res.status(404).json({ error: "Item not found" });
  menu[idx].available = available;
  menu[idx].updatedAt = new Date().toISOString();
  const updated = await updateClient(req.session.clientId, { menuOrServices: menu });
  if (!updated) return res.status(500).json({ error: "Update failed" });
  req.app.get("io").to(req.session.clientId).emit("availability_updated", { itemName, available });
  res.json({ success: true, itemName, available });
});

// ── Reset all items to available ─────────────────────────
router.post("/availability/reset", auth, async (req, res) => {
  const client = await getClientById(req.session.clientId);
  if (!client) return res.status(404).json({ error: "Client not found" });
  const menu = (client.menuOrServices || []).map(i => ({ ...i, available: true }));
  const updated = await updateClient(req.session.clientId, { menuOrServices: menu });
  if (!updated) return res.status(500).json({ error: "Reset failed" });
  req.app.get("io").to(req.session.clientId).emit("availability_reset");
  res.json({ success: true });
});

// ── Add a new menu item (client-side expansion) ───────────
router.post("/menu", auth, async (req, res) => {
  const { name, category, price, description } = req.body;
  if (!name) return res.status(400).json({ error: "Item name required" });
  const client = await getClientById(req.session.clientId);
  if (!client) return res.status(404).json({ error: "Client not found" });
  const menu = client.menuOrServices || [];
  if (menu.find(i => i.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: "Item already exists" });
  }
  menu.push({
    name:        name.trim(),
    category:    category?.trim() || "General",
    price:       parseFloat(price) || 0,
    description: description?.trim() || "",
    available:   true,
    addedAt:     new Date().toISOString(),
  });
  const updated = await updateClient(req.session.clientId, { menuOrServices: menu });
  if (!updated) return res.status(500).json({ error: "Failed to add item" });
  res.json({ success: true, menu: updated.menuOrServices });
});

// ── Delete a menu item ────────────────────────────────────
router.delete("/menu/:itemName", auth, async (req, res) => {
  const client = await getClientById(req.session.clientId);
  if (!client) return res.status(404).json({ error: "Client not found" });
  const menu = (client.menuOrServices || []).filter(
    i => i.name.toLowerCase() !== decodeURIComponent(req.params.itemName).toLowerCase()
  );
  const updated = await updateClient(req.session.clientId, { menuOrServices: menu });
  if (!updated) return res.status(500).json({ error: "Failed to delete item" });
  res.json({ success: true, menu: updated.menuOrServices });
});

// ── Update a menu item (price, category, description) ─────
router.patch("/menu/:itemName", auth, async (req, res) => {
  const client = await getClientById(req.session.clientId);
  if (!client) return res.status(404).json({ error: "Client not found" });
  const menu = client.menuOrServices || [];
  const idx  = menu.findIndex(i => i.name.toLowerCase() === decodeURIComponent(req.params.itemName).toLowerCase());
  if (idx === -1) return res.status(404).json({ error: "Item not found" });
  const { price, category, description } = req.body;
  if (price       !== undefined) menu[idx].price       = parseFloat(price) || 0;
  if (category    !== undefined) menu[idx].category    = category.trim();
  if (description !== undefined) menu[idx].description = description.trim();
  menu[idx].updatedAt = new Date().toISOString();
  const updated = await updateClient(req.session.clientId, { menuOrServices: menu });
  if (!updated) return res.status(500).json({ error: "Failed to update item" });
  res.json({ success: true, menu: updated.menuOrServices });
});

module.exports = router;
