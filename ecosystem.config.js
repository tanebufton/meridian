module.exports = {
  apps: [
    {
      name: 'meridian-api',
      script: './server/api/index.js',
      env_file: '.env',
      instances: 1,
      autorestart: true,
      watch: false,
    },
    {
      name: 'meridian-admin',
      script: './server/admin/index.js',
      env_file: '.env',
      instances: 1,
      autorestart: true,
      watch: false,
    },
    {
      name: 'meridian-probe',
      script: './server/probe/index.js',
      env_file: '.env',
      instances: 1,
      autorestart: true,
      watch: false,
    },
  ],
};
