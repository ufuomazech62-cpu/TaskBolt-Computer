import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { generateApiKey } from '@/lib/api-keys';
import { createApiKey, getApiKeysByUserId } from '@/lib/db';
import { nanoid } from 'nanoid';

/**
 * Desktop callback endpoint
 * 
 * After the user signs in on the web, this endpoint:
 * 1. Verifies the session
 * 2. Gets or creates an API key for the user
 * 3. Returns a deep link URL that the desktop app can open
 * 
 * The desktop app opens this URL in the browser, then listens for the redirect.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    
    if (!(session?.user as any)?.id) {
      // Redirect to sign-in page
      return NextResponse.redirect(new URL('/auth/signin?callbackUrl=/api/desktop-callback', req.url));
    }
    
    const userId = session.user.id;
    
    // Check if user already has an active API key
    const existingKeys = getApiKeysByUserId(userId);
    const activeKey = existingKeys.find(k => k.is_active);
    
    let rawKey: string;
    let keyPrefix: string;
    
    if (activeKey) {
      // User already has a key - we can't show the raw key again
      // Generate a new one for this desktop session
      const generated = generateApiKey(userId);
      rawKey = generated.rawKey;
      keyPrefix = generated.keyPrefix;
      
      createApiKey({
        id: nanoid(),
        user_id: userId,
        key_hash: generated.keyHash,
        key_prefix: keyPrefix,
        name: 'Desktop App',
        credits_allocated: 0,
        credits_used: 0,
        is_active: 1,
      });
    } else {
      // Create first API key
      const generated = generateApiKey(userId);
      rawKey = generated.rawKey;
      keyPrefix = generated.keyPrefix;
      
      createApiKey({
        id: nanoid(),
        user_id: userId,
        key_hash: generated.keyHash,
        key_prefix: keyPrefix,
        name: 'Default',
        credits_allocated: 0,
        credits_used: 0,
        is_active: 1,
      });
    }
    
    // Redirect to the success page with the key
    const successUrl = new URL('/auth/desktop-success', req.url);
    successUrl.searchParams.set('key', rawKey);
    successUrl.searchParams.set('email', session.user.email || '');
    
    return NextResponse.redirect(successUrl);
    
  } catch (error: any) {
    console.error('[API] Desktop callback failed:', error);
    return NextResponse.json(
      { error: error.message || 'Desktop callback failed' },
      { status: 500 }
    );
  }
}
