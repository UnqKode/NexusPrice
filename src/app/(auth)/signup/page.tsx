import { redirect } from "next/navigation";

// There's no self-service registration here - this project has exactly one
// credential pair (DASHBOARD_USERNAME/DASHBOARD_PASSWORD, see
// src/lib/authOptions.ts), not a user database, matching the same
// single-tenant reasoning behind the API_KEYS env-allowlist. A "signup"
// page doesn't make sense for that, so this redirects to next-auth's own
// built-in sign-in page rather than presenting a form that would imply
// account creation is possible.
export default function SignupPage() {
  redirect("/api/auth/signin");
}
