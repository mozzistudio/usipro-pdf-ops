/**
 * Pont Gmail → serveur USI-PRO.
 *
 * Surveille les mails reçus sur l'alias de chiffrage et les POSTe sur
 * /api/email-trigger. Remplace un service d'inbound email payant: Google
 * Workspace ne sait pas pousser un webhook, donc on interroge la boîte.
 *
 * Réglage dans Paramètres du projet → Propriétés du script:
 *   WEBHOOK_URL     https://<serveur>/api/email-trigger
 *   TRIGGER_SECRET  le même secret que EMAIL_TRIGGER_SECRET côté serveur
 *   TRIGGER_ADDRESS chiffrage@usi-pro.com
 *   TRIGGER_QUERY   (optionnel) requête Gmail à la place de 'to:<adresse>',
 *                   ex. label:chiffrage-a-traiter
 *
 * Puis exécuter setup() une fois.
 */

// Sans accent volontairement: la requête Gmail exclut ces libellés par leur
// nom, et une correspondance ratée sur un caractère accentué ferait retraiter
// chaque mail à chaque minute.
// Libellé d'entrée: ce qu'on pose à la main sur un mail pour le donner à
// traiter. Il rend le pont utilisable sur une boîte qui ne reçoit pas l'alias
// — on choisit les fils, au lieu de dépendre de l'adresse du destinataire.
var LABEL_INBOX = 'chiffrage/a-traiter';
var LABEL_DONE = 'chiffrage/traite';
var LABEL_SKIPPED = 'chiffrage/ignore';
var LABEL_ERROR = 'chiffrage/erreur';

/** Nombre d'échecs serveur tolérés avant d'abandonner un message. */
var MAX_ATTEMPTS = 5;

// Le contenu des pièces jointes part avec le mail: c'est là que sont les
// quantités et les matières dans la plupart des demandes réelles. Deux bornes,
// parce qu'un package de plans peut peser des dizaines de mégaoctets et que le
// serveur, lui, a une limite de corps de requête.
var MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024;
var MAX_TOTAL_BYTES = 18 * 1024 * 1024;

/** Formats dont le serveur sait tirer quelque chose. Le reste part en nom seul. */
var PARSABLE = /\.(xlsx|xlsm|xls|csv|tsv|pdf|stp|step|txt)$/i;

/**
 * À exécuter une fois à la main: crée les libellés et le déclencheur minute.
 * Idempotent — relancer ne crée pas de doublon.
 */
function setup() {
  [LABEL_INBOX, LABEL_DONE, LABEL_SKIPPED, LABEL_ERROR].forEach(function (name) {
    if (!GmailApp.getUserLabelByName(name)) {
      GmailApp.createLabel(name);
    }
  });

  var already = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'pollInbox';
  });
  if (!already) {
    ScriptApp.newTrigger('pollInbox').timeBased().everyMinutes(1).create();
  }

  var props = PropertiesService.getScriptProperties();
  ['WEBHOOK_URL', 'TRIGGER_SECRET', 'TRIGGER_ADDRESS'].forEach(function (key) {
    if (!props.getProperty(key)) {
      throw new Error('Propriété de script manquante: ' + key);
    }
  });

  Logger.log('Setup terminé — pollInbox tourne toutes les minutes.');
}

/**
 * Appelée par le déclencheur. Traite chaque message non encore étiqueté.
 *
 * Le libellé fait office d'état: un message traité, ignoré ou définitivement
 * en erreur porte un libellé et sort de la recherche. Rien n'est marqué avant
 * la réponse du serveur, donc un plantage du script rejoue le message au lieu
 * de le perdre.
 */
