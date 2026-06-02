/**
 * TaskBolt Email Service — Resend-powered transactional emails
 * 
 * Three email types:
 * 1. OTP verification code (sign-in)
 * 2. Welcome email (new user)
 * 3. Payment confirmation (credits purchased)
 */

const RESEND_API = "https://api.resend.com/emails";
const FROM_ADDRESS = process.env.RESEND_FROM || "TaskBolt <noreply@taskbolt.space>";
const FROM_FALLBACK = "TaskBolt <onboarding@resend.dev>";

function getFromAddress() {
  return process.env.RESEND_FROM || "TaskBolt <noreply@taskbolt.space>";
}

async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("[email] No RESEND_API_KEY configured");
    return { sent: false, error: "No API key" };
  }

  try {
    const res = await fetch(RESEND_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: getFromAddress(),
        to: [to],
        subject,
        html,
      }),
    });

    const data = await res.json();
    if (data.id) {
      console.log(`[email] Sent to ${to}: ${subject} (${data.id})`);
      return { sent: true, id: data.id };
    }
    console.error("[email] Failed:", data);
    return { sent: false, error: data.message || "Unknown error" };
  } catch (e) {
    console.error("[email] Exception:", e.message);
    return { sent: false, error: e.message };
  }
}

// ── Styles ─────────────────────────────────────────────
const STYLES = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #fafafa; margin: 0; padding: 0; }
  .wrapper { max-width: 480px; margin: 0 auto; padding: 40px 20px; }
  .card { background: white; border-radius: 16px; border: 1px solid #e8e8e8; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.04); }
  .card-header { padding: 32px 32px 0; text-align: center; }
  .logo { width: 56px; height: 56px; border-radius: 14px; margin-bottom: 16px; }
  .card-body { padding: 24px 32px 32px; }
  h1 { font-size: 1.4rem; font-weight: 700; color: #1a1a1a; margin: 0 0 8px; }
  .subtitle { color: #666; font-size: 0.95rem; margin: 0 0 24px; line-height: 1.5; }
  .code-box { background: #f5f5f7; padding: 16px 24px; border-radius: 12px; text-align: center; font-size: 2rem; font-weight: 800; letter-spacing: 0.3em; font-family: 'SF Mono', SFMono-Regular, Menlo, monospace; color: #1a1a1a; margin: 20px 0; }
  .divider { height: 1px; background: #f0f0f0; margin: 24px 0; }
  .meta { font-size: 0.8rem; color: #999; text-align: center; margin-top: 20px; }
  .btn { display: inline-block; background: linear-gradient(135deg, #1a1a2e, #16213e); color: white; padding: 14px 32px; border-radius: 12px; text-decoration: none; font-weight: 600; font-size: 0.95rem; margin: 12px 0; }
  .feature-row { display: flex; align-items: center; gap: 12px; padding: 10px 0; font-size: 0.9rem; color: #444; }
  .feature-icon { width: 32px; height: 32px; background: #f5f5f7; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 1rem; flex-shrink: 0; }
  .pack-badge { display: inline-block; background: #f0f0f0; color: #555; font-size: 0.72rem; font-weight: 600; padding: 4px 12px; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.05em; }
  .amount { font-size: 2rem; font-weight: 800; color: #1a1a1a; }
  .credits-amount { font-size: 1.1rem; font-weight: 600; color: #22c55e; }
  .footer { text-align: center; padding: 20px 32px 28px; font-size: 0.78rem; color: #aaa; line-height: 1.5; }
`;

function wrap(content, title) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="wrapper">
  <div class="card">
    ${content}
  </div>
  <div class="footer">
    TaskBolt — Intelligent Computer Management<br>
    <a href="https://taskbolt.space" style="color:#aaa;">taskbolt.space</a>
  </div>
</div>
</body>
</html>`;
}

// ── 1. OTP Verification Code ───────────────────────────
function otpHtml(code) {
  return wrap(`
    <div class="card-header">
      <img class="logo" src="https://taskbolt.space/icon.png" alt="TaskBolt">
      <h1>Sign-In Code</h1>
      <p class="subtitle">Use this code to sign in to TaskBolt</p>
    </div>
    <div class="card-body">
      <div class="code-box">${code}</div>
      <div class="divider"></div>
      <p class="meta">This code expires in 10 minutes.<br>If you didn't request this, you can safely ignore it.</p>
    </div>
  `, "Your TaskBolt Sign-In Code");
}

async function sendOtpEmail(to, code) {
  return sendEmail({
    to,
    subject: `${code} is your TaskBolt sign-in code`,
    html: otpHtml(code),
  });
}

// ── 2. Welcome Email ───────────────────────────────────
function welcomeHtml(email, displayName) {
  const name = displayName || email.split("@")[0];
  return wrap(`
    <div class="card-header">
      <img class="logo" src="https://taskbolt.space/icon.png" alt="TaskBolt">
      <h1>Welcome to TaskBolt, ${name}! 🎉</h1>
      <p class="subtitle">Your intelligent computer assistant is ready to go.</p>
    </div>
    <div class="card-body">
      <div class="feature-row">
        <div class="feature-icon">⚡</div>
        <div><strong>Setup & Configure</strong> — Auto-detect and set up your PC</div>
      </div>
      <div class="feature-row">
        <div class="feature-icon">🔧</div>
        <div><strong>Fix & Repair</strong> — Diagnose and fix system issues</div>
      </div>
      <div class="feature-row">
        <div class="feature-icon">🛡️</div>
        <div><strong>Security & Network</strong> — Harden and protect your machine</div>
      </div>
      <div class="feature-row">
        <div class="feature-icon">🌍</div>
        <div><strong>Browser & MCP</strong> — Browse the web and connect tools</div>
      </div>
      <div class="divider"></div>
      <p style="text-align:center;">
        <a class="btn" href="https://taskbolt.space">Open TaskBolt Desktop →</a>
      </p>
      <p class="meta">Signed in as: ${email}</p>
    </div>
  `, "Welcome to TaskBolt");
}

async function sendWelcomeEmail(to, displayName) {
  return sendEmail({
    to,
    subject: "Welcome to TaskBolt ⚡",
    html: welcomeHtml(to, displayName),
  });
}

// ── 3. Payment Confirmation ────────────────────────────
function paymentHtml(packName, credits, amount, email) {
  return wrap(`
    <div class="card-header">
      <img class="logo" src="https://taskbolt.space/icon.png" alt="TaskBolt">
      <h1>Payment Confirmed ✓</h1>
      <p class="subtitle">Your credits are ready to use.</p>
    </div>
    <div class="card-body">
      <div style="text-align:center; margin-bottom: 20px;">
        <span class="pack-badge">${packName} Pack</span>
      </div>
      <div style="text-align:center; margin: 20px 0;">
        <div class="amount">$${amount}</div>
        <div class="credits-amount">+${credits.toLocaleString()} credits added</div>
      </div>
      <div class="divider"></div>
      <div class="feature-row">
        <div class="feature-icon">✓</div>
        <div>Credits added instantly to your account</div>
      </div>
      <div class="feature-row">
        <div class="feature-icon">∞</div>
        <div>Credits never expire — use anytime</div>
      </div>
      <div class="feature-row">
        <div class="feature-icon">🤖</div>
        <div>1 credit = 200 tokens of AI processing</div>
      </div>
      <div class="divider"></div>
      <p style="text-align:center;">
        <a class="btn" href="https://taskbolt.space">Start Using TaskBolt →</a>
      </p>
      <p class="meta">Account: ${email}<br>Transaction processed securely via Dodo Payments</p>
    </div>
  `, `Payment Confirmed — ${packName} Pack`);
}

async function sendPaymentEmail(to, { packName, credits, amount }) {
  return sendEmail({
    to,
    subject: `Payment Confirmed — ${packName} Pack | TaskBolt`,
    html: paymentHtml(packName, credits, amount, to),
  });
}

module.exports = { sendOtpEmail, sendWelcomeEmail, sendPaymentEmail };
