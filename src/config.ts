import dotenv from 'dotenv';
dotenv.config();

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const config = {
  port: parseInt(optionalEnv('PORT', '3000'), 10),

  // Dropbox — supports either a long-lived token or OAuth2 refresh flow
  dropbox: {
    accessToken: process.env.DROPBOX_ACCESS_TOKEN || '',
    clientId: process.env.DROPBOX_CLIENT_ID || 'rp9ta3297qkrkoh',
    clientSecret: process.env.DROPBOX_CLIENT_SECRET || '',
    refreshToken: process.env.DROPBOX_REFRESH_TOKEN || '',
  },
} as const;
