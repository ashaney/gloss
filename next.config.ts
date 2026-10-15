import type { NextConfig } from "next";

// Who may show the reader in a frame: the aarOS desk on this machine, by origin
// (space- or comma-separated). Read at build time. Unset, only the reader itself may.
const frameAncestors = (process.env.FRAME_ANCESTORS ?? "")
  .split(/[\s,]+/)
  .filter((o) => /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o));

const framing = frameAncestors.length
  ? { key: "Content-Security-Policy", value: `frame-ancestors 'self' ${frameAncestors.join(" ")}` }
  : { key: "X-Frame-Options", value: "SAMEORIGIN" };

const nextConfig: NextConfig = {
  serverExternalPackages: ["linkedom"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          framing,
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
