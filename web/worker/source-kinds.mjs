export const WorkerSourceKind = Object.freeze({
  workerClassic: "ClassicWorker",
  workerModule: "ModuleWorker",
  sharedWorkerClassic: "SharedClassicWorker",
  sharedWorkerModule: "SharedModuleWorker",
  workletModule: "WorkletModule",
});

const nativeReflectApply = Reflect.apply;
const nativeSetHas = Set.prototype.has;

const sourceKinds = new Set(Object.values(WorkerSourceKind));
const moduleSourceKinds = new Set([
  WorkerSourceKind.workerModule,
  WorkerSourceKind.sharedWorkerModule,
  WorkerSourceKind.workletModule,
]);

export function isWorkerSourceKind(value) {
  return typeof value === "string" && nativeReflectApply(nativeSetHas, sourceKinds, [value]);
}

export function isModuleWorkerSourceKind(value) {
  return typeof value === "string" && nativeReflectApply(nativeSetHas, moduleSourceKinds, [value]);
}
