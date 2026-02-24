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
 * Runs the pipeline and returns the Dropbox link as output.
 */
apiRouter.post('/api/submit', async (req: Request, res: Response) => {
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
    'Form submitted — running pipeline',
  );

  try {
    const result = await runPipeline(ofData);

    res.status(200).json({
      status: 'success',
      of: result.ofNumber,
      dropboxLink: result.dropboxLink,
      missingParts: result.missingParts,
    });
  } catch (err: any) {
    logger.error(
      { of: ofData.ofNumber, err: err.message, stack: err.stack },
      'Pipeline failed',
    );
    res.status(500).json({
      status: 'error',
      message: `Le traitement de l'OF ${ofData.ofNumber} a échoué: ${err.message}`,
    });
  }
});
