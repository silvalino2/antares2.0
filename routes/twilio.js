// Twilio Routes — WhatsApp + SMS only (voice moved to Africa's Talking)
const express  = require("express");
const router   = express.Router();
const twilio   = require("twilio");
const { chat, transcribeAudio } = require("../services/ai");
const { getClientById, getPlanFeatures } = require("../services/db");
const { sendWhatsApp, sendSMS } = require("../services/twilio");

const MessagingResponse = twilio.twiml.MessagingResponse;

// SMS
router.post("/sms/:clientId", async (req, res) => {
  const client = await getClientById(req.params.clientId);
  const twiml  = new MessagingResponse();
  if (!client || !client.active) {
    twiml.message("Service unavailable."); res.type("text/xml"); return res.send(twiml.toString());
  }
  try {
    const { reply, order, escalate } = await chat(client.id, req.body.From, req.body.Body?.trim(), "sms");
    const io = req.app.get("io");
    if (order)   io.to(client.id).emit("new_order", order);
    if (escalate) io.to(client.id).emit("escalation_needed", { clientId: client.id, phone: req.body.From, message: req.body.Body, timestamp: new Date().toISOString(), channel: "sms" });
    twiml.message(reply);
  } catch (e) { twiml.message("Something went wrong. Please try again."); }
  res.type("text/xml"); res.send(twiml.toString());
});

// WhatsApp text
router.post("/whatsapp/:clientId", async (req, res) => {
  const client = await getClientById(req.params.clientId);
  if (!client || !client.active) return res.sendStatus(200);

  // Handle voice notes
  const numMedia = parseInt(req.body.NumMedia || "0");
  let userMessage = req.body.Body?.trim() || "";

  if (numMedia > 0 && req.body.MediaContentType0?.includes("audio")) {
    const audioUrl  = req.body.MediaUrl0;
    const transcribed = await transcribeAudio(audioUrl);
    if (transcribed) {
      userMessage = transcribed;
    } else {
      await sendWhatsApp(client, req.body.From, "Sorry, I couldn't process your voice note. Please type your message.");
      return res.sendStatus(200);
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

    await sendWhatsApp(client, req.body.From, reply);

    // Growth plan: if customer is asking about payment on WhatsApp, auto-send bank details
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
        // Small delay so it comes as a second message after the AI reply
        setTimeout(() => {
          sendWhatsApp(client, req.body.From, paymentMsg)
            .catch(e => console.error("Payment WA send:", e.message));
        }, 1200);
      }
    }  } catch (e) { console.error("WA error:", e); }
  res.sendStatus(200);
});

// Status callback
router.post("/status/:clientId", (req, res) => { res.sendStatus(200); });

module.exports = router;
