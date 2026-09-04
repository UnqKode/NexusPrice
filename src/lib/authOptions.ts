// a simple auth mechanism via next Auth

import type { NextAuthOptions } from "next-auth"; // this is just type safety for typescript
import CredentialsProvider from "next-auth/providers/credentials"; // this means we are using username and passwords credentials

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
  providers: [
    CredentialsProvider({ //This tells NextAuth: We're going to authenticate users using credentials that we provide ourselves.
      name: "Dashboard login", //providing a name for this authentication provider
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const expectedUsername = process.env.DASHBOARD_USERNAME; // since there is only one user i put it in env file
        const expectedPassword = process.env.DASHBOARD_PASSWORD; 

        if (!expectedUsername || !expectedPassword) { // if nothing in env then return null
          console.error("⚠️ DASHBOARD_USERNAME/DASHBOARD_PASSWORD are not configured");
          return null;
        }

        if (credentials?.username === expectedUsername && credentials?.password === expectedPassword) {
          // id/email are required by next-auth's User shape - there's no
          // real user record to point to, so the username stands in for both.
          return { id: expectedUsername, email: expectedUsername, name: expectedUsername }; // if match found proceed
        }

        return null; // if incorrect passwords return null;
      },
    }),
  ],
};
