# Trigger email — pont Gmail → serveur

Un mail envoyé à `chiffrage@usi-pro.com` déclenche la phase 1 du pipeline
(recherche Dropbox + anonymisation), exactement comme une soumission du
formulaire web. Un opérateur valide ensuite sur l'écran habituel : **un mail ne
peut jamais finaliser un OF tout seul.**

## Pourquoi un script et pas un webhook

Google Workspace ne pousse pas de webhook sur l'arrivée d'un mail. Les services
qui le font (Cloudflare Email Routing, SendGrid Inbound Parse, Mailgun) exigent
tous un domaine racine dédié dont on contrôle les MX — impossible ici sans
migrer le DNS de `usi-pro.com`, qui porte le site Webflow et la messagerie de
toute la boîte. Le script interroge donc la boîte toutes les minutes.

Conséquence assumée : **latence d'environ une minute**, contre quelques secondes
pour un vrai webhook.

## 1. Créer l'alias (console d'administration Google)

Admin → Annuaire → Utilisateurs → *l'utilisateur porteur* →
**Informations sur l'utilisateur → Adresses e-mail alternatives** → ajouter
`chiffrage@usi-pro.com`.

Un alias ne consomme **pas** de licence. Inutile de créer un compte.

Deux contraintes sur le choix de l'utilisateur :

- **Ce doit être le compte depuis lequel le script sera installé.** Apps Script
  s'exécute au nom de son propriétaire et ne lit que la boîte de celui-ci.
- **Le trigger disparaît avec le compte.** Préférer un compte durable ; si la
  personne quitte l'entreprise et que son compte est supprimé, alias et script
  partent avec.

> Compter jusqu'à 24 h de propagation, en pratique quelques minutes.

## 1 bis. Sortir ces mails de sa boîte de réception

Un alias n'a pas de boîte propre : sans filtre, les demandes de chiffrage
atterrissent dans la boîte de réception de l'utilisateur porteur.

Sur son compte, Gmail → Paramètres → **Filtres et adresses bloquées** →
Créer un filtre :

- **Destinataire** : `chiffrage@usi-pro.com`
- Actions : **Ignorer la boîte de réception (archiver)** + **Appliquer le
  libellé** `chiffrage`

Le script voit toujours ces mails : `GmailApp.search()` couvre l'ensemble du
courrier, archivé compris.

> **Ne jamais** ajouter « Supprimer » ni « Marquer comme spam » à ce filtre :
> la corbeille et le spam sont exclus de la recherche, et le trigger cesserait
> de se déclencher.

## 2. Variables d'environnement du serveur

Le trigger a besoin de **deux** variables côté serveur :

| Variable | Rôle |
|---|---|
| `EMAIL_TRIGGER_SECRET` | Secret partagé avec le script (étape 3) |
| `ANTHROPIC_API_KEY` | Extraction de l'OF et des pièces depuis le texte du mail |

Sans la seconde, l'endpoint répond `503` et aucun mail n'est traité.

## 3. Générer le secret partagé

```bash
openssl rand -hex 32
```

À reporter des deux côtés :
- serveur : `EMAIL_TRIGGER_SECRET=<valeur>` dans `.env`
- script : propriété `TRIGGER_SECRET`

Sans ce secret, l'endpoint répond `503` et reste inerte — il n'y a pas de mode
« ouvert ».

## 4. Installer le script

1. [script.google.com](https://script.google.com) → **Nouveau projet**, connecté
   avec le compte qui porte l'alias.
2. Coller [`Code.gs`](Code.gs).
3. **Paramètres du projet → Propriétés du script** :

   | Propriété | Valeur |
   |---|---|
   | `WEBHOOK_URL` | `https://<serveur>/api/email-trigger` |
   | `TRIGGER_SECRET` | le secret de l’étape 3 |
   | `TRIGGER_ADDRESS` | `chiffrage@usi-pro.com` |

4. Exécuter **`setup()`** une fois, et accepter les autorisations Gmail
   demandées. Le script crée les libellés et le déclencheur minute.

## Comment lire l'état

Chaque fil traité reçoit un libellé, qui sert aussi de mémoire au script :

| Libellé | Signification |
|---|---|
| `chiffrage/traite` | Phase 1 lancée, session ouverte côté serveur |
| `chiffrage/ignore` | Le serveur n'a vu aucune demande de chiffrage (`422`) |
| `chiffrage/erreur` | 5 échecs serveur consécutifs, ou secret rejeté |

Un `503` — serveur joignable mais mal configuré, par exemple `ANTHROPIC_API_KEY`
absente — ne compte pas dans ces 5 échecs. Le fil reste sans libellé et sera
rejoué une fois la configuration réparée, plutôt que d'être abandonné pour une
cause réparable.

Un fil sans libellé sera rejoué : rien n'est marqué avant la réponse du serveur,
donc un plantage du script ne perd pas de mail.

Journal d'exécution : dans l'éditeur Apps Script, onglet **Exécutions**.

## Rejeux et doublons

`UrlFetchApp` abandonne au bout d'une minute environ, alors qu'une phase 1 sur
un OF réel peut durer plus longtemps. Le script lit alors son propre timeout
comme une panne et renvoie le mail.

Pour que ce renvoi ne relance pas le pipeline, chaque requête porte le
`messageId` Gmail. Le serveur garde en mémoire les exécutions de l'heure
écoulée : un rejeu attend le résultat de l'exécution d'origine et le reçoit,
au lieu d'en démarrer une seconde.

> **Limite :** cette mémoire vit dans le processus. Un redémarrage du serveur,
> ou plusieurs instances derrière un répartiteur, peuvent laisser passer un
> doublon. Pour supprimer complètement le risque, il faudrait persister les
> `messageId` traités (Redis, base, ou le `sessionStore` s'il devient durable).

## Limites connues

- **Latence ~1 min**, liée au polling.
- **Pièces jointes ignorées.** La phase 1 va chercher les plans sur Dropbox à
  partir des références de pièces ; un PDF joint au mail n'est pas lu.
- **`newer_than:7d`** borne la recherche : un mail exhumé après une semaine
  d'indisponibilité du serveur ne sera pas rattrapé.
- Le `From` n'autorise rien. Il est falsifiable, et seul le secret partagé
  garde l'endpoint — mais **n'importe qui connaissant l'alias peut donc faire
  tourner la phase 1.** C'est sans effet de bord externe (lecture Dropbox et
  anonymisation en mémoire), et la validation humaine reste le garde-fou.
