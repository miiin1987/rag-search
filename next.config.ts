import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // PDF解析ライブラリはサーバーサイドでのみ使用、Next.js のバンドルから除外
  serverExternalPackages: ["pdf-parse", "pdfjs-dist"],
};

export default nextConfig;
