// PM2 settings for running the ERP on a Linux server (see DEPLOY.md).
//   pm2 start ecosystem.config.js
module.exports = {
  apps: [{
    name: 'erp',
    script: 'server.js',
    cwd: __dirname,
    instances: 1,          // one process only: the database and sign-ins live in this process
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '600M',
    kill_timeout: 5000,    // let the database close cleanly on restart
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      HOST: '127.0.0.1',   // only Nginx (HTTPS) talks to the ERP
      TRUST_PROXY: '1',    // read the visitor's address from Nginx for sign-in protection
    },
  }],
};
