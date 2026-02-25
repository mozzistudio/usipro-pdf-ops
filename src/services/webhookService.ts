import { logger } from '../utils/logger';

const MAKE_WEBHOOK_URL =
  'https://hook.us1.make.com/30vy4pfukd8kwpo659hafhfqhcur8sz6';

export interface WebhookDoc {
  name: string;
  path_display: string;
  [key: string]: any;
}

/**
 * Send part IDs (comma-separated) to the Make.com webhook.
 * Returns the list of Dropbox document entries.
 */
export async function fetchDocsFromWebhook(
  ids: string[],
): Promise<WebhookDoc[]> {
  const idsString = ids.join(',');
  logger.info(
    { ids: idsString, url: MAKE_WEBHOOK_URL },
    'Calling Make webhook with part IDs',
  );

  const response = await fetch(MAKE_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: idsString }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Make webhook failed (${response.status}): ${text}`);
  }

  const data: any = await response.json();
  logger.info(
    { responseKeys: typeof data === 'object' && data !== null ? Object.keys(data) : typeof data },
    'Make webhook response received',
  );

  // Normalize response to an array of doc entries
  if (Array.isArray(data)) {
    return data;
  }
  if (data?.docs && Array.isArray(data.docs)) {
    return data.docs;
  }
  if (data?.files && Array.isArray(data.files)) {
    return data.files;
  }
  if (data?.entries && Array.isArray(data.entries)) {
    return data.entries;
  }

  // Single object → wrap in array
  if (typeof data === 'object' && data !== null) {
    return [data];
  }

  logger.warn({ data }, 'Unexpected webhook response format');
  return [];
}
