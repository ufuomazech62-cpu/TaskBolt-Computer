/**
 * /api/composio/connect
 * 
 * Server-side Composio OAuth handler.
 * - Receives connector request from TaskBolt desktop app
 * - Uses Composio API key (stored as Vercel env var, NEVER exposed to users)
 * - Returns the OAuth redirect URL
 * - Desktop app opens that URL in the user's browser
 * 
 * Flow:
 * 1. User clicks "Connect Gmail" in TaskBolt
 * 2. TaskBolt calls this endpoint with { service: "gmail" }
 * 3. This endpoint calls Composio API with the server-side key
 * 4. Composio returns an OAuth redirect URL
 * 5. This endpoint returns the URL to TaskBolt
 * 6. TaskBolt opens the URL in the user's browser
 * 7. User logs in with their Gmail normally
 * 8. Composio stores the token server-side
 */

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  // Verify auth (user must be logged into TaskBolt)
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const token = authHeader.replace('Bearer ', '');
  
  // Verify the user's TaskBolt JWT
  try {
    const accountRes = await fetch('https://taskbolt.space/api/account', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!accountRes.ok) {
      return res.status(401).json({ error: 'Invalid token' });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Auth verification failed' });
  }
  
  const { service } = req.body;
  
  if (!service) {
    return res.status(400).json({ error: 'Service name required' });
  }
  
  // Composio API key — stored as Vercel environment variable
  const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY;
  if (!COMPOSIO_API_KEY) {
    return res.status(500).json({ error: 'Composio not configured on server' });
  }
  
  // Map service slugs to Composio app names
  const APP_MAP = {
    'gmail': 'GMAIL',
    'google-calendar': 'GOOGLECALENDAR',
    'google-drive': 'GOOGLEDRIVE',
    'google-docs': 'GOOGLEDOCS',
    'google-sheets': 'GOOGLESHEETS',
    'google-workspace': 'GOOGLE_WORKSPACE',
    'github': 'GITHUB',
    'slack': 'SLACK',
    'notion': 'NOTION',
    'vercel': 'VERCEL',
    'youtube': 'YOUTUBE',
    'twitter': 'TWITTER',
    'x': 'TWITTER',
    'linkedin': 'LINKEDIN',
    'discord': 'DISCORD',
    'telegram': 'TELEGRAM',
    'zoom': 'ZOOM',
    'trello': 'TRELLO',
    'asana': 'ASANA',
    'linear': 'LINEAR',
    'outlook': 'OUTLOOK',
    'microsoft-word': 'MICROSOFTWORD',
    'microsoft-excel': 'MICROSOFTEXCEL',
    'microsoft-powerpoint': 'MICROSOFTPOWERPOINT',
    'wordpress': 'WORDPRESS',
    'shopify': 'SHOPIFY',
    'canva': 'CANVA',
    'figma': 'FIGMA',
    'dropbox': 'DROPBOX',
  };
  
  const appName = APP_MAP[service];
  if (!appName) {
    return res.status(400).json({ error: `Unknown service: ${service}` });
  }
  
  try {
    // Call Composio API to initiate OAuth connection
    const composioRes = await fetch('https://backend.composio.dev/api/v1/connectedAccounts/integration', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': COMPOSIO_API_KEY,
      },
      body: JSON.stringify({
        appName: appName,
        // The redirect URL where user will be sent back after auth
        redirectUri: 'https://taskbolt.space/api/composio/callback',
      }),
    });
    
    if (!composioRes.ok) {
      const errorText = await composioRes.text();
      console.error('Composio API error:', composioRes.status, errorText);
      
      // Try alternate endpoint
      const altRes = await fetch(`https://backend.composio.dev/api/v1/apps/${appName}/initiate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': COMPOSIO_API_KEY,
        },
        body: JSON.stringify({
          redirectUri: 'https://taskbolt.space/api/composio/callback',
        }),
      });
      
      if (altRes.ok) {
        const altData = await altRes.json();
        const redirectUrl = altData.redirectUrl || altData.redirect_url || altData.url;
        if (redirectUrl) {
          return res.status(200).json({ 
            success: true, 
            redirectUrl,
            connectionId: altData.id || altData.connectionId,
          });
        }
      }
      
      return res.status(502).json({ 
        error: `Composio API error: ${composioRes.status}`,
        details: errorText?.substring(0, 200),
      });
    }
    
    const data = await composioRes.json();
    const redirectUrl = data.redirectUrl || data.redirect_url || data.url || data.redirectUri;
    
    if (!redirectUrl) {
      // Might already be connected
      return res.status(200).json({ 
        success: true, 
        alreadyConnected: true,
        data: data,
      });
    }
    
    return res.status(200).json({ 
      success: true, 
      redirectUrl,
      connectionId: data.id || data.connectionId,
    });
    
  } catch (e) {
    console.error('Composio connect error:', e);
    return res.status(500).json({ error: `Internal error: ${e.message}` });
  }
}
