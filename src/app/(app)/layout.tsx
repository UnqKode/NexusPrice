import React from "react";

// Route-group layout for the marketing landing page and the dashboard. It
// deliberately does NOT render <html>/<body>/<Toaster> - those belong to the
// single root layout (src/app/layout.tsx). This used to duplicate all of
// that, which produced nested <html> tags and a second Toaster on every page
// under (app). It's kept as a plain pass-through (rather than deleted) as the
// natural place to add app-only chrome later without touching the auth
// routes' layout.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
