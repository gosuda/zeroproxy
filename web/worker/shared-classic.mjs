import { createPortInitializedWorkerBootstrap } from "./common.mjs";
import { WorkerSourceKind } from "./source-kinds.mjs";

/** Installs the classic SharedWorker transferred-MessagePort bootstrap. */
export function createSharedWorkerClassicBootstrap(options = {}) {
  return createPortInitializedWorkerBootstrap({
    ...options,
    sourceKind: WorkerSourceKind.sharedWorkerClassic,
  });
}
