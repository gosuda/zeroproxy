import { createPortInitializedWorkerBootstrap } from "./common.mjs";
import { WorkerSourceKind } from "./source-kinds.mjs";

/** Installs the dedicated worklet-module transferred-MessagePort bootstrap. */
export function createWorkletModuleBootstrap(options = {}) {
  return createPortInitializedWorkerBootstrap({
    ...options,
    sourceKind: WorkerSourceKind.workletModule,
  });
}
