const crypto = require("crypto");
const { sql, initDB } = require("../_db");

const DODO_API = "https://live.dodopayments.com";

const PACKS = {
  starter:  { credits: 1000  },
  basic:    { credits: 4000  },
  standard: { credits: 10000 },
  pro:      { credits: 30000 },
  business: { credits: 70000 },
};

/**
 * Verify Dodo Payments webhook using Standard Webhooks spec.
 * Headers: webhook-id, webhook-timestamp, webhook-signature
 * Secret format: whsec_<base64-encoded-key>
 * Signature format: v1 <base64(hmac-sha256(secret, "${id}.${timestamp}.${body}"))>
 */
function verifyWebhookSignature(body, headers, secret) {
  if (!secret) return true; // Skip verification if no secret configured

  const webhookId = headers["webhook-id"] || "";
  const webhookTimestamp = headers["webhook-timestamp"] || "";
  const webhookSignature = headers["webhook-signature"] || "";

  if (!webhookId || !webhookTimestamp || !webhookSignature) return false;

  // Check timestamp is within 5 minutes
  const ts = parseInt(webhookTimestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 300) return false;

  // Decode secret (strip whsec_ prefix if present)
  const secretKey = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const secretBytes = Buffer.from(secretKey, "base64");

  // Create signed content
  const signedContent = `${webhookId}.${webhookTimestamp}.${body}`;

  // Compute HMAC SHA256
  const expectedSig = crypto.createHmac("sha256", secretBytes).update(signedContent).digest("base64");
  const expectedSignature = `v1 ${expectedSig}`;

  // Check against all provided signatures (space-separated)
  const signatures = webhookSignature.split(" ");
  for (const sig of signatures) {
    if (sig.trim() === expectedSignature) return true;
  }

  return false;
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  await initDB();

  // Get raw body for signature verification
  const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);

  // Verify signature
  const webhookSecret = process.env.DODO_PAYMENTS_WEBHOOK_KEY || "";
  if (webhookSecret) {
    const isValid = verifyWebhookSignature(rawBody, req.headers, webhookSecret);
    if (!isValid) {
      console.error("Webhook signature verification failed");
      return res.status(401).json({ error: "Invalid signature" });
    }
  }

  const event = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const eventType = event.type || "";

  console.log(`Dodo webhook received: ${eventType}`, JSON.stringify(event).slice(0, 500));

  // Handle payment.succeeded event
  if (eventType !== "payment.succeeded") {
    return res.status(200).json({ ok: true, message: `Ignored event: ${eventType}` });
  }

  // Extract data from the payment event
  const paymentData = event.data || {};
  const metadata = paymentData.metadata || event.metadata || {};
  
  // Try multiple paths for metadata (Dodo may nest it differently)
  const userId = metadata.user_id || paymentData.metadata?.user_id;
  const packId = metadata.pack_id || paymentData.metadata?.pack_id;
  const txId = metadata.transaction_id || paymentData.metadata?.transaction_id;
  const creditsStr = metadata.credits || paymentData.metadata?.credits;
  const paymentId = paymentData.payment_id || event.payment_id;

  if (!userId || !packId) {
    console.log("Webhook missing user_id or pack_id in metadata:", JSON.stringify(metadata));
    return res.status(200).json({ ok: true, message: "No metadata" });
  }

  const pack = PACKS[packId];
  const credits = creditsStr ? parseInt(creditsStr, 10) : (pack ? pack.credits : 0);

  if (!credits) {
    console.log("Could not determine credits amount");
    return res.status(200).json({ ok: true, message: "Invalid credits" });
  }

  // Verify payment with Dodo API
  const dodoKey = process.env.DODO_PAYMENTS_API_KEY;
  if (dodoKey && paymentId) {
    try {
      const verifyResp = await fetch(`${DODO_API}/payments/${paymentId}`, {
        headers: { "Authorization": `Bearer ${dodoKey}` },
      });
      const verifyData = await verifyResp.json();
      if (verifyData.status && verifyData.status !== "succeeded") {
        console.log("Payment verification failed:", verifyData.status);
        return res.status(200).json({ ok: true, message: "Payment not succeeded" });
      }
    } catch (e) {
      console.log("Payment verification error (proceeding):", e.message);
    }
  }

  // Idempotency check — don't double-add credits
  if (txId) {
    const existingTx = await sql`SELECT status FROM transactions WHERE id = ${txId}::uuid`;
    if (existingTx.length && existingTx[0].status === "completed") {
      return res.status(200).json({ ok: true, message: "Already processed" });
    }
  }

  // Allocate credits
  const existing = await sql`SELECT id FROM credits WHERE user_id = ${userId}::uuid`;
  if (existing.length === 0) {
    await sql`
      INSERT INTO credits (user_id, balance, total_allocated, total_used)
      VALUES (${userId}::uuid, ${credits}, ${credits}, 0)
    `;
  } else {
    await sql`
      UPDATE credits SET
        balance = balance + ${credits},
        total_allocated = total_allocated + ${credits},
        updated_at = NOW()
      WHERE user_id = ${userId}::uuid
    `;
  }

  // Update transaction status
  if (txId) {
    await sql`UPDATE transactions SET status = 'completed', flutterwave_ref = ${paymentId || 'dodo-' + Date.now()} WHERE id = ${txId}::uuid`;
  }

  console.log(`Credits allocated: ${credits} to user ${userId} (pack: ${packId})`);
  return res.status(200).json({ ok: true, message: `Credits added: ${credits}` });
};
