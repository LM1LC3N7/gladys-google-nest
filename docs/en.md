# Google Nest

**Unofficial connector, not affiliated with Google.** It brings your Google
Nest thermostats, cameras, doorbells and Nest Hub Max into Gladys through
Google's official **Smart Device Management API** (the Device Access
program). Google Nest is a trademark of Google LLC.

## What you get

| Device                         | In Gladys                                                                                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Thermostat                     | temperature, humidity, activity (heating / cooling / idle), mode (heat, cool, heat · cool, off), heating and cooling setpoints, Eco, fan timer |
| Camera, doorbell, Nest Hub Max | picture, motion, person, doorbell press                                                                                                        |
| Events (optional)              | instant thermostat updates, scene triggers "doorbell pressed", "motion detected", "person detected", "sound detected"                          |

The **"Take a Nest snapshot"** scene action refreshes a camera picture before
a "send a camera image" action.

**Camera pictures**: older cameras (Nest Cam IQ, Nest Cam Indoor/Outdoor on
the Nest app, Nest Hub Max, wired Nest Hello) stream over RTSP, so Gladys gets
a live picture on demand. Every newer camera and doorbell only streams over
WebRTC: Gladys shows the picture of its last event (motion, person, ring),
taken from the event's clip preview, and has no live picture.

**Not supported by Google's API**: Nest Protect, Nest x Yale, Nest
Temperature Sensors, Learning Thermostats 1st and 2nd gen (dropped by Google
on 2025-10-25), Google Workspace accounts.

## Local first: Matter thermostats

The **Nest Thermostat (2020)** and the **Nest Learning Thermostat (4th gen)**
speak Matter: pair them with the **Matter integration of Gladys**, entirely
local, with no Google account linking, no Device Access fee and no Internet
needed afterwards. In the Google Home app, open the thermostat, **Settings →
Linked Matter apps & services → Link apps & services**, and enter the pairing
code in Gladys. Matter gives the essentials (temperature, setpoint, mode); Eco,
fan, humidity and every camera need this connector.

Nest cameras, doorbells and the other thermostats have no local interface at
all: Google's cloud API is the only way, below.

## Setup

Google requires your **own** Device Access project and your **own** Google
Cloud OAuth client: allow 15 minutes, once. Nothing goes through Gladys Plus
nor through a server of the author: each Gladys talks to Google with its
owner's credentials.

### 1. Register for Device Access (US$5, once)

Open the [Device Access console](https://console.nest.google.com/device-access)
with the **personal** Google account of your Nest devices, accept the terms
and pay the one-time US$5 fee. Keep this tab open.

### 2. Create a Google Cloud project

1. In the [Google Cloud console](https://console.cloud.google.com/), create a
   project (for example "gladys-nest"), with the same Google account. Note
   its **project ID** (lowercase letters, digits and hyphens, such as
   `gladys-nest-123456`): the events need it.
2. **APIs & Services → Library**: enable the **Smart Device Management API**
   and the **Cloud Pub/Sub API**.
3. **APIs & Services → OAuth consent screen**: choose **External**, give an
   app name and your email, and add yourself as a test user. Then click
   **Publish app** so that the status reads **In production**. Without it,
   Google disconnects Gladys **every 7 days**. Google then shows an
   "unverified app" warning when you connect: expected for a personal
   project, click "Continue".
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   type **Web application**. Under **Authorized redirect URIs**, add the
   address Gladys shows under "Google account" on the Configuration screen
   of the integration (`https://my.gladysassistant.com/redirect/oauth`, or
   the address of your Gladys if you pick the instance option there). Copy
   the **client ID** and the **client secret**.

### 3. Create the Device Access project

In the Device Access console, **Create project**: give a name, paste the
**OAuth client ID** of step 2, and skip the events for now (step 5 comes
back to them). Copy the **project ID** shown afterwards (a UUID like
`32c4b0a1-…`, not the Cloud project ID).

### 4. Connect Gladys

1. Install the integration from the store, open its **Configuration** screen.
2. Fill in the **Device Access project ID**, the **OAuth client ID** and the
   **client secret**. Save.
3. Click **Connect** under "Google account". Sign in with your Google
   account, select the homes and the devices to share, then allow **both**
   permissions (devices, and events through Pub/Sub). The browser comes back
   to Gladys and the status turns green.
4. Open **Discovery** and create the devices you want.

**Local connection (advanced)**: to go through no third-party page at all,
not even the Gladys one, add `https://www.google.com` as an authorized
redirect URI instead (step 2.4) and click **Connect** under "Google account
(local)". Google ends on the www.google.com page: copy the **whole address**
from the address bar (it contains `code=`), paste it into the **Finish the
connection** action and run it. The code works once, for a few minutes.

### 5. Turn on the events (optional)

Skip this step if you only want the thermostats, refreshed every few minutes.

1. Fill in the **Google Cloud project ID** of step 2 and save. The
   integration creates the topic `projects/<project>/topics/gladys-google-nest`
   in your project, lets Google publish on it and creates its own
   subscription. The status now shows the topic name.
2. In the Device Access console, open your project and **enable the events**
   with that topic name.
3. From the next doorbell press, motion or thermostat change, the events
   flow and the hint of the status disappears.

**Advanced**: an existing topic, on which `sdm-publisher@googlegroups.com`
holds the Pub/Sub Publisher role, or an existing subscription
(`projects/…/subscriptions/…`) can be given instead, in "Existing Pub/Sub
topic".

## Options

- **Refresh the devices**: a full read of every device, on top of the events
  (every 5 minutes by default). Google allows 5 reads a minute.
- **Refresh the camera pictures**: periodic live pictures of the RTSP
  cameras. Off by default: pictures come with the events and on request.
  Each live picture costs two of the 10 commands a minute Google allows.
- **Fan run time**: how long the fan runs when turned on from Gladys.

The **Test the connection** button lists the devices Google shares, checks
the Pub/Sub subscription.

## Troubleshooting

- **"redirect_uri_mismatch"**: the OAuth client must list, as an authorized
  redirect URI, the address shown under "Google account" (or
  `https://www.google.com` for the local connection), see step 2.4.
- **Disconnected every 7 days**: the OAuth consent screen is still in
  "Testing": publish it (step 2.3), then connect again.
- **Connected but no device**: click **Connect** again and tick your devices
  on Google's sharing screen.
- **"The Cloud Pub/Sub API is not enabled"**: step 2.2, then save again.
- **"The Google account cannot manage Pub/Sub"**: the connected account must
  own the Cloud project (create both with the same account), or hold the
  Pub/Sub Admin role on it.
- **No events**: the topic must be entered in the Device Access project
  (step 5.2), and you must have allowed the Pub/Sub permission when
  connecting. The notification settings of the Google Home app also decide
  which camera events Google sends.
- **"Too many commands"**: Google limits each device to a few commands a
  minute; wait a minute.

## Privacy

The integration talks to Google directly, with your own credentials: no
server of the author, no Gladys Plus. The tokens are exchanged and stored by
your Gladys only; the client secret never leaves it. With the "Google
account" button, the authorization code transits through the Gladys redirect
page (a static page that stores nothing, see its
[source](https://github.com/GladysAssistant/my.gladysassistant.com)) or, with
the instance option, through your own address only; that code is useless
without your client secret. With the local connection, the code goes from
Google's page to Gladys by your own copy and paste, and no third party sees
it.
