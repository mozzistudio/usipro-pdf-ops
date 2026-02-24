/** Raw Webflow webhook payload */
export interface WebflowWebhookPayload {
  name: string;
  siteId: string;
  formId: string;
  submittedAt: string;
  data: Record<string, string>;
}

/** A single part extracted from the form data */
export interface Part {
  index: number;
  id: string;
  material: string;
  quantity: string;
  processing: string;
  comment: string;
}

/** Parsed OF data after validation */
export interface OFData {
  ofNumber: string;
  /** All non-empty parts (ID1-ID7) — used for the Google Doc template */
  allParts: Part[];
  /** Parts with index 1-5 — used for file search on Dropbox */
  fileParts: Part[];
}

/** Dropbox folder paths for an OF */
export interface OFDropboxPaths {
  main: string;
  nm: string;
  dp: string;
}

/** Result of the pipeline execution */
export interface PipelineResult {
  ofNumber: string;
  dropboxLink: string;
  emailSent: boolean;
}
