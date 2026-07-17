import { createPortInitializedWorkerBootstrap } from "./common.mjs";
import { WorkerSourceKind } from "./source-kinds.mjs";

/** Installs the module SharedWorker transferred-MessagePort bootstrap. */
export function createSharedWorkerModuleBootstrap(options = {}) {
  return createPortInitializedWorkerBootstrap({
    ...options,
    sourceKind: WorkerSourceKind.sharedWorkerModule,
  });
}
