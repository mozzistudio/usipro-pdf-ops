/**
 * Le dossier ouvert, d'un écran à l'autre.
 *
 * Les trois écrans du chiffrage — Analyse, Revue, Paramétrage — sont trois
 * pages distinctes. Sans mémoire, changer d'onglet rouvrait le premier devis
 * de la liste : le technicien perdait son dossier à chaque aller-retour, et
 * devait le retrouver dans le sélecteur.
 *
 * L'identifiant vit donc à deux endroits, pour deux raisons : dans l'adresse,
 * pour qu'un onglet reste partageable et qu'un rechargement rouvre le même
 * devis ; dans la session, pour que les écrans sans sélecteur — Paramétrage —
 * sachent où renvoyer en repartant.
 */
(function () {
  'use strict';

  const KEY = 'usipro.dossier';

  /** Les écrans entre lesquels le dossier suit. */
  const SCREENS = ['/chiffrage.html', '/analyse.html', '/parametrage.html'];

  /** L'ancre de l'adresse, découpée : #devis/article. */
  function anchor() {
    return decodeURIComponent(location.hash.replace('#', '')).split('/');
  }

  function stored() {
    try {
      return sessionStorage.getItem(KEY) || '';
    } catch (_) {
      return '';   // navigation privée : l'adresse suffit
    }
  }

  /** Le devis à rouvrir : celui de l'adresse, sinon le dernier ouvert. */
  function open() {
    const parts = anchor();
    const id = parts[0] || stored();
    const index = Number(parts[1]);
    return { id, index: Number.isInteger(index) && index >= 0 ? index : null };
  }

  /**
   * Retenir le devis affiché — et l'article, quand l'écran en désigne un.
   *
   * L'adresse est réécrite sans entrée d'historique : passer d'un article au
   * suivant n'est pas une navigation, et empiler trente retours en arrière
   * pour trente articles rendrait le bouton « précédent » inutilisable.
   */
  function remember(id, index) {
    if (!id) return;
    try {
      sessionStorage.setItem(KEY, id);
    } catch (_) { /* rien à faire : l'adresse porte déjà l'information */ }

    const hash = '#' + encodeURIComponent(id) +
      (Number.isInteger(index) ? '/' + index : '');
    if (location.hash !== hash) history.replaceState(null, '', location.pathname + location.search + hash);
    carry();
  }

  /**
   * Recoller le dossier sur les liens qui mènent aux autres écrans.
   *
   * Tous les liens, pas ceux qu'on aurait pensé à marquer : un onglet oublié
   * est exactement le bug que ce fichier existe pour fermer.
   */
  function carry() {
    const id = open().id;
    if (!id) return;
    for (const link of document.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href');
      const path = href.split('#')[0];
      if (!SCREENS.includes(path)) continue;
      link.setAttribute('href', path + '#' + encodeURIComponent(id));
    }
  }

  window.Dossier = { open, remember, carry };
})();
