// Minimal, real next-auth config - a single admin credential pair from env
// vars, not a user database. This project has exactly one intended human
// user (the dashboard operator), matching the same single-tenant reasoning
// behind the API_KEYS env-allowlist in apiAuth.ts: building self-service
// registration/account storage for a need that doesn't exist yet would be
// scope the project isn't asking for. JWT session strategy (next-auth's
// default for CredentialsProvider) - no database adapter, so no Mongo
// schema for sessions/accounts is needed either.
import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
  providers: [
    CredentialsProvider({
      name: "Dashboard login",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const expectedUsername = process.env.DASHBOARD_USERNAME;
        const expectedPassword = process.env.DASHBOARD_PASSWORD;

        if (!expectedUsername || !expectedPassword) {
          console.error("⚠️ DASHBOARD_USERNAME/DASHBOARD_PASSWORD are not configured");
          return null;
        }

        if (credentials?.username === expectedUsername && credentials?.password === expectedPassword) {
          // id/email are required by next-auth's User shape - there's no
          // real user record to point to, so the username stands in for both.
          return { id: expectedUsername, email: expectedUsername, name: expectedUsername };
        }

        return null;
      },
    }),
  ],
};
