// Twilio Routes — WhatsApp, SMS, Voice
const express  = require("express");
const router   = express.Router();
const twilio   = require("twilio");
const { chat, transcribeAudio } = require("../services/ai");
const { getClientById, getPlanFeatures } = require("../services/db");
const { sendWhatsApp, sendSMS } = require("../services/twilio");

const MessagingResponse = twilio.twiml.MessagingResponse;
const VoiceResponse     = twilio.twiml.VoiceResponse;

// ─────────────────────────────────────────
// SMS
// ─────────────────────────────────────────
router.post("/sms/:clientId", async (req, res) => {
  const client = await getClientById(req.params.clientId);
  const twiml  = new MessagingResponse();
  if (!client || !client.active) {
    twiml.message("Service unavailable.");
    res.type("text/xml");
    return res.send(twiml.toString());
  }
  try {
    const { reply, order, escalate } = await chat(client.id, req.body.From, req.body.Body?.trim(), "sms");
    const io = req.app.get("io");
    if (order)    io.to(client.id).emit("new_order", order);
    if (escalate) io.to(client.id).emit("escalation_needed", {
      clientId: client.id, phone: req.body.From, message: req.body.Body,
      timestamp: new Date().toISOString(), channel: "sms"
    });
    twiml.message(reply);
  } catch (e) {
    twiml.message("Something went wrong. Please try again.");
  }
  res.type("text/xml");
  res.send(twiml.toString());
});

