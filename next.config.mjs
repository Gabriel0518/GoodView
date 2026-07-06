/** @type {import('next').NextConfig} */
const nextConfig = {
  // pg 走 Node 运行时，别打进 bundle（避免动态 require 报错）
  experimental: {
    serverComponentsExternalPackages: ["pg"],
  },
};
export default nextConfig;
