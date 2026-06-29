/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { UpdateObject } from '../ui/utils/updateCheck.js';

/** @internal */
export function _setUpdateStateForTesting(value: boolean) {
  // No-op
}

export function isUpdateInProgress() {
  return false;
}

export async function waitForUpdateCompletion(
  timeoutMs = 30000,
): Promise<void> {
  return Promise.resolve();
}

export function handleAutoUpdate(
  info: UpdateObject | null,
  settings: any,
  projectRoot: string,
  spawnFn: any = null,
) {
  // HACK: Auto-update is intentionally disabled.
  return;
}

export function setUpdateHandler(
  addItem: any,
  setUpdateInfo: any,
) {
  // Stub
  return () => {};
}
