// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (connection status, action results).
// Every text is a { en, fr } object: Gladys picks the user's language.
// -----------------------------------------------------------------------------

export const T = {
  missingCredentials: {
    en: 'Fill in the Device Access project ID, the client ID and the client secret, save, then connect your Google account.',
    fr: "Renseignez l'ID du projet Device Access, l'ID client et le code secret du client, enregistrez, puis connectez votre compte Google.",
  },
  notConnected: {
    en: 'Connect your Google account: "Connect" under "Google account" (or, for the local connection, "Connect" under "Google account (local)" then the "Finish the connection" action).',
    fr: "Connectez votre compte Google : « Connecter » sous « Compte Google » (ou, pour la connexion locale, « Connecter » sous « Compte Google (local) » puis l'action « Terminer la connexion »).",
  },
  localConnected: {
    en: 'Google account connected: the devices appear in Discovery in a few seconds.',
    fr: 'Compte Google connecté : les appareils apparaissent dans Découverte dans quelques secondes.',
  },
  localNoCode: {
    en: 'No authorization code found: paste the whole address of the google.com page Google opened at the end (it contains "code=").',
    fr: "Aucun code d'autorisation trouvé : collez l'adresse complète de la page google.com ouverte par Google à la fin (elle contient « code= »).",
  },
  localExpired: {
    en: 'This address belongs to an older or unknown authorization: click "Connect" under "Google account (local)" again, then paste the new address.',
    fr: 'Cette adresse correspond à une autorisation ancienne ou inconnue : cliquez de nouveau sur « Connecter » sous « Compte Google (local) », puis collez la nouvelle adresse.',
  },
  localRefused: (error) => ({
    en: `Google did not grant the access (${error}): click "Connect" under "Google account (local)" again and allow both permissions.`,
    fr: `Google n'a pas accordé l'accès (${error}) : cliquez de nouveau sur « Connecter » sous « Compte Google (local) » et autorisez les deux accès.`,
  }),
  localFailed: (message) => ({
    en: `Google refused the code: ${message}. A code works once and for a few minutes: click "Connect" under "Google account (local)" again. Check that https://www.google.com is an authorized redirect URI of your OAuth client.`,
    fr: `Google a refusé le code : ${message}. Un code ne sert qu'une fois et quelques minutes : cliquez de nouveau sur « Connecter » sous « Compte Google (local) ». Vérifiez que https://www.google.com est une URI de redirection autorisée de votre client OAuth.`,
  }),
  reconnect: {
    en: 'Google refused the access: connect your Google account again. If this happens every 7 days, publish your OAuth consent screen ("In production").',
    fr: "Google a refusé l'accès : reconnectez votre compte Google. Si cela arrive tous les 7 jours, publiez votre écran de consentement OAuth (« En production »).",
  },
  badClient: {
    en: 'Google refused the OAuth client ID or secret: check them, save, then connect again.',
    fr: "Google a refusé l'ID client ou le code secret OAuth : vérifiez-les, enregistrez, puis reconnectez-vous.",
  },
  googleError: (message) => ({
    en: `Google Nest is unreachable: ${message}`,
    fr: `Google Nest est injoignable : ${message}`,
  }),
  noDevices: {
    en: 'Connected, but Google shares no device: open the Nest permissions of your Device Access project and select your devices.',
    fr: 'Connecté, mais Google ne partage aucun appareil : ouvrez les autorisations Nest de votre projet Device Access et cochez vos appareils.',
  },
  noEvents: {
    en: 'Connected without real-time events: fill in your Google Cloud project ID (the integration creates the Pub/Sub topic) to receive the doorbell, motion and person events.',
    fr: "Connecté sans événements en temps réel : renseignez l'ID de votre projet Google Cloud (l'intégration crée le sujet Pub/Sub) pour recevoir les événements de sonnette, de mouvement et de personne.",
  },
  eventsPending: (topic) => ({
    en: `no event received yet: if you just set it up, enter the topic ${topic} in the Device Access console ("Enable events").`,
    fr: `aucun événement reçu pour l'instant : si vous venez de configurer, saisissez le sujet ${topic} dans la console Device Access (« Enable events »).`,
  }),
  badEventSource: {
    en: 'The Pub/Sub topic is invalid: expected projects/<project>/topics/<topic> (or …/subscriptions/<name>).',
    fr: 'Le sujet Pub/Sub est invalide : attendu projects/<projet>/topics/<sujet> (ou …/subscriptions/<nom>).',
  },
  badCloudProjectId: {
    en: 'The Google Cloud project ID is invalid: 6 to 30 lowercase letters, digits and hyphens, as shown in the Cloud console (not the project number nor its name).',
    fr: "L'ID du projet Google Cloud est invalide : 6 à 30 lettres minuscules, chiffres et tirets, tel qu'affiché dans la console Cloud (ni le numéro du projet ni son nom).",
  },
  pubsubApiDisabled: (project) => ({
    en: `Connected, but the Cloud Pub/Sub API is not enabled on the project ${project}: enable it in the Cloud console (APIs & Services > Library), then save again.`,
    fr: `Connecté, mais l'API Cloud Pub/Sub n'est pas activée sur le projet ${project} : activez-la dans la console Cloud (API et services > Bibliothèque), puis enregistrez de nouveau.`,
  }),
  pubsubForbidden: (project) => ({
    en: `Connected, but the Google account cannot manage Pub/Sub on the project ${project}: connect with the account that owns the Cloud project, or give this account the Pub/Sub Admin role on it.`,
    fr: `Connecté, mais le compte Google ne peut pas gérer Pub/Sub sur le projet ${project} : connectez le compte propriétaire du projet Cloud, ou donnez-lui le rôle Administrateur Pub/Sub sur ce projet.`,
  }),
  eventsFailed: (message) => ({
    en: `Connected, but the events cannot be read: ${message}`,
    fr: `Connecté, mais les événements ne peuvent pas être lus : ${message}`,
  }),
};

/** The text of the test_connection action, a { en, fr } object. */
export function connectionReport({ devices, events }) {
  const count = (n, en, fr) => ({
    en: `${n} ${en}${n > 1 ? 's' : ''}`,
    fr: `${n} ${fr}${n > 1 ? 's' : ''}`,
  });
  const parts = [
    count(devices.thermostats, 'thermostat', 'thermostat'),
    count(devices.cameras, 'camera', 'caméra'),
    count(devices.doorbells, 'doorbell', 'sonnette'),
  ];
  if (devices.displays) {
    parts.push(count(devices.displays, 'display', 'écran'));
  }
  const eventsText = {
    off: {
      en: 'events: off (no Google Cloud project ID nor Pub/Sub topic)',
      fr: 'événements : désactivés (ni ID de projet Google Cloud ni sujet Pub/Sub)',
    },
    ok: { en: 'events: OK', fr: 'événements : OK' },
    pending: { en: `events: ${events.text?.en}`, fr: `événements : ${events.text?.fr}` },
    error: { en: `events: ${events.text?.en}`, fr: `événements : ${events.text?.fr}` },
  }[events.status];
  return {
    en: `Google Nest OK: ${parts.map((p) => p.en).join(', ')}; ${eventsText.en}.`,
    fr: `Google Nest OK : ${parts.map((p) => p.fr).join(', ')} ; ${eventsText.fr}.`,
  };
}
