import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native binaries; the text font is read from ./fonts at runtime.
  serverExternalPackages: ["@napi-rs/canvas", "sharp"],
  outputFileTracingIncludes: { "/**": ["./fonts/**/*"] },
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
