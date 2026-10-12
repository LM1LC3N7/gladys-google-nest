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

## Setup

Google requires your **own** Device Access project and your **own** Google
Cloud OAuth client: allow 20 minutes, once.

### 1. Register for Device Access (US$5, once)

Open the [Device Access console](https://console.nest.google.com/device-access)
with the **personal** Google account of your Nest devices, accept the terms
and pay the one-time US$5 fee. Keep this tab open.

### 2. Create a Google Cloud project

1. In the [Google Cloud console](https://console.cloud.google.com/), create a
   project (for example "gladys-nest"). Note its **project ID**.
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
   redirect URI Gladys shows under the **Connect** button, usually
   `https://my.gladysassistant.com/redirect/oauth`. Copy the **client ID**
   and the **client secret**.

### 3. Create the Pub/Sub topic (for the events)

Skip this step if you only want the thermostats, refreshed every few minutes.

1. In the Cloud console, **Pub/Sub → Topics → Create topic**, for example
   `nest-events`, without a default subscription. Its full name looks like
   `projects/gladys-nest/topics/nest-events`.
2. Open the topic, **Permissions → Add principal**:
   `sdm-publisher@googlegroups.com`, role **Pub/Sub Publisher**. This lets
   Google publish your Nest events there.

### 4. Create the Device Access project

In the Device Access console, **Create project**: give a name, paste the
**OAuth client ID** of step 2, and enable events with the **full topic name**
of step 3. Copy the **project ID** shown afterwards (a UUID like
`32c4b0a1-…`, not the Cloud project ID).

### 5. Connect Gladys

1. Install the integration from the store, open its **Configuration** screen.
2. Fill in the **Device Access project ID**, the **OAuth client ID**, the
   **client secret** and, for the events, the **Pub/Sub topic**. Save.
3. Click **Connect**: sign in with your Google account, select the homes and
   the devices to share, then allow **both** permissions (devices, and
   events through Pub/Sub).
4. Back in Gladys, the status turns green. Open **Discovery** and create the
   devices you want.

The integration creates its own Pub/Sub subscription, `gladys-google-nest`,
on your topic. You can give an existing subscription instead
(`projects/…/subscriptions/…`).

## Options

- **Refresh the devices**: a full read of every device, on top of the events
  (every 5 minutes by default). Google allows 5 reads a minute.
- **Refresh the camera pictures**: periodic live pictures of the RTSP
  cameras. Off by default: pictures come with the events and on request.
  Each live picture costs two of the 10 commands a minute Google allows.
- **Fan run time**: how long the fan runs when turned on from Gladys.

The **Test the connection** button lists the devices Google shares, checks
the Pub/Sub subscription and shows the redirect URI in use.

## Troubleshooting

- **"redirect_uri_mismatch"**: the redirect URI declared in the OAuth client
  must be exactly the one Gladys shows (step 2.4).
- **Disconnected every 7 days**: the OAuth consent screen is still in
  "Testing": publish it (step 2.3), then connect again.
- **Connected but no device**: click **Connect** again and tick your devices
  on Google's sharing screen.
- **No events**: check the publisher permission of the topic (step 3.2), the
  topic of the Device Access project (step 4), and that you allowed the
  Pub/Sub permission when connecting. The notification settings of the
  Google Home app also decide which camera events Google sends.
- **"Too many commands"**: Google limits each device to a few commands a
  minute; wait a minute.

## Privacy

The integration talks to Google directly, with your own credentials. Your
devices are never seen by the integration author. When you connect, Google
redirects your browser to Gladys through the static page
`my.gladysassistant.com`, which carries the authorization code only (useless
without your client secret, which never leaves your Gladys). Tokens are
stored in the integration configuration of your Gladys.
