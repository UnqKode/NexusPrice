// Next 16 renamed the "middleware" file convention to "proxy" (this file was
// src/middleware.ts). It also analyzes the export more strictly: the old
// `export { default } from "next-auth/middleware"` re-export was no longer
// recognized as a function, so we call withAuth() explicitly, which returns
// a concrete middleware function Next can detect.
//
// Behavior is unchanged: any request matching `config.matcher` must carry a
// valid next-auth session token (authorized: token present), otherwise it's
// redirected to the sign-in page. This is what gates the dashboard - the
// dashboard's own API calls authenticate via this same session (see
// src/lib/apiAuth.ts).
import { withAuth } from "next-auth/middleware";

export default withAuth({
  callbacks: {
    authorized: ({ token }) => !!token,
  },
});

export const config = {
  matcher: ["/dashboard/:path*"],
};
