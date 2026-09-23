import path from 'path';
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

  // Email trigger — shared secret between the Apps Script bridge and /api/email-trigger
  emailTrigger: {
    secret: process.env.EMAIL_TRIGGER_SECRET || '',
  },

  // Durable memory — operator retours, index of work done, deliverables.
  // Without these keys the stores fall back to the JSONL files below, which is
  // fine on a laptop and lossy on a host with an ephemeral filesystem.
  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },

  // Local fallback files, used only when Supabase is not configured.
  feedback: {
    path: process.env.FEEDBACK_STORE_PATH || path.join(process.cwd(), 'data', 'feedback.jsonl'),
  },
  works: {
    path: process.env.WORKS_STORE_PATH || path.join(process.cwd(), 'data', 'works.jsonl'),
  },
  analysis: {
    path: process.env.ANALYSIS_STORE_PATH || path.join(process.cwd(), 'data', 'analysis.jsonl'),
  },
} as const;
