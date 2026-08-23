"use client";

// Wraps the app in next-auth's SessionProvider so client components can read
// the dashboard session via useSession() - needed for the login/logout UI
// that makes Task 7's session-cookie auth actually reachable from the
// browser. Kept as its own client component because the root layout is a
// server component and SessionProvider must run on the client.
import { SessionProvider } from "next-auth/react";
import React from "react";

export default function Providers({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
