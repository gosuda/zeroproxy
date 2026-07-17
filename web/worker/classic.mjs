import { createPortInitializedWorkerBootstrap } from "./common.mjs";
import { WorkerSourceKind } from "./source-kinds.mjs";

/**
 * Installs the classic Worker port-gated bootstrap. No target source or
 * runtime configuration is accepted by this factory; both arrive only through
 * the transferred MessagePort protocol defined in `WorkerBootstrapProtocol`.
 */
export function createClassicWorkerBootstrap(options = {}) {
  return createPortInitializedWorkerBootstrap({
    ...options,
    sourceKind: WorkerSourceKind.workerClassic,
  });
}
