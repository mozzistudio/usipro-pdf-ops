import { Router, Request, Response } from 'express';
import { config } from '../config';
import { WebflowWebhookPayload } from '../types';
import { parseWebhookData } from '../utils/helpers';
import { logger } from '../utils/logger';
import { runPipeline } from '../pipeline/ofPipeline';

export const webhookRouter = Router();

/**
 * POST /webhook/webflow
 *
 * Receives Webflow form submissions. Validates the formId, then processes
 * the OF pipeline in the background while responding 200 immediately
 * to avoid Webflow webhook timeouts.
 */
webhookRouter.post('/webhook/webflow', (req: Request, res: Response) => {
  const payload = req.body as WebflowWebhookPayload;

  // Validate formId
  if (!payload?.data || payload.formId !== config.webflowFormId) {
    logger.info(
      { formId: payload?.formId },
      'Ignoring webhook — formId does not match',
    );
    res.status(200).json({ status: 'ignored', reason: 'formId mismatch' });
    return;
  }

  // Parse the payload
  let ofData;
  try {
    ofData = parseWebhookData(payload);
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed to parse webhook payload');
    res.status(400).json({ status: 'error', message: err.message });
    return;
  }

  logger.info(
    {
      of: ofData.ofNumber,
      totalParts: ofData.allParts.length,
      fileParts: ofData.fileParts.length,
    },
    'Webhook received — starting pipeline in background',
  );

  // Respond immediately to prevent Webflow timeout
  res.status(200).json({ status: 'accepted', of: ofData.ofNumber });

  // Run pipeline in background
  runPipeline(ofData).catch(err => {
    logger.error(
      { of: ofData.ofNumber, err: err.message, stack: err.stack },
      'Pipeline failed',
    );
  });
});
