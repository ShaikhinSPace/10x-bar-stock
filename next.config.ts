import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev-only. Without this, opening the dev server from a phone on the LAN gets its
  // JS chunks and HMR blocked as cross-origin — the page renders but never hydrates,
  // so nothing is clickable. Has no effect on a production build.
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", "172.16.*.*"],
};

export default nextConfig;
