import express from 'express';
import { config } from './config';
import { logger } from './utils/logger';
import { webhookRouter } from './routes/webhook';

const app = express();

// Parse JSON bodies (Webflow webhooks send JSON)
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Webhook routes
app.use(webhookRouter);

// Start server
app.listen(config.port, () => {
  logger.info({ port: config.port }, 'USI-PRO OF Automation server started');
});
