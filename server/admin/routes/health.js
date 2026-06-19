'use strict';

const startTime = Date.now();

module.exports = async function healthRoutes(app) {
  app.get('/health', async () => ({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
  }));
};
