// Protects the dashboard route group with a next-auth session - anyone
// without a valid session is redirected to the sign-in page before the
// (client-component) dashboard layout ever renders. Deliberately a
// middleware rather than a useSession()/SessionProvider check inside
// dashboard/layout.tsx: that file is a client component already, and this
// avoids restructuring it just to add a session gate.
export { default } from "next-auth/middleware";

export const config = {
  matcher: ["/dashboard/:path*"],
};