// ─────────────────────────────────────────
// WHATSAPP
// ─────────────────────────────────────────
router.post("/whatsapp/:clientId", async (req, res) => {
  const client = await getClientById(req.params.clientId);
  if (!client || !client.active) {
    const twiml = new MessagingResponse();
    twiml.message("Service unavailable.");
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  const numMedia = parseInt(req.body.NumMedia || "0");
  let userMessage = req.body.Body?.trim() || "";

  if (numMedia > 0 && req.body.MediaContentType0?.includes("audio")) {
    const audioUrl    = req.body.MediaUrl0;
    const transcribed = await transcribeAudio(audioUrl);
    if (transcribed) {
      userMessage = transcribed;
    } else {
      const twiml = new MessagingResponse();
      twiml.message("Sorry, I couldn't process your voice note. Please type your message.");
      res.type("text/xml");
      return res.send(twiml.toString());
    }
  }

  if (!userMessage) return res.sendStatus(200);

  try {
    const { reply, order, escalate, paymentWA } = await chat(client.id, req.body.From, userMessage, "whatsapp");
    const io = req.app.get("io");
    if (order)    io.to(client.id).emit("new_order", order);
    if (escalate) io.to(client.id).emit("escalation_needed", {
      clientId: client.id, phone: req.body.From, message: userMessage,
      timestamp: new Date().toISOString(), channel: "whatsapp"
    });

    if (client.bankAccount) {
      const paymentKeywords = ["pay", "payment", "account", "transfer", "bank", "details", "how do i pay", "account number"];
      const isPaymentQuery  = paymentKeywords.some(k => userMessage.toLowerCase().includes(k));
      if (isPaymentQuery) {
        const paymentMsg = [
          `💳 *${client.businessName} — Payment Details*`,
          ``,
          `Bank:       ${client.bankName}`,
          `Account:    ${client.bankAccount}`,
          `Name:       ${client.bankAccountName}`,
          ``,
          `After payment, please send your proof of payment here so we can confirm your order. Thank you! 🙏`,
        ].join("\n");
        setTimeout(() => {
          sendWhatsApp(client, req.body.From, paymentMsg)
            .catch(e => console.error("Payment WA send:", e.message));
        }, 1200);
      }
    }

    const twiml = new MessagingResponse();
    twiml.message(reply);
    res.type("text/xml");
    return res.send(twiml.toString());

  } catch (e) {
    console.error("WA error:", e);
    const twiml = new MessagingResponse();
    twiml.message("Something went wrong. Please try again.");
    res.type("text/xml");
    return res.send(twiml.toString());
  }
});

// ─────────────────────────────────────────
// VOICE — Incoming call
// ─────────────────────────────────────────
router.post("/voice/:clientId", async (req, res) => {
  const client = await getClientById(req.params.clientId);
  const twiml  = new VoiceResponse();
  const base   = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

  if (!client || !client.active) {
    twiml.say({ voice: "Polly.Joanna" }, "This service is currently unavailable. Please try again later.");
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  const features = getPlanFeatures(client.plan);
  if (!features.voice) {
    twiml.say({ voice: "Polly.Joanna" }, "Voice calling is not available on this plan. Please contact us on WhatsApp.");
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  const agentName = client.agentName || "your assistant";
  const greeting  = `Hello! I'm ${agentName} from ${client.businessName}. How may I help you today?`;

  const gather = twiml.gather({
    input:         "speech",
    action:        `${base}/twilio/voice-respond/${client.id}`,
    method:        "POST",
    language:      "en-NG",
    speechTimeout: "auto",
    timeout:       5,
  });

  gather.say({ voice: "Polly.Joanna" }, greeting);
  twiml.redirect({ method: "POST" }, `${base}/twilio/voice/${client.id}`);

  res.type("text/xml");
  res.send(twiml.toString());
});

// ─────────────────────────────────────────
// VOICE — Caller spoke, process and respond
// ─────────────────────────────────────────
router.post("/voice-respond/:clientId", async (req, res) => {
  const client      = await getClientById(req.params.clientId);
  const twiml       = new VoiceResponse();
  const base        = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const callerPhone = req.body.Caller || req.body.From || "";
  const speechText  = req.body.SpeechResult || "";

  if (!client || !client.active) {
    twiml.say({ voice: "Polly.Joanna" }, "Service unavailable.");
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  if (!speechText.trim()) {
    const gather = twiml.gather({
      input:         "speech",
      action:        `${base}/twilio/voice-respond/${client.id}`,
      method:        "POST",
      language:      "en-NG",
      speechTimeout: "auto",
      timeout:       5,
    });
    gather.say({ voice: "Polly.Joanna" }, "Sorry, I didn't catch that. Please go ahead.");
    twiml.redirect({ method: "POST" }, `${base}/twilio/voice/${client.id}`);
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  try {
    const { reply, order, escalate, paymentTriggered, paymentWA } =
      await chat(client.id, callerPhone, speechText, "call");

    const io       = req.app.get("io");
    const features = getPlanFeatures(client.plan);

    if (order)    io.to(client.id).emit("new_order", order);
    if (escalate) io.to(client.id).emit("escalation_needed", {
      clientId:  client.id,
      phone:     callerPhone,
      message:   speechText,
      timestamp: new Date().toISOString(),
      channel:   "call",
    });

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
      sendSMS(client, callerPhone, smsBody).catch(e => console.error("Payment SMS:", e.message));
    }

    if (paymentWA) {
      io.to(client.id).emit("payment_wa_pending", {
        clientId:  client.id,
        phone:     callerPhone,
        timestamp: new Date().toISOString(),
        message:   `Customer on ${callerPhone} was directed to WhatsApp for payment details.`,
      });
    }

    const gather = twiml.gather({
      input:         "speech",
      action:        `${base}/twilio/voice-respond/${client.id}`,
      method:        "POST",
      language:      "en-NG",
      speechTimeout: "auto",
      timeout:       6,
    });

    gather.say({ voice: "Polly.Joanna" }, reply);

    twiml.say({ voice: "Polly.Joanna" }, "Is there anything else I can help you with?");
    twiml.redirect({ method: "POST" }, `${base}/twilio/voice-respond/${client.id}`);

  } catch (e) {
    console.error("Voice respond error:", e);
    twiml.say({ voice: "Polly.Joanna" }, "I'm having a brief technical issue. Please hold on.");
    twiml.redirect({ method: "POST" }, `${base}/twilio/voice/${client.id}`);
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

// ─────────────────────────────────────────
// STATUS CALLBACK
// ─────────────────────────────────────────
router.post("/status/:clientId", (req, res) => { res.sendStatus(200); });

module.exports = router;
