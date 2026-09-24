import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger';
import {
  Machine,
  RateScope,
  Technique,
  addInstruction,
  decideRule,
  deleteMachine,
  deleteOperationRate,
  getParametrage,
  proposeRule,
  restoreVersion,
  retireInstruction,
  saveMachine,
  saveMaterial,
  saveOperationRate,
  saveSettings,
  saveTechnique,
  explain,
} from '../services/parametrageStore';
import { DEFAULT_SETTINGS, PricingSettings } from '../services/costEngine';

const RATE_SCOPES: RateScope[] = ['tournage', 'fraisage_3', 'fraisage_5', 'debit_tole', 'reglage', 'autre'];
const MACHINE_KINDS: Machine['kind'][] = ['fraisage', 'tournage', 'autre'];
const TECHNIQUE_STATUS: Technique['status'][] = ['interne', 'sous_traitee', 'non'];

/** Les paramètres du moteur sont tous des nombres positifs, sauf la devise. */
const NUMERIC_SETTINGS = Object.keys(DEFAULT_SETTINGS).filter(k => k !== 'currency') as Array<keyof PricingSettings>;

/**
 * Qui a fait le changement.
 *
 * L'atelier n'a pas de comptes : l'écran demande un nom et le passe tel quel.
 * Un historique sans auteur reste un historique — mieux vaut « v14, personne
 * n'a signé » qu'un faux nom inventé par le serveur.
 */
function readAuthor(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 60) : null;
}

/** Le texte d'une règle ou d'une consigne. Une ligne, pas une dissertation. */
const MAX_TEXT = 600;

function readText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  return text ? text.slice(0, MAX_TEXT) : null;
}

/**
 * Registers the parametrage endpoints — l'atelier tel qu'il est réglé.
 *
 * GET  /api/parametrage                      — tout ce que la page affiche
 * POST /api/parametrage/settings             — les paramètres du moteur
 * POST /api/parametrage/materials            — le tarif d'une nuance
 * POST /api/parametrage/rates                — un taux horaire par opération
 * POST /api/parametrage/rates/:id/delete     — retirer un taux
 * POST /api/parametrage/machines             — une machine du parc
 * POST /api/parametrage/machines/:id/delete  — retirer une machine
 * POST /api/parametrage/techniques           — interne, sous-traitée, ou non
 * POST /api/parametrage/instructions         — une consigne générale
 * POST /api/parametrage/instructions/:id/retire — la retirer des prompts
 * POST /api/parametrage/rules                — proposer une règle
 * POST /api/parametrage/rules/:id/decision   — valider, rejeter, retirer
 * POST /api/parametrage/versions/:v/restore  — revenir à une version
 *
 * Toutes les écritures rendent l'état complet : la page se redessine sur ce
 * que le serveur a réellement enregistré, jamais sur ce qu'elle espérait.
 */
