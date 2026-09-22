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
 *
 * Puis exécuter setup() une fois.
 */

// Sans accent volontairement: la requête Gmail exclut ces libellés par leur
// nom, et une correspondance ratée sur un caractère accentué ferait retraiter
// chaque mail à chaque minute.
var LABEL_DONE = 'chiffrage/traite';
var LABEL_SKIPPED = 'chiffrage/ignore';
var LABEL_ERROR = 'chiffrage/erreur';

/** Nombre d'échecs serveur tolérés avant d'abandonner un message. */
var MAX_ATTEMPTS = 5;

/**
 * À exécuter une fois à la main: crée les libellés et le déclencheur minute.
 * Idempotent — relancer ne crée pas de doublon.
 */
function setup() {
  [LABEL_DONE, LABEL_SKIPPED, LABEL_ERROR].forEach(function (name) {
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

  var query = [
    'to:' + address,
    '-label:' + LABEL_DONE.replace(/\//g, '-'),
    '-label:' + LABEL_SKIPPED.replace(/\//g, '-'),
    '-label:' + LABEL_ERROR.replace(/\//g, '-'),
    'newer_than:7d',
  ].join(' ');

  var threads = GmailApp.search(query, 0, 20);
  if (threads.length === 0) return;

  var done = GmailApp.getUserLabelByName(LABEL_DONE);
  var skipped = GmailApp.getUserLabelByName(LABEL_SKIPPED);
  var errored = GmailApp.getUserLabelByName(LABEL_ERROR);

  threads.forEach(function (thread) {
    // Deuxième garde-fou: on relit les libellés portés par le fil au lieu de
    // se fier à la seule exclusion dans la requête. Un mail déjà traité qui
    // repasserait ici relancerait un appel Claude et un scan Dropbox complet.
    var borne = thread.getLabels().some(function (l) {
      var n = l.getName();
      return n === LABEL_DONE || n === LABEL_SKIPPED || n === LABEL_ERROR;
    });
    if (borne) return;

    var messages = thread.getMessages();
    var message = messages[messages.length - 1];

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
      thread.addLabel(done);
      Logger.log('OK — ' + message.getSubject() + ' → ' + response.getContentText());
      return;
    }

    if (code === 422) {
      // Le serveur a lu le mail et n'y a pas vu de demande de chiffrage.
      // Ce n'est pas une panne: on classe et on passe.
      thread.addLabel(skipped);
      Logger.log('Ignoré — ' + message.getSubject() + ' → ' + response.getContentText());
      return;
    }

    if (code === 401) {
      // Secret faux: réessayer ne servira à rien et logguer chaque minute
      // noierait le journal. On arrête net.
      thread.addLabel(errored);
      Logger.log('Secret rejeté par le serveur — vérifier TRIGGER_SECRET.');
      return;
    }

    Logger.log('Échec ' + code + ' — ' + message.getSubject() + ' → ' + response.getContentText());
    countFailure(thread, message, errored);
  });
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
    thread.addLabel(errorLabel);
    props.deleteProperty(key);
    Logger.log('Abandon après ' + attempts + ' tentatives — ' + message.getSubject());
    return;
  }

  props.setProperty(key, String(attempts));
}
