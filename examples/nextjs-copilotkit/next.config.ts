import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@kiri_ikki/thread-contracts", "@kiri_ikki/thread-client", "@kiri_ikki/thread-react"],
};

export default nextConfig;