export function registerParametrageEndpoints(router: Router): void {
  router.get('/api/parametrage', async (_req: Request, res: Response) => {
    try {
      res.json({ status: 'ok', ...(await getParametrage()) });
    } catch (err: any) {
      logger.error({ err: err.message }, 'Lecture du paramétrage impossible');
      res.status(503).json({ status: 'error', message: explain(err) });
    }
  });

  router.post('/api/parametrage/settings', async (req: Request, res: Response) => {
    const { author, ...patch } = req.body as Record<string, unknown>;

    const clean: Partial<PricingSettings> = {};
    for (const key of NUMERIC_SETTINGS) {
      if (patch[key] === undefined) continue;
      const value = Number(patch[key]);
      if (!Number.isFinite(value) || value < 0) {
        res.status(400).json({ status: 'error', message: `${key} doit être un nombre positif` });
        return;
      }
      (clean as any)[key] = value;
    }
    if (Object.keys(clean).length === 0) {
      res.status(400).json({ status: 'error', message: 'aucun paramètre à modifier' });
      return;
    }

    try {
      await saveSettings(clean, readAuthor(author));
      res.json({ status: 'ok', ...(await getParametrage()) });
    } catch (err: any) {
      logger.error({ err: err.message }, 'Paramètres du moteur non enregistrés');
      res.status(503).json({ status: 'error', message: explain(err) });
    }
  });

  router.post('/api/parametrage/materials', async (req: Request, res: Response) => {
    const { id, pricePerKg, density, label, aliases, author } = req.body as Record<string, any>;
    if (!id || !String(id).trim()) {
      res.status(400).json({ status: 'error', message: 'id de nuance requis' });
      return;
    }
    for (const [key, value] of [['pricePerKg', pricePerKg], ['density', density]] as const) {
      if (value === undefined) continue;
      if (!Number.isFinite(Number(value)) || Number(value) <= 0) {
        res.status(400).json({ status: 'error', message: `${key} doit être un nombre positif` });
        return;
      }
    }

    try {
      await saveMaterial(String(id).trim(), {
        pricePerKg: pricePerKg === undefined ? undefined : Number(pricePerKg),
        density: density === undefined ? undefined : Number(density),
        label,
        aliases,
      }, readAuthor(author));
      res.json({ status: 'ok', ...(await getParametrage()) });
    } catch (err: any) {
      logger.error({ err: err.message, id }, 'Tarif matière non enregistré');
      res.status(400).json({ status: 'error', message: explain(err) });
    }
  });

  router.post('/api/parametrage/rates', async (req: Request, res: Response) => {
    const { id, label, ratePerHour, appliesTo, position, author } = req.body as Record<string, any>;
    if (!id || !String(id).trim()) {
      res.status(400).json({ status: 'error', message: 'id du taux requis' });
      return;
    }
    if (ratePerHour !== undefined && (!Number.isFinite(Number(ratePerHour)) || Number(ratePerHour) <= 0)) {
      res.status(400).json({ status: 'error', message: 'ratePerHour doit être un nombre positif' });
      return;
    }
    if (appliesTo !== undefined && !RATE_SCOPES.includes(appliesTo)) {
      res.status(400).json({ status: 'error', message: `appliesTo doit être l'un de: ${RATE_SCOPES.join(', ')}` });
      return;
    }

    try {
      await saveOperationRate({
        id: String(id).trim(),
        label: label === undefined ? undefined : String(label).trim(),
        ratePerHour: ratePerHour === undefined ? undefined : Number(ratePerHour),
        appliesTo,
        position: position === undefined ? undefined : Number(position),
      }, readAuthor(author));
      res.json({ status: 'ok', ...(await getParametrage()) });
    } catch (err: any) {
      logger.error({ err: err.message, id }, 'Taux horaire non enregistré');
      res.status(400).json({ status: 'error', message: explain(err) });
    }
  });

  router.post('/api/parametrage/rates/:id/delete', async (req: Request, res: Response) => {
    try {
      await deleteOperationRate(String(req.params.id), readAuthor(req.body?.author));
      res.json({ status: 'ok', ...(await getParametrage()) });
    } catch (err: any) {
      logger.error({ err: err.message, id: req.params.id }, 'Taux horaire non supprimé');
      res.status(400).json({ status: 'error', message: explain(err) });
    }
  });

  router.post('/api/parametrage/machines', async (req: Request, res: Response) => {
    const body = req.body as Record<string, any>;
    if (!body.id || !String(body.id).trim()) {
      res.status(400).json({ status: 'error', message: 'id de machine requis' });
      return;
    }
    if (body.kind !== undefined && !MACHINE_KINDS.includes(body.kind)) {
      res.status(400).json({ status: 'error', message: `kind doit être l'un de: ${MACHINE_KINDS.join(', ')}` });
      return;
    }
    if (body.count !== undefined && (!Number.isInteger(Number(body.count)) || Number(body.count) < 1)) {
      res.status(400).json({ status: 'error', message: 'count doit être un entier positif' });
      return;
    }

    // Une capacité vide n'est pas zéro : c'est « non renseigné », et zéro
    // ferait recaler toutes les pièces contre une course inexistante.
    const capacity = (raw: unknown): number | null | undefined => {
      if (raw === undefined) return undefined;
      if (raw === null || raw === '') return null;
      const value = Number(raw);
      return Number.isFinite(value) && value > 0 ? value : null;
    };

    try {
      await saveMachine({
        id: String(body.id).trim(),
        label: body.label === undefined ? undefined : String(body.label).trim(),
        kind: body.kind,
        axes: capacity(body.axes),
        travelXMm: capacity(body.travelXMm),
        travelYMm: capacity(body.travelYMm),
        travelZMm: capacity(body.travelZMm),
        maxDiameterMm: capacity(body.maxDiameterMm),
        maxLengthMm: capacity(body.maxLengthMm),
        count: body.count === undefined ? undefined : Number(body.count),
        note: body.note === undefined ? undefined : (body.note ? String(body.note).slice(0, MAX_TEXT) : null),
        position: body.position === undefined ? undefined : Number(body.position),
      }, readAuthor(body.author));
      res.json({ status: 'ok', ...(await getParametrage()) });
    } catch (err: any) {
      logger.error({ err: err.message, id: body.id }, 'Machine non enregistrée');
      res.status(400).json({ status: 'error', message: explain(err) });
    }
  });

  router.post('/api/parametrage/machines/:id/delete', async (req: Request, res: Response) => {
    try {
      await deleteMachine(String(req.params.id), readAuthor(req.body?.author));
      res.json({ status: 'ok', ...(await getParametrage()) });
    } catch (err: any) {
      logger.error({ err: err.message, id: req.params.id }, 'Machine non retirée');
      res.status(400).json({ status: 'error', message: explain(err) });
    }
  });

  router.post('/api/parametrage/techniques', async (req: Request, res: Response) => {
    const { id, label, status, note, position, author } = req.body as Record<string, any>;
    if (!id || !String(id).trim()) {
      res.status(400).json({ status: 'error', message: 'id de technique requis' });
      return;
    }
    if (status !== undefined && !TECHNIQUE_STATUS.includes(status)) {
      res.status(400).json({ status: 'error', message: `status doit être l'un de: ${TECHNIQUE_STATUS.join(', ')}` });
      return;
    }

    try {
      await saveTechnique({
        id: String(id).trim(),
        label: label === undefined ? undefined : String(label).trim(),
        status,
        note: note === undefined ? undefined : (note ? String(note).slice(0, MAX_TEXT) : null),
        position: position === undefined ? undefined : Number(position),
      }, readAuthor(author));
      res.json({ status: 'ok', ...(await getParametrage()) });
    } catch (err: any) {
      logger.error({ err: err.message, id }, 'Technique non enregistrée');
      res.status(400).json({ status: 'error', message: explain(err) });
    }
  });

  router.post('/api/parametrage/instructions', async (req: Request, res: Response) => {
    const text = readText(req.body?.text);
    if (!text) {
      res.status(400).json({ status: 'error', message: 'une consigne vide ne consigne rien' });
      return;
    }

    try {
      await addInstruction(text, readAuthor(req.body?.author));
      res.json({ status: 'ok', ...(await getParametrage()) });
    } catch (err: any) {
      logger.error({ err: err.message }, 'Consigne non enregistrée');
      res.status(400).json({ status: 'error', message: explain(err) });
    }
  });

  router.post('/api/parametrage/instructions/:id/retire', async (req: Request, res: Response) => {
    try {
      await retireInstruction(String(req.params.id), readAuthor(req.body?.author));
      res.json({ status: 'ok', ...(await getParametrage()) });
    } catch (err: any) {
      logger.error({ err: err.message, id: req.params.id }, 'Consigne non retirée');
      res.status(400).json({ status: 'error', message: explain(err) });
    }
  });

  router.post('/api/parametrage/rules', async (req: Request, res: Response) => {
    const text = readText(req.body?.text);
    if (!text) {
      res.status(400).json({ status: 'error', message: 'une règle vide ne règle rien' });
      return;
    }
    const origin = req.body?.origin === 'revue' ? 'revue' : 'manuel';

    try {
      await proposeRule({
        text,
        origin,
        workId: req.body?.workId ? String(req.body.workId) : null,
        author: readAuthor(req.body?.author),
      });
      res.json({ status: 'ok', ...(await getParametrage()) });
    } catch (err: any) {
      logger.error({ err: err.message }, 'Règle non enregistrée');
      res.status(400).json({ status: 'error', message: explain(err) });
    }
  });

  router.post('/api/parametrage/rules/:id/decision', async (req: Request, res: Response) => {
    const decisions = ['valider', 'rejeter', 'retirer'];
    const decision = String(req.body?.decision ?? '');
    if (!decisions.includes(decision)) {
      res.status(400).json({ status: 'error', message: `decision doit être l'une de: ${decisions.join(', ')}` });
      return;
    }

    try {
      await decideRule(String(req.params.id), decision as any, readAuthor(req.body?.author));
      res.json({ status: 'ok', ...(await getParametrage()) });
    } catch (err: any) {
      logger.error({ err: err.message, id: req.params.id }, 'Décision sur la règle non enregistrée');
      res.status(400).json({ status: 'error', message: explain(err) });
    }
  });

  router.post('/api/parametrage/versions/:version/restore', async (req: Request, res: Response) => {
    const version = Number(req.params.version);
    if (!Number.isInteger(version) || version < 1) {
      res.status(400).json({ status: 'error', message: 'version invalide' });
      return;
    }

    try {
      res.json({ status: 'ok', ...(await restoreVersion(version, readAuthor(req.body?.author))) });
    } catch (err: any) {
      logger.error({ err: err.message, version }, 'Retour en arrière impossible');
      res.status(400).json({ status: 'error', message: explain(err) });
    }
  });
}
