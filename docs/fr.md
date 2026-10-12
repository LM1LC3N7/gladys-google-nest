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

## Le local d'abord : thermostats Matter

Le **Nest Thermostat (2020)** et le **Nest Learning Thermostat (4e
génération)** parlent Matter : appairez-les avec l'**intégration Matter de
Gladys**, entièrement en local, sans lier de compte Google, sans frais Device
Access et sans Internet ensuite. Dans l'application Google Home, ouvrez le
thermostat, **Paramètres → Applis et services Matter associés → Associer des
applis et services**, et saisissez le code d'appairage dans Gladys. Matter
donne l'essentiel (température, consigne, mode) ; Eco, ventilateur, humidité
et toutes les caméras demandent ce connecteur.

Les caméras, sonnettes et autres thermostats Nest n'ont aucune interface
locale : l'API cloud de Google est le seul moyen, ci-dessous.

## Installation

Google impose **votre propre** projet Device Access et **votre propre**
client OAuth Google Cloud : comptez 15 minutes, une seule fois. Rien ne passe
par Gladys Plus ni par un serveur de l'auteur : chaque Gladys parle à Google
avec les identifiants de son propriétaire.

### 1. S'inscrire à Device Access (5 $ US, une fois)

Ouvrez la [console Device Access](https://console.nest.google.com/device-access)
avec le compte Google **personnel** de vos appareils Nest, acceptez les
conditions et payez les 5 $ US uniques. Gardez cet onglet ouvert.

### 2. Créer un projet Google Cloud

1. Dans la [console Google Cloud](https://console.cloud.google.com/), créez un
   projet (par exemple « gladys-nest »), avec le même compte Google. Notez
   son **ID de projet** (minuscules, chiffres et tirets, du type
   `gladys-nest-123456`) : les événements en ont besoin.
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
   ajoutez l'adresse que Gladys affiche sous « Compte Google » sur l'écran
   Configuration de l'intégration (`https://my.gladysassistant.com/redirect/oauth`,
   ou l'adresse de votre Gladys si vous y choisissez l'option « instance »).
   Copiez l'**ID client** et le **code secret du client**.

### 3. Créer le projet Device Access

Dans la console Device Access, **Create project** : donnez un nom, collez
l'**ID client OAuth** de l'étape 2 et passez les événements pour l'instant
(l'étape 5 y revient). Copiez l'**ID du projet** affiché ensuite (un UUID du
type `32c4b0a1-…`, pas l'ID du projet Cloud).

### 4. Connecter Gladys

1. Installez l'intégration depuis le store, ouvrez son écran
   **Configuration**.
2. Renseignez l'**ID du projet Device Access**, l'**ID client OAuth** et le
   **code secret du client**. Enregistrez.
3. Cliquez sur **Connecter** sous « Compte Google ». Connectez-vous avec
   votre compte Google, cochez les maisons et appareils à partager, puis
   autorisez les **deux** accès (appareils, et événements via Pub/Sub). Le
   navigateur revient dans Gladys et l'état passe au vert.
4. Ouvrez **Découverte** et créez les appareils voulus.

**Connexion locale (avancée)** : pour ne passer par aucune page tierce, pas
même celle de Gladys, ajoutez plutôt `https://www.google.com` comme URI de
redirection autorisée (étape 2.4) et cliquez sur **Connecter** sous « Compte
Google (local) ». Google termine sur la page www.google.com : copiez
l'**adresse complète** depuis la barre d'adresse (elle contient `code=`),
collez-la dans l'action **Terminer la connexion** et lancez-la. Le code ne
sert qu'une fois, quelques minutes.

### 5. Activer les événements (facultatif)

Passez cette étape si vous ne voulez que les thermostats, rafraîchis toutes
les quelques minutes.

1. Renseignez l'**ID du projet Google Cloud** de l'étape 2 et enregistrez.
   L'intégration crée le sujet `projects/<projet>/topics/gladys-google-nest`
   dans votre projet, autorise Google à y publier et crée son propre
   abonnement. L'état affiche alors le nom du sujet.
2. Dans la console Device Access, ouvrez votre projet et **activez les
   événements** avec ce nom de sujet.
3. Dès le prochain appui de sonnette, mouvement ou changement de thermostat,
   les événements arrivent et l'indication de l'état disparaît.

**Avancé** : un sujet existant, sur lequel `sdm-publisher@googlegroups.com` a
le rôle Éditeur Pub/Sub, ou un abonnement existant
(`projects/…/subscriptions/…`) peut être donné à la place, dans « Sujet
Pub/Sub existant ».

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
vérifie l'abonnement Pub/Sub.

## Dépannage

- **« redirect_uri_mismatch »** : le client OAuth doit lister, comme URI de
  redirection autorisée, l'adresse affichée sous « Compte Google » (ou
  `https://www.google.com` pour la connexion locale), voir l'étape 2.4.
- **Déconnecté tous les 7 jours** : l'écran de consentement OAuth est encore
  en « Test » : publiez-le (étape 2.3), puis reconnectez-vous.
- **Connecté mais aucun appareil** : cliquez de nouveau sur **Connecter** et
  cochez vos appareils sur l'écran de partage de Google.
- **« L'API Cloud Pub/Sub n'est pas activée »** : étape 2.2, puis
  enregistrez de nouveau.
- **« Le compte Google ne peut pas gérer Pub/Sub »** : le compte connecté
  doit être propriétaire du projet Cloud (créez les deux avec le même
  compte), ou avoir le rôle Administrateur Pub/Sub dessus.
- **Aucun événement** : le sujet doit être saisi dans le projet Device Access
  (étape 5.2), et vous devez avoir autorisé l'accès Pub/Sub à la connexion.
  Les réglages de notification de l'application Google Home décident aussi
  des événements de caméra envoyés par Google.
- **« Too many commands »** : Google limite chaque appareil à quelques
  commandes par minute ; patientez une minute.

## Confidentialité

L'intégration parle directement à Google, avec vos propres identifiants :
aucun serveur de l'auteur, pas de Gladys Plus. Les jetons sont échangés et
stockés par votre Gladys seulement ; le code secret du client ne la quitte
jamais. Avec le bouton « Compte Google », le code d'autorisation transite par
la page de redirection de Gladys (une page statique qui ne conserve rien,
voir sa [source](https://github.com/GladysAssistant/my.gladysassistant.com))
ou, avec l'option « instance », par votre seule adresse ; ce code est
inutilisable sans votre code secret. Avec la connexion locale, le code passe
de la page de Google à Gladys par votre propre copier-coller, et aucun tiers
ne le voit.
