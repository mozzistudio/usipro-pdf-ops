import dotenv from 'dotenv';
dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const config = {
  port: parseInt(optionalEnv('PORT', '3000'), 10),

  /** Expected Webflow formId — only this form triggers the pipeline */
  webflowFormId: '6972b387eef3d8354e99a8ee',

  // Dropbox — supports either a long-lived token or OAuth2 refresh flow
  dropbox: {
    accessToken: process.env.DROPBOX_ACCESS_TOKEN || '',
    clientId: process.env.DROPBOX_CLIENT_ID || 'rp9ta3297qkrkoh',
    clientSecret: process.env.DROPBOX_CLIENT_SECRET || '',
    refreshToken: process.env.DROPBOX_REFRESH_TOKEN || '',
  },

  // Google — supports either a service account key file or OAuth2
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN || '',
    serviceAccountKeyPath: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || '',
  },

  // CloudConvert (optional — used for ZIP creation if set)
  cloudConvertApiKey: process.env.CLOUDCONVERT_API_KEY || '',

  // Email
  emailFrom: optionalEnv('EMAIL_FROM', 'denys@mozzistudio.com'),
  emailRecipients: optionalEnv(
    'EMAIL_RECIPIENTS',
    'administratif@usi-pro.com,denys@mozzistudio.com',
  ).split(',').map(e => e.trim()),

  // Google Drive destination folder for generated docs
  googleDriveFolderId: '1FIstP-Q_ioBrFj9oqbd-LIYKG3VGD3Jf',

  // Google Doc template IDs indexed by part count (1-7)
  templateIds: {
    1: '1-G93m2yNlgNWaqAav4HUJyZrB82vWeut3fSfUpUEBMY',
    2: '1HYLokpGOfc9waslcienNTJhjMYXtSnwP9NCgTrqE3Yc',
    3: '1P6mrTnVgEzA6rPU4SzSGa1jSW3LjrVga6VfmzTithJU',
    4: '170IGtdf3rPNALNo7xkzsUZr0OsajzWmdDkLoUrbrO-o',
    5: '1e6bCNJVW7vI6c5S8qi4vku9jS5KUWF27hgLwJg4VUMU',
    6: '11qcwQ6tjrf2kkiF_WEr9fe1X0-aT1xxREIgv10jW5F4',
    7: '11I7sA__oCleWk8SlxKV7v5aPwrqT1VhxaV1FmCUHbhU',
  } as Record<number, string>,
} as const;
