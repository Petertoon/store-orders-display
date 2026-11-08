// PM2: keeps the agent running and restarts it after a reboot.
//   pm2 start ecosystem.config.js && pm2 save && pm2 startup   (then run the command pm2 prints)
module.exports = {
  apps: [{
    name: 'store-print-agent',
    script: 'agent.js',
    cwd: __dirname,
    restart_delay: 5000,
    max_restarts: 1000,
    env: { NODE_ENV: 'production' },
  }],
};
