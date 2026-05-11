// Twilio Voice Routes — handles inbound calls via Twilio TwiML
const express = require("express");
const router  = express.Router();
const twilio  = require("twilio");
const { chat, transcribeAudio } = require("../services/ai");
const { getClientById, getPlanFeatures } = require("../services/db");
const { sendSMS, sendWhatsApp } = require("../services/twilio");

const VoiceResponse = twilio.twiml.VoiceResponse;

// ── Inbound call ─────────────────────────────────────────
router.post("/voice/:clientId", async (req, res) => {
  const twiml  = new VoiceResponse();
  const client = await getClientById(req.params.clientId);
  const base   = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

  if (!client || !client.active) {
    twiml.say({ voice: "Polly.Joanna", language: "en-US" },
      "This service is currently unavailable. Please try again later.");
    res.type("text/xml"); return res.send(twiml.toString());
  }

  // ── Plan gate: Foundation does not include voice ──────
  const features = getPlanFeatures(client.plan);
  if (!features.voice) {
    twiml.say({ voice: "Polly.Joanna", language: "en-US" },
      "Voice calling is not available on this plan. Please contact us on WhatsApp.");
    res.type("text/xml"); return res.send(twiml.toString());
  }

  const agentName = client.agentName || "your assistant";
  twiml.say({ voice: "Polly.Joanna", language: "en-US" },
    `Hello! I'm ${agentName} from ${client.businessName}. How may I help you today?`);

  // Record customer speech — Whisper will transcribe it
  twiml.record({
    action:      `${base}/twilio/voice-respond/${client.id}`,
    method:      "POST",
    maxLength:   30,
    finishOnKey: "#",
    playBeep:    true,
    transcribe:  false, // We use Whisper instead of Twilio transcription
  });

  res.type("text/xml");
  res.send(twiml.toString());
});

// ── Recording callback ────────────────────────────────────
router.post("/voice-respond/:clientId", async (req, res) => {
  const twiml    = new VoiceResponse();
  const client   = await getClientById(req.params.clientId);
  const phone    = req.body.From || req.body.Caller || "";
  const recordUrl = req.body.RecordingUrl || "";
  const base     = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

  if (!client) {
    twiml.say("Service unavailable.");
    res.type("text/xml"); return res.send(twiml.toString());
  }

  const features = getPlanFeatures(client.plan);

  // Transcribe via Whisper
  let speechText = "";
  if (recordUrl) {
    // Twilio appends .json to RecordingUrl — use the raw URL for audio
    const audioUrl = recordUrl.replace(".json", "") + ".mp3";
    speechText = await transcribeAudio(audioUrl) || "";
  }

  if (!speechText) {
    twiml.say({ voice: "Polly.Joanna" },
      "Sorry, I didn't catch that. Please speak after the beep.");
    twiml.record({
      action:      `${base}/twilio/voice-respond/${client.id}`,
      maxLength:   30,
      finishOnKey: "#",
      playBeep:    true,
      transcribe:  false,
    });
    res.type("text/xml"); return res.send(twiml.toString());
  }

  try {
    const { reply, order, escalate, paymentTriggered, paymentWA } =
      await chat(client.id, phone, speechText, "call");
    const io = req.app.get("io");

    if (order)    io.to(client.id).emit("new_order", order);
    if (escalate) io.to(client.id).emit("escalation_needed", {
      clientId: client.id, phone, message: speechText,
      timestamp: new Date().toISOString(), channel: "call",
    });

    // Growth: customer was directed to WhatsApp for payment
    if (paymentWA) {
      io.to(client.id).emit("payment_wa_pending", {
        clientId: client.id, phone,
        timestamp: new Date().toISOString(),
        message: `Customer on ${phone} was directed to WhatsApp for payment details.`,
      });
    }

    // Premium: auto-send payment details via SMS
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

    // Speak the AI reply
    twiml.say({ voice: "Polly.Joanna", language: "en-US" }, reply);

    // Continue listening
    twiml.record({
      action:      `${base}/twilio/voice-respond/${client.id}`,
      maxLength:   30,
      finishOnKey: "#",
      playBeep:    true,
      transcribe:  false,
    });

    res.type("text/xml");
    res.send(twiml.toString());
  } catch (e) {
    console.error("Voice respond error:", e);
    twiml.say({ voice: "Polly.Joanna" },
      "I'm having a brief issue. Please hold on and try again.");
    res.type("text/xml");
    res.send(twiml.toString());
  }
});

module.exports = router;
