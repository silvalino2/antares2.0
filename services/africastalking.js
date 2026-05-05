// Africa's Talking Voice Service — replaces Twilio for voice calls
// Lower latency on Nigerian networks (MTN, Airtel, Glo, 9mobile)
const AfricasTalking = require("africastalking");

let at = null;

function getAT() {
  if (!at) {
    at = AfricasTalking({
      apiKey:   process.env.AT_API_KEY,
      username: process.env.AT_USERNAME,
    });
  }
  return at;
}

async function makeCall(to, from, callbackUrl) {
  try {
    const voice = getAT().VOICE;
    const result = await voice.call({ callFrom: from, callTo: [to] });
    return { success: true, result };
  } catch (err) {
    console.error("AT call error:", err.message);
    return { success: false, error: err.message };
  }
}

// Build AT SSML/XML response — equivalent to Twilio TwiML but for Africa's Talking
function buildResponse(actions) {
  // actions: array of { type, text, url, waitForInput, callbackUrl }
  let xml = `<?xml version="1.0" encoding="UTF-8"?><Response>`;
  for (const action of actions) {
    switch (action.type) {
      case "say":
        xml += `<Say playBeep="${action.playBeep || 'false'}" voice="${action.voice || 'woman'}">${escapeXml(action.text)}</Say>`;
        break;
      case "getDigits":
        xml += `<GetDigits timeout="${action.timeout || 30}" finishOnKey="${action.finishOnKey || '#'}" callbackUrl="${action.callbackUrl}">`;
        if (action.text) xml += `<Say>${escapeXml(action.text)}</Say>`;
        xml += `</GetDigits>`;
        break;
      case "record":
        xml += `<Record finishOnKey="${action.finishOnKey || '#'}" maxLength="${action.maxLength || 60}" trimSilence="true" playBeep="true" callbackUrl="${action.callbackUrl}"/>`;
        break;
      case "play":
        xml += `<Play url="${action.url}"/>`;
        break;
      case "dial":
        xml += `<Dial phoneNumbers="${action.phoneNumbers}" record="${action.record || 'false'}"/>`;
        break;
    }
  }
  xml += `</Response>`;
  return xml;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

module.exports = { makeCall, buildResponse };
