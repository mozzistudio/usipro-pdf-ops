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
  /** Dropbox path of the main OF folder (e.g. /RIJ/OF364575J) */
  mainPath: string;
}

/** Phase 1 response — returned after anonymization, before user validation */
export interface Phase1Response {
  status: 'pending_validation';
  sessionId: string;
  of: string;
  pdfs: Array<{ partId: string; originalBase64: string; anonymizedBase64: string }>;
  missingParts: string[];
}

/** Phase 2 request — sent after user validates all PDFs */
export interface FinalizeRequest {
  sessionId: string;
  validatedPdfs: Array<{ partId: string; pdfBase64: string }>;
}

/** Request body for /api/add-usipro-table */
export interface AddUsIproTableRequest {
  pdfBase64: string;
  planId: string;
  lotId: string;
  zone: {
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
  };
  cartoucheData?: {
    designation: string;
    material: string;
    applicableStd: string;
    finish: string;
  };
}
