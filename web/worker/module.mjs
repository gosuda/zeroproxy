import { createPortInitializedWorkerBootstrap } from "./common.mjs";
import { WorkerSourceKind } from "./source-kinds.mjs";

/** Installs the module Worker transferred-MessagePort bootstrap. */
export function createModuleWorkerBootstrap(options = {}) {
  return createPortInitializedWorkerBootstrap({
    ...options,
    sourceKind: WorkerSourceKind.workerModule,
  });
}
