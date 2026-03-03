/**
 * PM2 Ecosystem Configuration — Production Ready
 * 
 * Usage:
 *   Development: pm2 start ecosystem.config.js --env development
 *   Production:  pm2 start ecosystem.config.js --env production
 * 
 * Commands:
 *   pm2 list              - View running processes
 *   pm2 logs mecfinder    - View logs
 *   pm2 monit             - Real-time monitoring
 *   pm2 reload mecfinder  - Zero-downtime reload
 *   pm2 stop mecfinder    - Stop application
 *   pm2 delete mecfinder  - Remove from PM2
 */

module.exports = {
  apps: [{
    name: 'mecfinder',
    script: 'index.js',
    
    // Clustering - use all available CPU cores
    instances: 'max',          // Or set specific number: 4
    exec_mode: 'cluster',
    
    // Auto-restart settings
    watch: false,              // Don't watch files in production
    max_memory_restart: '500M', // Restart if memory exceeds 500MB
    autorestart: true,
    
    // Graceful shutdown
    kill_timeout: 30000,       // 30 seconds to shutdown gracefully
    wait_ready: true,          // Wait for process.send('ready')
    listen_timeout: 10000,     // 10 seconds to become ready
    
    // Exponential backoff restart
    exp_backoff_restart_delay: 100,
    max_restarts: 10,
    min_uptime: '10s',
    
    // Logs
    log_file: './logs/combined.log',
    out_file: './logs/out.log',
    error_file: './logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    
    // Environment variables (defaults)
    env: {
      NODE_ENV: 'development',
      PORT: 3000,
    },
    
    // Production environment
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
    
    // Staging environment
    env_staging: {
      NODE_ENV: 'staging',
      PORT: 3000,
    },
  }],
  
  // Deployment configuration (optional - for PM2 deploy)
  deploy: {
    production: {
      user: 'deploy',
      host: ['your-production-server.com'],
      ref: 'origin/main',
      repo: 'git@github.com:ay9334524-ux/mecfinder_backend.git',
      path: '/var/www/mecfinder',
      'pre-deploy-local': '',
      'post-deploy': 'npm install && pm2 reload ecosystem.config.js --env production',
      'pre-setup': '',
    },
  },
};
