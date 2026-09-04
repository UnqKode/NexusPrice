import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained .next/standalone/ tree (server.js + only the traced
  // node_modules) so the Docker runtime image doesn't need the full
  // dependency install. See the Dockerfile: standalone does NOT copy public/
  // or .next/static automatically, so those are copied in explicitly.
  // Docs: node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/output.md
  output: "standalone",
};

export default nextConfig;
