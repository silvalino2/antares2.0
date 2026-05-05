// Monthly Performance Report — Premium plan only
const { getOrdersByClient, getClientById, getPlanFeatures } = require("./db");

async function generateMonthlyReport(clientId, year, month) {
  const client = await getClientById(clientId);
  if (!client) return { error: "Client not found" };

  // Plan gate
  const features = getPlanFeatures(client.plan);
  if (!features.monthlyReport) {
    return { error: "Monthly reports are available on the Premium plan only." };
  }

  const orders = await getOrdersByClient(clientId);

  // Filter to requested month
  const start = new Date(year, month - 1, 1);
  const end   = new Date(year, month, 1);
  const monthOrders = orders.filter(o => {
    const d = new Date(o.createdAt);
    return d >= start && d < end;
  });

  // Channel breakdown
  const byChannel = { call: 0, whatsapp: 0, sms: 0 };
  monthOrders.forEach(o => { if (byChannel[o.channel] !== undefined) byChannel[o.channel]++; });

  // Revenue
  const verifiedOrders  = monthOrders.filter(o => o.paymentStatus === "verified");
  const totalRevenue    = verifiedOrders.reduce((s, o) => s + (o.total || 0), 0);
  const pendingRevenue  = monthOrders
    .filter(o => o.paymentStatus !== "verified")
    .reduce((s, o) => s + (o.total || 0), 0);

  // Daily volume (for trend)
  const dailyVolume = {};
  monthOrders.forEach(o => {
    const day = new Date(o.createdAt).getDate();
    dailyVolume[day] = (dailyVolume[day] || 0) + 1;
  });

  // Peak day
  let peakDay = null, peakCount = 0;
  Object.entries(dailyVolume).forEach(([day, count]) => {
    if (count > peakCount) { peakCount = count; peakDay = day; }
  });

  // Escalations (orders that were escalated — flagged in notes)
  const escalations = monthOrders.filter(o => o.notes?.includes("escalated")).length;

  const monthName = new Date(year, month - 1, 1)
    .toLocaleString("en-NG", { month: "long", year: "numeric" });

  return {
    businessName:   client.businessName,
    agentName:      client.agentName,
    period:         monthName,
    generatedAt:    new Date().toISOString(),
    summary: {
      totalInteractions:  monthOrders.length,
      totalOrders:        monthOrders.length,
      verifiedOrders:     verifiedOrders.length,
      escalations,
      conversionRate:     monthOrders.length
        ? `${((verifiedOrders.length / monthOrders.length) * 100).toFixed(1)}%`
        : "0%",
    },
    revenue: {
      confirmed:  totalRevenue,
      pending:    pendingRevenue,
      total:      totalRevenue + pendingRevenue,
      formatted: {
        confirmed: `₦${totalRevenue.toLocaleString()}`,
        pending:   `₦${pendingRevenue.toLocaleString()}`,
        total:     `₦${(totalRevenue + pendingRevenue).toLocaleString()}`,
      },
    },
    channels: {
      calls:    byChannel.call,
      whatsapp: byChannel.whatsapp,
      sms:      byChannel.sms,
      topChannel: Object.entries(byChannel).sort((a,b)=>b[1]-a[1])[0]?.[0] || "whatsapp",
    },
    peakDay: peakDay ? `Day ${peakDay} of the month (${peakCount} interactions)` : "No data",
    dailyVolume,
    insights: generateInsights(monthOrders, byChannel, verifiedOrders, client),
  };
}

function generateInsights(orders, byChannel, verified, client) {
  const insights = [];

  if (orders.length === 0) {
    insights.push("No interactions recorded this month. Ensure your WhatsApp and phone lines are correctly connected.");
    return insights;
  }

  // Top channel
  const topCh = Object.entries(byChannel).sort((a,b)=>b[1]-a[1])[0];
  if (topCh) insights.push(`Your busiest channel was ${topCh[0]} with ${topCh[1]} interactions.`);

  // Conversion
  const rate = orders.length ? (verified.length / orders.length) * 100 : 0;
  if (rate >= 60) insights.push(`Strong conversion rate of ${rate.toFixed(1)}% — most customer interactions are completing successfully.`);
  else if (rate >= 30) insights.push(`Conversion rate of ${rate.toFixed(1)}% — there is room to improve how ${client.agentName} closes interactions.`);
  else if (orders.length > 0) insights.push(`Low conversion rate of ${rate.toFixed(1)}% — consider reviewing your menu or services list for accuracy.`);

  // After hours proxy — orders between 10pm and 6am
  const afterHours = orders.filter(o => {
    const h = new Date(o.createdAt).getHours();
    return h >= 22 || h < 6;
  }).length;
  if (afterHours > 0) insights.push(`${afterHours} interaction${afterHours > 1 ? "s" : ""} occurred after 10 PM — revenue that would have been lost without ${client.agentName}.`);

  return insights;
}

module.exports = { generateMonthlyReport };
