import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/.well-known/oauth-protected-resource",
        destination: "/api/mcp/oauth-protected-resource",
      },
      {
        source: "/.well-known/oauth-protected-resource/mcp",
        destination: "/api/mcp/oauth-protected-resource/mcp",
      },
      {
        source: "/.well-known/oauth-protected-resource/api",
        destination: "/api/mcp/oauth-protected-resource/api",
      },
      {
        source: "/.well-known/oauth-authorization-server",
        destination: "/api/mcp/oauth-authorization-server",
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/shared/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        ],
      },
      {
        source: "/oauth/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        ],
      },
      {
        source: "/.well-known/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
