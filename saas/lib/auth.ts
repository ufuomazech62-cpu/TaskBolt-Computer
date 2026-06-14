import { NextAuthOptions } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import EmailProvider from 'next-auth/providers/email';
import { getUserByEmail, createUser, getUserById, createVerificationToken, getVerificationToken, deleteVerificationToken } from './db';
import { nanoid } from 'nanoid';

// Custom SQLite adapter for NextAuth (minimal — just verification tokens + user lookup)
const sqliteAdapter = {
  async createVerificationToken(data: { identifier: string; token: string; expires: Date }) {
    createVerificationToken(data.identifier, data.token, data.expires);
    return data;
  },
  async useVerificationToken({ identifier, token }: { identifier: string; token: string }) {
    const vt = getVerificationToken(identifier, token);
    if (!vt) return null;
    deleteVerificationToken(identifier, token);
    return { identifier: vt.identifier, token: vt.token, expires: new Date(vt.expires) };
  },
  async getUserByEmail(email: string) {
    const user = getUserByEmail(email);
    if (!user) return null;
    return { id: user.id, email: user.email, name: user.name, image: user.image, emailVerified: null };
  },
  async getUser(id: string) {
    const user = getUserById(id);
    if (!user) return null;
    return { id: user.id, email: user.email, name: user.name, image: user.image, emailVerified: null };
  },
  async createUser(data: { email: string; name?: string | null; image?: string | null }) {
    const newUser = createUser({
      id: nanoid(),
      email: data.email,
      name: data.name || data.email.split('@')[0],
      image: data.image || null,
      provider: 'email',
      provider_id: data.email,
      credits: 1000,
    });
    return { id: newUser.id, email: newUser.email, name: newUser.name, image: newUser.image, emailVerified: null };
  },
  async updateUser(data: { id: string; email?: string; name?: string; image?: string; emailVerified?: Date | null }) {
    return { id: data.id, email: data.email || '', name: data.name || null, image: data.image || null, emailVerified: null };
  },
};

export const authOptions: NextAuthOptions = {
  adapter: sqliteAdapter as any,
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    }),
    EmailProvider({
      server: {
        host: process.env.SMTP_HOST || 'smtp.resend.com',
        port: Number(process.env.SMTP_PORT) || 465,
        secure: true,
        auth: {
          user: process.env.SMTP_USER || 'resend',
          pass: process.env.SMTP_PASS || '',
        },
      },
      from: process.env.EMAIL_FROM || 'noreply@taskbolt.space',
    }),
  ],
  
  callbacks: {
    async signIn({ user, account, profile }) {
      const email = user.email;
      if (!email) return false;

      let dbUser = getUserByEmail(email);
      
      if (!dbUser) {
        // Create new user
        dbUser = createUser({
          id: nanoid(),
          email,
          name: user.name || email.split('@')[0],
          image: user.image || null,
          provider: account?.provider || 'email',
          provider_id: account?.providerAccountId || email,
          credits: 1000, // Free credits
        });
      }
      
      // Attach DB user ID to session
      user.id = dbUser.id;
      
      return true;
    },
    
    async session({ session, token }) {
      if (token.sub) {
        session.user.id = token.sub;
      }
      return session;
    },
    
    async jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
      }
      return token;
    },
  },
  
  pages: {
    signIn: '/auth/signin',
  },
  
  session: {
    strategy: 'jwt',
  },
  
  secret: process.env.NEXTAUTH_SECRET,
};
