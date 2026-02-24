import path from 'path';
import express from 'express';
import { config } from './config';
import { logger } from './utils/logger';
import { apiRouter } from './routes/webhook';

const app = express();

// Parse JSON bodies
app.use(express.json({ limit: '10mb' }));

// Serve the frontend (public/ directory)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.use(apiRouter);

// Start server
app.listen(config.port, () => {
  logger.info({ port: config.port }, 'USI-PRO OF Automation server started');
});
