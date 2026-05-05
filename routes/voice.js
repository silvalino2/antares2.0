// Africa's Talking Voice Routes — replaces /routes/twilio.js voice handlers
const express  = require("express");
const router   = express.Router();
const { chat } = require("../services/ai");
const { getClientById, getPlanFeatures } = require("../services/db");
const { buildResponse } = require("../services/africastalking");
const { sendSMS } = require("../services/twilio");

// AT calls this when a call comes in
router.post("/voice/:clientId", async (req, res) => {
  const client  = await getClientById(req.params.clientId);
  const base    = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

  if (!client || !client.active) {
    const xml = buildResponse([{ type: "say", text: "This service is currently unavailable. Please try again later." }]);
    res.type("text/xml"); return res.send(xml);
  }

  // ── Plan gate: Foundation does not include voice ──
  const features = getPlanFeatures(client.plan);
  if (!features.voice) {
    const xml = buildResponse([{ type: "say", text: "Voice calling is not available on this plan. Please contact us on WhatsApp." }]);
    res.type("text/xml"); return res.send(xml);
  }

  const agentName = client.agentName || "your AI assistant";
  const greeting  = `Hello! I'm ${agentName} from ${client.businessName}. How may I help you today?`;

  const xml = buildResponse([
    { type: "say", text: greeting },
    {
      type: "record",
      maxLength: 30,
      finishOnKey: "#",
      callbackUrl: `${base}/at/voice-respond/${client.id}`,
    },
  ]);
  res.type("text/xml"); res.send(xml);
});

// AT calls this with the recorded speech
router.post("/voice-respond/:clientId", async (req, res) => {
  const client     = await getClientById(req.params.clientId);
  const phone      = req.body.callerNumber || req.body.from || "";
  const recordUrl  = req.body.recordingUrl || "";
  const base       = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

  if (!client) {
    const xml = buildResponse([{ type: "say", text: "Service unavailable." }]);
    res.type("text/xml"); return res.send(xml);
  }

  // Transcribe audio via OpenAI Whisper
  let speechText = req.body.speechText || "";
  if (!speechText && recordUrl) {
    const { transcribeAudio } = require("../services/ai");
    speechText = await transcribeAudio(recordUrl) || "";
  }

  if (!speechText) {
    const xml = buildResponse([
      { type: "say", text: "Sorry, I didn't catch that. Please speak after the beep." },
      { type: "record", maxLength: 30, finishOnKey: "#", callbackUrl: `${base}/at/voice-respond/${client.id}` },
    ]);
    res.type("text/xml"); return res.send(xml);
  }

  try {
    const { reply, order, escalate, paymentTriggered, paymentWA } = await chat(client.id, phone, speechText, "call");
    const io = req.app.get("io");

    if (order)    io.to(client.id).emit("new_order", order);

    if (escalate) {
      io.to(client.id).emit("escalation_needed", {
        clientId:  client.id,
        phone,
        message:   speechText,
        timestamp: new Date().toISOString(),
        channel:   "call",
      });
    }

    // Growth plan: notify dashboard that customer was directed to WhatsApp for payment
    if (paymentWA) {
      io.to(client.id).emit("payment_wa_pending", {
        clientId:  client.id,
        phone,
        timestamp: new Date().toISOString(),
        message:   `Customer on ${phone} was directed to WhatsApp for payment details.`,
      });
    }

    if (paymentTriggered && client.bankAccount && features.paymentSms) {
      const smsBody = [
        `${client.businessName} — Payment Details`,
        ``,
        `Bank:    ${client.bankName}`,
        `Account: ${client.bankAccount}`,
        `Name:    ${client.bankAccountName}`,
        ``,
        `Send proof of payment on WhatsApp to confirm your order.`,
      ].join("\n");
      sendSMS(client, phone, smsBody).catch(e => console.error("Payment SMS:", e.message));
    }

    const xml = buildResponse([
      { type: "say", text: reply },
      { type: "record", maxLength: 30, finishOnKey: "#", callbackUrl: `${base}/at/voice-respond/${client.id}` },
    ]);
    res.type("text/xml"); res.send(xml);
  } catch (e) {
    console.error("Voice respond error:", e);
    const xml = buildResponse([{ type: "say", text: "I'm having a brief issue. Please hold on." }]);
    res.type("text/xml"); res.send(xml);
  }
});

module.exports = router;
