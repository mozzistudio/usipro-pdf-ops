/** A single part from the form */
export interface Part {
  id: string;
  material: string;
  quantity: string;
  processing: string;
  comment: string;
}

/** Payload sent by the frontend form */
export interface FormPayload {
  of: string;
  parts: Part[];
}

/** Parsed OF data ready for the pipeline */
export interface OFData {
  ofNumber: string;
  parts: Part[];
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
  /** Part IDs whose source folder was not found on Dropbox */
  missingParts: string[];
  /** Base64-encoded ZIP containing the full OF folder contents */
  zipBase64: string;
}
