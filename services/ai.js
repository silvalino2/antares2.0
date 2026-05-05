// AI Brain — per-client personality with multilingual + escalation support
const OpenAI = require("openai");
const { getClientById, getSession, saveSession, createOrder, getPlanFeatures } = require("./db");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Detect language from user message
function detectLanguage(text) {
  const igboWords = ["biko","nna","nne","kedu","ọ","ụ","ị","gịnị","daalu","ezigbo","obi","ọdịmma","ana","nke","ọ bụ","ebe","ka","ya"];
  const pidginWords = ["abeg","wetin","dey","na","oga","wahala","sabi","comot","wey","dem","make","sha","chai","e don","no be","how far","na so"];
  const lower = text.toLowerCase();
  const igboScore   = igboWords.filter(w => lower.includes(w)).length;
  const pidginScore = pidginWords.filter(w => lower.includes(w)).length;
  if (igboScore >= 2)   return "igbo";
  if (pidginScore >= 2) return "pidgin";
  return "english";
}

function getLanguageInstruction(lang) {
  switch(lang) {
    case "igbo":
      return `The customer is speaking Igbo or a mix of Igbo and English. 
Respond warmly in Igbo-English mix. Use common Igbo greetings like "Ndewo", "Daalu" (thank you), "Biko" (please). 
Keep it natural — not every word needs to be Igbo, but sprinkle it naturally as an Igbo speaker would.`;
    case "pidgin":
      return `The customer is speaking Nigerian Pidgin. 
Respond in Nigerian Pidgin English — natural and friendly. 
Use phrases like "No wahala", "I go help you", "wetin you need", "e don do" naturally.`;
    default:
      return `Respond in clear, friendly Nigerian English.`;
  }
}

