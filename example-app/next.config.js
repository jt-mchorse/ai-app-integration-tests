/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep the app router experiment-free for now; the point is to be the
  // minimum-viable Next.js app that exercises streaming, tool use, and
  // an error path — not a flag testbed.
  reactStrictMode: true,
};

export default nextConfig;
