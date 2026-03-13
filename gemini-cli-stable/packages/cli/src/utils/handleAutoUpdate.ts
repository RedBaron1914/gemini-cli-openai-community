/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { UpdateObject } from '../ui/utils/updateCheck.js';

/**
 * Handles the auto-update process for the CLI.
 * Permanently disabled.
 */
export function handleAutoUpdate(
  _info: UpdateObject | null,
  _settings: any,
  _projectRoot: string,
  _spawnFn?: any,
) {
  // HACK: Auto-update is intentionally disabled.
  return;
}

export function setUpdateHandler(_handler: any, _setUpdateInfo?: any) {
  // Stub: Do nothing
  return () => {};
}

export function waitForUpdateCompletion(_timeout?: number) {
  return Promise.resolve();
}

export function useUpdateEventEmitter() {
  return () => () => {};
}

// Stubs for testing compatibility
export function isUpdateInProgress() {
  return false;
}

export function _setUpdateStateForTesting(_state?: boolean) {
  // No-op
}
