// -----------------------------------------------------------------------------
// Entry point: SDK wiring only. Every handler is registered BEFORE connect(),
// and delegates to the NestApp (src/app.js).
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { NestApp } from './src/app.js';

const gladys = new GladysIntegration();
const app = new NestApp({ gladys });

// --- Discovery: re-read the devices and publish them all ---------------------
gladys.onScanRequest(() => app.refresh({ force: true }));

// --- Thermostat commands -------------------------------------------------------
gladys.onSetValue((device, feature, value) => {
  logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
  return app.setValue(device, feature, value);
});

// --- Camera picture, awaited under 15 s ---------------------------------------
gladys.onGetImage((device) => app.getImage(device));

// --- OAuth: the local and the automatic Connect buttons (acked under 5 s) ---
gladys.onOAuthAuthorizeUrl((key, redirectUri) => app.authorizeUrl(key, redirectUri));
gladys.onOAuthCallback((key, payload) => app.oauthCallback(key, payload));

// --- Configuration screen button ---------------------------------------------
gladys.onAction('test_connection', () => app.testConnection());
gladys.onAction('finish_local_connection', (fields) => app.finishLocalConnection(fields));

// --- Scene action ------------------------------------------------------------
gladys.onSceneAction('take_snapshot', (fields) => app.takeSnapshot(fields));

// --- Configuration changed by the user ---------------------------------------
gladys.onConfigUpdated((config) => {
  logger.info('Configuration updated: restarting');
  return app.start(config);
});

// --- Connection lifecycle ------------------------------------------------------
// Messages sent while disconnected are lost: re-read the config every time.
gladys.on('connected', async () => {
  try {
    await app.start(await gladys.getConfig());
  } catch (err) {
    logger.error('Start failed', err);
  }
});

gladys.on('disconnected', () => {
  app.stop().catch((err) => logger.error('Stop failed', err));
});

gladys.handleShutdown(() => app.stop());

logger.info('Starting the Google Nest integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
