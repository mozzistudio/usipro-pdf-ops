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

// Les pièces jointes ne voyagent plus dans le corps de la requête: la
// plateforme le refuse au-dela de 4,5 Mo, et un package de plans le depasse
// sans effort. Elles sont deposees directement dans le stockage, et le POST ne
// porte que leurs chemins. Ces bornes ne sont donc plus la limite d'une
// requete, mais ce qu'on accepte de traiter.
var MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
var MAX_TOTAL_BYTES = 60 * 1024 * 1024;

/**
 * Rejoue les mails déjà traités.
 *
 * Placée en tête volontairement: l'éditeur Apps Script vise la première
 * fonction du fichier quand on clique sur Exécuter, et c'est celle-ci qu'on
 * veut sous la main le jour où le serveur a été corrigé.
 *
 * À lancer après une correction: un mail perdu sur un bug n'a aucune raison
 * de l'être définitivement, et le redemander au client n'est pas une option.
 * L'état « vu » est effacé, le prochain passage reprend la boîte depuis le
 * début. Les demandes déjà enregistrées sont mises à jour, pas dupliquées:
 * le serveur les range par référence.
 */
function rejouer() {
  var props = PropertiesService.getScriptProperties();
  var keys = Object.keys(props.getProperties());
  var n = 0;

  keys.forEach(function (key) {
    if (key.indexOf('seen:') === 0 || key.indexOf('attempts:') === 0) {
      props.deleteProperty(key);
      n++;
    }
  });

  Logger.log('Etat efface pour ' + n + ' entree(s). Lancez pollInbox, ou attendez la minute.');
  return n;
}

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
          attachments: collectAttachments(message, url, secret),
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

    if (code === 413) {
      // Le corps reste trop gros malgre le depot: reessayer n'y changera rien.
      // On classe en erreur tout de suite plutot que de bruler cinq essais.
      markSeen(props, message);
      thread.addLabel(errored);
      Logger.log('Corps refuse (413) — ' + message.getSubject());
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
 * Les pièces jointes d'un message, déposées dans le stockage.
 *
 * Le contenu ne transite plus par le corps de la requête: le serveur délivre
 * une URL de dépôt par fichier, on y pousse les octets, et le POST ne porte
 * que les chemins. C'est ce qui permet à un package de plans de 30 Mo
 * d'arriver, là où il se faisait refuser en 413 puis abandonner au bout de
 * cinq essais.
 *
 * Plus aucune liste blanche à l'entrée: un .dwg ou un .sldprt qu'on ne sait
 * pas lire part quand même, parce que l'opérateur, lui, sait l'ouvrir. Un
 * fichier écarté part aussi, avec son nom et la raison.
 *
 * Les images inline sont exclues: ce sont les logos des signatures.
 */
function collectAttachments(message, url, secret) {
  var files = message.getAttachments({ includeInlineImages: false, includeAttachments: true });
  if (files.length === 0) return [];

  var budget = MAX_TOTAL_BYTES;
  var out = [];
  var toUpload = [];

  files.forEach(function (file) {
    var size = file.getSize();
    var entry = {
      name: file.getName(),
      contentType: file.getContentType(),
      size: size,
      contentBase64: null,
      storagePath: null,
      skipped: null,
    };

    if (size > MAX_ATTACHMENT_BYTES) {
      entry.skipped = 'trop volumineux (' + Math.round(size / 1024 / 1024) + ' Mo)';
    } else if (size > budget) {
      entry.skipped = 'budget du mail atteint, fichier non transmis';
    } else {
      budget -= size;
      toUpload.push({ file: file, entry: entry });
    }
    out.push(entry);
  });

  if (toUpload.length === 0) return out;

  var slots;
  try {
    var resp = UrlFetchApp.fetch(url.replace(/\/api\/email-trigger$/, '/api/email-trigger/uploads'), {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-trigger-secret': secret },
      payload: JSON.stringify({
        messageId: message.getId(),
        files: toUpload.map(function (t) { return t.entry.name; }),
      }),
      muteHttpExceptions: true,
    });
    if (resp.getResponseCode() !== 200) throw new Error('HTTP ' + resp.getResponseCode());
    slots = JSON.parse(resp.getContentText()).uploads || [];
  } catch (err) {
    // Sans depot possible on ne perd pas le mail: les fichiers partent sans
    // contenu, et l'operateur voit au moins qu'ils existent.
    Logger.log('Depot indisponible: ' + err);
    toUpload.forEach(function (t) { t.entry.skipped = 'depot indisponible'; });
    return out;
  }

  toUpload.forEach(function (t, i) {
    var slot = slots[i];
    if (!slot) { t.entry.skipped = 'aucune URL de depot'; return; }
    try {
      var put = UrlFetchApp.fetch(slot.url, {
        method: 'put',
        contentType: t.entry.contentType || 'application/octet-stream',
        payload: t.file.getBytes(),
        muteHttpExceptions: true,
      });
      if (put.getResponseCode() >= 300) throw new Error('HTTP ' + put.getResponseCode());
      t.entry.storagePath = slot.path;
    } catch (err) {
      Logger.log('Depot echoue pour ' + t.entry.name + ': ' + err);
      t.entry.skipped = 'depot echoue';
    }
  });

  return out;
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
