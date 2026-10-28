import type { NextConfig } from "next";

// Validate environment variables at build time
import "./lib/env";

const nextConfig: NextConfig = {
  // Native binaries; the text font is read from ./fonts at runtime.
  serverExternalPackages: ["@napi-rs/canvas", "sharp"],
  outputFileTracingIncludes: { "/**": ["./fonts/**/*"] },
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