function pollInbox() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('WEBHOOK_URL');
  var secret = props.getProperty('TRIGGER_SECRET');
  var address = props.getProperty('TRIGGER_ADDRESS');

  if (!url || !secret || !address) {
    Logger.log('Configuration incomplète — exécuter setup().');
    return;
  }

  // La requête ne filtre plus sur les libellés. L'état est porté par le
  // MESSAGE, pas par la conversation: Gmail fusionne un transfert ou une
  // relance dans le fil d'origine, et un fil marqué traité aurait enterré pour
  // toujours les messages suivants — y compris la réponse du client.
  var custom = props.getProperty('TRIGGER_QUERY');
  var query = [custom || 'to:' + address].concat(custom ? [] : ['newer_than:7d']).join(' ');

  var threads = GmailApp.search(query, 0, 20);
  if (threads.length === 0) return;

  var done = GmailApp.getUserLabelByName(LABEL_DONE);
  var skipped = GmailApp.getUserLabelByName(LABEL_SKIPPED);
  var errored = GmailApp.getUserLabelByName(LABEL_ERROR);

  threads.forEach(function (thread) {
    var messages = thread.getMessages();
    var message = messages[messages.length - 1];

    // Un message déjà traité ne repasse pas: sinon chaque minute relancerait
    // une extraction Claude sur le même contenu. Les libellés restent posés
    // sur le fil pour l'oeil humain, mais ce n'est plus eux qui décident.
    if (props.getProperty(seenKey(message)) ) return;

    var response;
    try {
      response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-trigger-secret': secret },
        payload: JSON.stringify({
          // messageId permet au serveur de reconnaitre un rejeu: si ce script
          // a coupe sur timeout pendant que la phase 1 tournait encore, le
          // renvoi recupere le resultat au lieu de relancer le pipeline.
          messageId: message.getId(),
          from: message.getFrom(),
          subject: message.getSubject(),
          body: message.getPlainBody(),
          attachments: collectAttachments(message),
        }),
        muteHttpExceptions: true,
        followRedirects: false,
      });
    } catch (err) {
      Logger.log('Serveur injoignable pour "' + message.getSubject() + '": ' + err);
      countFailure(thread, message, errored);
      return;
    }

    var code = response.getResponseCode();

    if (code === 200) {
      markSeen(props, message);
      thread.addLabel(done);
      Logger.log('OK — ' + message.getSubject() + ' → ' + response.getContentText());
      return;
    }

    if (code === 422) {
      // Le serveur a lu le mail et n'y a pas vu de demande de chiffrage.
      // Ce n'est pas une panne: on classe et on passe.
      markSeen(props, message);
      thread.addLabel(skipped);
      Logger.log('Ignoré — ' + message.getSubject() + ' → ' + response.getContentText());
      return;
    }

    if (code === 503) {
      // Le serveur tourne mais lui manque une cle ou un reglage. C'est
      // temporaire et reparable: on n'incremente pas le compteur d'echecs,
      // sinon cinq minutes de mauvaise config suffiraient a abandonner une
      // vraie demande. Le mail reste en attente jusqu'a la remise en etat.
      Logger.log('Serveur non configure — ' + response.getContentText());
      return;
    }

    if (code === 401) {
      // Secret faux: réessayer ne servira à rien et logguer chaque minute
      // noierait le journal. On arrête net.
      markSeen(props, message);
      thread.addLabel(errored);
      Logger.log('Secret rejeté par le serveur — vérifier TRIGGER_SECRET.');
      return;
    }

    Logger.log('Échec ' + code + ' — ' + message.getSubject() + ' → ' + response.getContentText());
    countFailure(thread, message, errored);
  });
}

/**
 * Les pièces jointes d'un message, contenu compris quand il tient dans les
 * bornes. Un fichier écarté part quand même, avec son nom et la raison: savoir
 * qu'un plan existe mais n'a pas été lu vaut mieux que ne rien savoir.
 *
 * Les images inline sont exclues: ce sont les logos des signatures.
 */
function collectAttachments(message) {
  var budget = MAX_TOTAL_BYTES;
  var files = message.getAttachments({ includeInlineImages: false, includeAttachments: true });

  return files.map(function (file) {
    var name = file.getName();
    var size = file.getSize();
    var out = {
      name: name,
      contentType: file.getContentType(),
      size: size,
      contentBase64: null,
      skipped: null,
    };

    if (!PARSABLE.test(name)) {
      out.skipped = 'format non lu automatiquement';
      return out;
    }
    if (size > MAX_ATTACHMENT_BYTES) {
      out.skipped = 'trop volumineux (' + Math.round(size / 1024 / 1024) + ' Mo)';
      return out;
    }
    if (size > budget) {
      out.skipped = 'budget du mail atteint, fichier non transmis';
      return out;
    }

    budget -= size;
    out.contentBase64 = Utilities.base64Encode(file.getBytes());
    return out;
  });
}

/** Clé d'état d'un message. Stable: l'identifiant Gmail ne change pas. */
function seenKey(message) {
  return 'seen:' + message.getId();
}

/** Marque un message comme définitivement traité. */
function markSeen(props, message) {
  props.setProperty(seenKey(message), String(Date.now()));
}

/**
 * Compte les échecs d'un message et l'étiquette en erreur au-delà du seuil,
 * pour qu'un mail durablement cassé cesse d'être rejoué toutes les minutes.
 */
function countFailure(thread, message, errorLabel) {
  var props = PropertiesService.getScriptProperties();
  var key = 'attempts:' + message.getId();
  var attempts = Number(props.getProperty(key) || 0) + 1;

  if (attempts >= MAX_ATTEMPTS) {
    markSeen(props, message);
    thread.addLabel(errorLabel);
    props.deleteProperty(key);
    Logger.log('Abandon après ' + attempts + ' tentatives — ' + message.getSubject());
    return;
  }

  props.setProperty(key, String(attempts));
}
