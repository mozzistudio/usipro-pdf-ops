/**
 * Vérifie que l'API accepte la config Opus 5, que parseJsonResponse retrouve le
 * bloc texte derrière le bloc thinking, et que applyRefinementOverrides — la
 * fonction réellement utilisée en production — normalise bien le résultat.
 *   npx ts-node test/check-opus5.ts   (lit ANTHROPIC_API_KEY depuis .env)
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { CLAUDE_MODEL, THINKING, parseJsonResponse } from '../src/services/claudeModel';
import { applyRefinementOverrides } from '../src/services/pdfAnonymizer';

const FEEDBACK =
  "ce n'est pas de l'alu, c'est de l'inox 316L, et vous avez coupé le plan en bas";

(async () => {
  // 1. Forme de la requête + parsing du bloc texte derrière le thinking
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2048,
    thinking: THINKING,
    output_config: { effort: 'low' },
    system: 'Return ONLY valid JSON, no markdown fences.',
    messages: [{ role: 'user', content: `Feedback: "${FEEDBACK}". Renvoie {"overrides":{...},"unhandled":...}` }],
  });

  console.log('model        :', msg.model);
  console.log('stop_reason  :', msg.stop_reason);
  console.log('block types  :', msg.content.map(b => b.type).join(', '));
  console.log('raw parsed   :', JSON.stringify(parseJsonResponse(msg)));
  console.log('thinking tok :', (msg.usage as any).output_tokens_details?.thinking_tokens);

  // 2. Chemin de production complet (whitelist + traduction)
  const result = await applyRefinementOverrides(FEEDBACK, {
    designation: 'SUPPORT', material: 'ALUMINUM', applicableStd: '—', finish: '—',
  });
  console.log('\nPRODUCTION PATH');
  console.log('overrides    :', JSON.stringify(result.overrides));
  console.log('unhandled    :', result.unhandled);

  const m = result.overrides.material ?? '';
  console.log('\nmaterial en anglais :', /STAINLESS STEEL/i.test(m) ? 'OK' : `ECHEC ("${m}")`);
  console.log('champs inconnus     :', Object.keys(result.overrides).every(k =>
    ['designation', 'material', 'applicableStd', 'finish'].includes(k)) ? 'OK (aucun)' : 'ECHEC');
})().catch(e => { console.error('ECHEC:', e.message); process.exit(1); });
