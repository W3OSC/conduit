/**
 * Lightweight setup entry point for the Conduit channel plugin.
 *
 * OpenClaw loads this module instead of the full entry point when:
 *  - The channel is disabled or unconfigured
 *  - Onboarding/setup flows need channel metadata without activating
 *    the full runtime (HTTP routes, agent session wiring, etc.)
 *
 * See: https://docs.openclaw.ai/plugins/sdk-setup#setup-entry
 */

import { defineSetupPluginEntry } from 'openclaw/plugin-sdk/channel-core';
import { conduitPlugin } from './src/channel.js';

export default defineSetupPluginEntry(conduitPlugin);
