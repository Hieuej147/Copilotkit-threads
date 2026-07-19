import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@threads/contracts", "@threads/client", "@threads/react"],
};

export default nextConfig;
