import { Router, Request, Response } from 'express';
import { FormPayload } from '../types';
import { parseFormPayload } from '../utils/helpers';
import { logger } from '../utils/logger';
import { runPipeline } from '../pipeline/ofPipeline';

export const apiRouter = Router();

/**
 * POST /api/submit
 *
 * Receives form submissions directly from the frontend.
 * Validates input, responds immediately, then processes the pipeline in background.
 */
apiRouter.post('/api/submit', (req: Request, res: Response) => {
  const payload = req.body as FormPayload;

  let ofData;
  try {
    ofData = parseFormPayload(payload);
  } catch (err: any) {
    logger.error({ err: err.message }, 'Invalid form submission');
    res.status(400).json({ status: 'error', message: err.message });
    return;
  }

  logger.info(
    { of: ofData.ofNumber, partCount: ofData.parts.length },
    'Form submitted — starting pipeline in background',
  );

  // Respond immediately to avoid frontend timeout
  res.status(200).json({ status: 'accepted', of: ofData.ofNumber });

  // Run pipeline in background
  runPipeline(ofData).catch(err => {
    logger.error(
      { of: ofData.ofNumber, err: err.message, stack: err.stack },
      'Pipeline failed',
    );
  });
});
