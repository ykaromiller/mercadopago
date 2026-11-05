/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    GCP_API_KEY: process.env.GCP_API_KEY,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