async function chat(clientId, phone, userMessage, channel = "sms") {
  const client = await getClientById(clientId);
  if (!client) return { reply: "This service is currently unavailable.", order: null, escalate: false };

  const session = await getSession(clientId, phone);
  const history = session.history || [];
  history.push({ role: "user", content: userMessage });
  if (history.length > 24) history.splice(0, history.length - 24);

  // Detect language
  const lang = detectLanguage(userMessage);
  const langInstruction = getLanguageInstruction(lang);

  // Build menu/services context
  let servicesText = "";
  if (client.menuOrServices && client.menuOrServices.length > 0) {
    servicesText = "\n\nAVAILABLE " + (client.businessType === "restaurant" ? "MENU" : "SERVICES/PRODUCTS") + ":\n";
    const cats = [...new Set(client.menuOrServices.map(i => i.category))];
    for (const cat of cats) {
      servicesText += `\n${cat.toUpperCase()}\n`;
      client.menuOrServices.filter(i => i.category === cat).forEach(i => {
        servicesText += `  • ${i.name}${i.price ? ` — ₦${Number(i.price).toLocaleString()}` : ""}${i.description ? ` (${i.description})` : ""}\n`;
      });
    }
  }

  // Payment info
  const payInfo = [
    client.bankAccount ? `Bank Transfer: ${client.bankAccountName}, ${client.bankName}, Acc: ${client.bankAccount}` : "",
    client.paystackKey ? `Online payment available — customer should use their Order ID as reference` : "",
  ].filter(Boolean).join("\n");

  const agentName = client.agentName || "your assistant";
  const features  = getPlanFeatures(client.plan);

  // ── Payment instruction per plan ──────────────────────────────────────────
  let voicePayInstruction = "";
  if (channel === "call" && client.bankAccount) {
    if (features.paymentSms) {
      // Premium: send SMS automatically
      voicePayInstruction = `IMPORTANT FOR CALLS: When the customer is ready to pay, DO NOT read out the account number.
Instead say: "I will send the payment details to your phone right now via SMS."
Then append <SEND_PAYMENT_SMS/> at the end of your reply.`;
    } else if (features.voice) {
      // Growth: direct customer to WhatsApp — don't send automatically
      const waNumber = client.whatsappNumber || client.publicPhone || "";
      voicePayInstruction = `IMPORTANT FOR CALLS: When the customer is ready to pay, DO NOT read out the account number and DO NOT send an SMS.
Instead say: "Please send us a WhatsApp message on ${waNumber} and we will send you the payment details there right away."
Then append <SEND_PAYMENT_WA/> at the end of your reply.`;
    }
  }

  const systemPrompt = `You are ${agentName}, the AI receptionist for ${client.businessName}.
${client.personality}

LANGUAGE: ${langInstruction}

${servicesText}

${payInfo ? `PAYMENT INSTRUCTIONS:\n${payInfo}` : ""}

${voicePayInstruction}

RULES:
- You are ${agentName}. Always refer to yourself by this name if asked.
- Only offer items/services listed above
- Always confirm before finalizing
- SMS/WhatsApp: keep replies concise. Calls: be conversational and natural
- Ask for the customer's name early in the conversation
- Never invent prices or services not listed
- If a customer asks something completely outside your knowledge or requests to speak to a human, append <ESCALATE/> at the end of your reply
- For calls, avoid long pauses — keep sentences short and clear

When customer has confirmed their complete order/booking, append this at the END of your reply:
<ORDER_READY>
{"items":[{"name":"Item","qty":1,"price":0}],"total":0,"notes":""}
</ORDER_READY>`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: systemPrompt }, ...history],
      max_tokens: 400,
      temperature: 0.7,
    });

    const reply = res.choices[0].message.content;
    history.push({ role: "assistant", content: reply });
    await saveSession(clientId, phone, { history, lastLang: lang });

    // Parse order
    let order = null;
    const orderMatch = reply.match(/<ORDER_READY>([\s\S]*?)<\/ORDER_READY>/);
    if (orderMatch) {
      try {
        const data = JSON.parse(orderMatch[1].trim());
        order = await createOrder(clientId, { phone, channel, items: data.items, total: data.total, notes: data.notes || "", customer: extractName(history) });
      } catch (e) { console.error("Order parse:", e.message); }
    }

    // Check flags
    const escalate         = reply.includes("<ESCALATE/>");
    const paymentTriggered = reply.includes("<SEND_PAYMENT_SMS/>");
    const paymentWA        = reply.includes("<SEND_PAYMENT_WA/>");

    const cleanReply = reply
      .replace(/<ORDER_READY>[\s\S]*?<\/ORDER_READY>/g, "")
      .replace(/<SEND_PAYMENT_SMS\/>/g, "")
      .replace(/<SEND_PAYMENT_WA\/>/g, "")
      .replace(/<ESCALATE\/>/g, "")
      .trim();

    return { reply: cleanReply, order, escalate, paymentTriggered, paymentWA, lang };
  } catch (err) {
    console.error("OpenAI error:", err.message);
    return { reply: "We're having a brief technical issue. Please try again shortly.", order: null, escalate: false };
  }
}

// Transcribe WhatsApp voice notes via Whisper
async function transcribeAudio(audioUrl) {
  try {
    const axios = require("axios");
    const response = await axios.get(audioUrl, { responseType: "arraybuffer" });
    const buffer = Buffer.from(response.data);
    const { Readable } = require("stream");
    const stream = Readable.from(buffer);
    stream.path = "audio.ogg";
    const transcription = await openai.audio.transcriptions.create({
      file: stream,
      model: "whisper-1",
      language: "en", // Whisper handles Igbo/Pidgin reasonably well with auto-detection too
    });
    return transcription.text;
  } catch (err) {
    console.error("Whisper transcription error:", err.message);
    return null;
  }
}

function extractName(history) {
  for (const m of history) {
    if (m.role === "user") {
      const match = m.content.match(/(?:my name is|i am|i'm|this is|call me)\s+([A-Z][a-z]+)/i);
      if (match) return match[1];
    }
  }
  return "Guest";
}

module.exports = { chat, transcribeAudio };
