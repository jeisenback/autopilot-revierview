// pm2 ecosystem file — autopilot-riverview process management.
// See: GitHub issue #17
//
// Usage:
//   pm2 start ecosystem.config.cjs
//   pm2 save
//   pm2 startup          # then run the printed command as root/sudo
//
// Raspberry Pi prereqs (for better-sqlite3 native build):
//   sudo apt install python3 make g++
//   npm install

module.exports = {
  apps: [
    {
      name: 'autopilot-riverview',
      script: 'channels/webhook/index.mjs',

      // Restart policy
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '5s',
      restart_delay: 2000,

      // Logging
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,

      // Environment
      env: {
        NODE_ENV: 'production',
        GOOGLE_CALENDAR_ID: 'jeisenback@gmail.com',
        DEFAULT_TIMEZONE: 'America/New_York',
      },
    },
  ],
}
