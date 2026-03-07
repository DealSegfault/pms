module.exports = {
    apps: [{
        name: 'pms-backend',
        script: 'server/index.js',
        node_args: '--max-old-space-size=384',
        env: {
            NODE_ENV: 'production',
            PORT: 3900,
        },
        max_memory_restart: '400M',
        restart_delay: 3000,
        max_restarts: 10,
        autorestart: true,
        watch: false,
        log_date_format: 'YYYY-MM-DD HH:mm:ss',
        error_file: '/root/.pm2/logs/pms-backend-error.log',
        out_file: '/root/.pm2/logs/pms-backend-out.log',
        merge_logs: true,
    }],
};
