import type { NextConfig } from 'next';

const nextConfig: NextConfig = process.env.ERP_DEPLOY_TARGET === 'aws'
  ? { output: 'standalone' }
  : {};

export default nextConfig;
