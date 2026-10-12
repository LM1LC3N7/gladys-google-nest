# Google Nest

**Connecteur non officiel, sans lien avec Google.** Il amène vos thermostats,
caméras, sonnettes et Nest Hub Max Google Nest dans Gladys via l'**API
officielle Smart Device Management** de Google (programme Device Access).
Google Nest est une marque de Google LLC.

## Ce que vous obtenez

| Appareil                       | Dans Gladys                                                                                                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thermostat                     | température, humidité, activité (chauffe / refroidit / repos), mode (chauffage, climatisation, chauffage · climatisation, arrêt), consignes de chauffage et de climatisation, Eco, minuterie du ventilateur |
| Caméra, sonnette, Nest Hub Max | image, mouvement, personne, appui sur la sonnette                                                                                                                                                           |
| Événements (optionnels)        | mises à jour instantanées des thermostats, déclencheurs de scène « appui sur une sonnette », « mouvement détecté », « personne détectée », « son détecté »                                                  |

L'action de scène **« Prendre un instantané Nest »** rafraîchit l'image d'une
caméra avant une action « envoyer l'image d'une caméra ».

**Images des caméras** : les anciennes caméras (Nest Cam IQ, Nest Cam
Indoor/Outdoor sur l'application Nest, Nest Hub Max, Nest Hello filaire)
diffusent en RTSP, donc Gladys obtient une image en direct à la demande.
Toutes les caméras et sonnettes récentes ne diffusent qu'en WebRTC : Gladys
affiche l'image de leur dernier événement (mouvement, personne, sonnerie),
tirée de l'aperçu vidéo de l'événement, sans image en direct.

**Non pris en charge par l'API de Google** : Nest Protect, Nest x Yale,
capteurs de température Nest, Learning Thermostat 1re et 2e génération
(abandonnés par Google le 25/10/2025), comptes Google Workspace.

## Installation

Google impose **votre propre** projet Device Access et **votre propre**
client OAuth Google Cloud : comptez 20 minutes, une seule fois.

### 1. S'inscrire à Device Access (5 $ US, une fois)

Ouvrez la [console Device Access](https://console.nest.google.com/device-access)
avec le compte Google **personnel** de vos appareils Nest, acceptez les
conditions et payez les 5 $ US uniques. Gardez cet onglet ouvert.

### 2. Créer un projet Google Cloud

1. Dans la [console Google Cloud](https://console.cloud.google.com/), créez un
   projet (par exemple « gladys-nest »). Notez son **ID de projet**.
2. **API et services → Bibliothèque** : activez la **Smart Device Management
   API** et la **Cloud Pub/Sub API**.
3. **API et services → Écran de consentement OAuth** : choisissez
   **Externe**, donnez un nom d'application et votre e-mail, ajoutez-vous
   comme utilisateur test. Cliquez ensuite sur **Publier l'application** pour
   que l'état indique **En production**. Sinon, Google déconnecte Gladys
   **tous les 7 jours**. Google affiche alors un avertissement « application
   non validée » à la connexion : c'est normal pour un projet personnel,
   cliquez sur « Continuer ».
4. **API et services → Identifiants → Créer des identifiants → ID client
   OAuth**, type **Application Web**. Sous **URI de redirection autorisés**,
   ajoutez l'URI de redirection que Gladys affiche sous le bouton
   **Connecter**, en général `https://my.gladysassistant.com/redirect/oauth`.
   Copiez l'**ID client** et le **code secret du client**.

### 3. Créer le sujet Pub/Sub (pour les événements)

Passez cette étape si vous ne voulez que les thermostats, rafraîchis toutes
les quelques minutes.

1. Dans la console Cloud, **Pub/Sub → Sujets → Créer un sujet**, par exemple
   `nest-events`, sans abonnement par défaut. Son nom complet ressemble à
   `projects/gladys-nest/topics/nest-events`.
2. Ouvrez le sujet, **Autorisations → Ajouter un compte principal** :
   `sdm-publisher@googlegroups.com`, rôle **Pub/Sub Publisher** (son nom
   traduit dépend de la langue de la console). Google peut ainsi y publier vos
   événements Nest.

### 4. Créer le projet Device Access

Dans la console Device Access, **Create project** : donnez un nom, collez
l'**ID client OAuth** de l'étape 2 et activez les événements avec le **nom
complet du sujet** de l'étape 3. Copiez l'**ID du projet** affiché ensuite (un
UUID du type `32c4b0a1-…`, pas l'ID du projet Cloud).

### 5. Connecter Gladys

1. Installez l'intégration depuis le store, ouvrez son écran
   **Configuration**.
2. Renseignez l'**ID du projet Device Access**, l'**ID client OAuth**, le
   **code secret du client** et, pour les événements, le **sujet Pub/Sub**.
   Enregistrez.
3. Cliquez sur **Connecter** : connectez-vous avec votre compte Google,
   cochez les maisons et appareils à partager, puis autorisez les **deux**
   accès (appareils, et événements via Pub/Sub).
4. De retour dans Gladys, l'état passe au vert. Ouvrez **Découverte** et
   créez les appareils voulus.

L'intégration crée son propre abonnement Pub/Sub, `gladys-google-nest`, sur
votre sujet. Vous pouvez aussi donner un abonnement existant
(`projects/…/subscriptions/…`).

## Options

- **Rafraîchir les appareils** : une lecture complète de tous les appareils,
  en plus des événements (toutes les 5 minutes par défaut). Google autorise 5
  lectures par minute.
- **Rafraîchir les images des caméras** : images en direct périodiques des
  caméras RTSP. Désactivé par défaut : les images arrivent avec les
  événements et à la demande. Chaque image en direct coûte deux des 10
  commandes par minute autorisées par Google.
- **Durée de ventilation** : combien de temps le ventilateur tourne quand
  vous l'allumez depuis Gladys.

Le bouton **Tester la connexion** liste les appareils partagés par Google,
vérifie l'abonnement Pub/Sub et affiche l'URI de redirection utilisée.

## Dépannage

- **« redirect_uri_mismatch »** : l'URI de redirection déclarée dans le
  client OAuth doit être exactement celle affichée par Gladys (étape 2.4).
- **Déconnecté tous les 7 jours** : l'écran de consentement OAuth est encore
  en « Test » : publiez-le (étape 2.3), puis reconnectez-vous.
- **Connecté mais aucun appareil** : cliquez de nouveau sur **Connecter** et
  cochez vos appareils sur l'écran de partage de Google.
- **Aucun événement** : vérifiez l'autorisation d'éditeur du sujet (étape
  3.2), le sujet du projet Device Access (étape 4), et que vous avez autorisé
  l'accès Pub/Sub à la connexion. Les réglages de notification de
  l'application Google Home décident aussi des événements de caméra envoyés
  par Google.
- **« Too many commands »** : Google limite chaque appareil à quelques
  commandes par minute ; patientez une minute.

## Confidentialité

L'intégration parle directement à Google, avec vos propres identifiants.
L'auteur de l'intégration ne voit jamais vos appareils. À la connexion,
Google renvoie votre navigateur vers Gladys via la page statique
`my.gladysassistant.com`, qui ne transporte que le code d'autorisation
(inutile sans votre code secret, qui ne quitte jamais votre Gladys). Les
jetons sont stockés dans la configuration de l'intégration de votre Gladys.
