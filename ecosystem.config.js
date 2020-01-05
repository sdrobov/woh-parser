module.exports = {
  apps: [
    {
      name: 'WoH Parser',
      script: './index.js',
      node_args: '--max-old-space-size=4096',
      max_memory_restart: '4G',
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
