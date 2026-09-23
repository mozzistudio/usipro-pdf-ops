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

/**
 * What became of the free-text comment the client typed against a part.
 * Surfaced to the operator on the validation screen so feedback that could not
 * be applied is seen rather than buried in the server logs.
 */
export interface PartFeedback {
  /** The comment as the client typed it. */
  comment: string;
  /** Cartouche fields that were actually changed (may be empty). */
  applied: string[];
  /** Why part of the feedback could not be applied, or null if fully applied. */
  unhandled: string | null;
}

/** Phase 1 response — returned after anonymization, before user validation */
export interface Phase1Response {
  status: 'pending_validation';
  sessionId: string;
  of: string;
  pdfs: Array<{
    partId: string;
    originalBase64: string;
    anonymizedBase64: string;
    /** Detected cartouche format — scopes the operator retours on this plan. */
    format?: string;
    feedback?: PartFeedback;
  }>;
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

/** Une ligne d'une demande de chiffrage, telle que le mail la donne. */
export interface ChiffrageLine {
  /** Référence de la pièce ou du plan, quand le client en donne une. */
  reference: string;
  designation: string;
  material: string;
  /** Laissée en texte: « 10 », « 5 + option 20 », « selon PJ » sont tous des cas réels. */
  quantity: string;
  comment: string;
  /** Prix calculé par le moteur de coût, quand il a tourné sur cette ligne. */
  unitPrice?: number | null;
  totalPrice?: number | null;
  /** Le bordereau: chaque poste et sa base de calcul. */
  priceBreakdown?: { items: Array<{ label: string; amount: number; basis: string }>; assumptions: string[]; quantity: number } | null;
  /** Identifiant de la ligne — nécessaire pour la trancher une par une. */
  id?: string;
  /** Où en est la revue technique de cette ligne. */
  status?: 'a_traiter' | 'validee' | 'forcee' | 'manuelle' | 'rejetee';
  /** Prix imposé par le technicien. Le calcul reste au bordereau. */
  forcedPrice?: number | null;
  /** Consigne écrite par le technicien: corriger, ou expliquer. */
  reviewNote?: string | null;
  /** rouge: pas chiffrable · jaune: chiffré sous hypothèse · vert: rien à signaler. */
  alertLevel?: 'vert' | 'jaune' | 'rouge';
  alerts?: string[];
}

/**
 * Une demande de chiffrage reçue par mail.
 *
 * Pas de numéro d'OF : l'OF est une notion de fabrication, attribuée plus tard.
 * Ce qui identifie une demande, c'est sa propre référence — celle que le client
 * ou l'expéditeur lui donne.
 */
export interface ChiffrageRequest {
  reference: string;
  /** Donneur d'ordres, quand il est identifiable. */
  client: string;
  lines: ChiffrageLine[];
  /** Ce que l'extraction a compris, en une phrase, pour l'opérateur. */
  summary: string;
  /**
   * Vrai quand l'essentiel de la demande est dans les pièces jointes. La
   * demande est alors enregistrée avec ce qu'on sait, et le dit franchement
   * plutôt que de sortir une liste inventée.
   */
  detailsInAttachments: boolean;
  /** Liens WeTransfer, Drive, Dropbox… trouvés dans le mail, à ouvrir à la main. */
  links: string[];
}
