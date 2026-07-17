import { clone, equalBinding, invalid, requireFunction, requireObject, requireString } from "./validation.mjs";

function reply(value, binding) {
  const result = requireObject(value, "coordinator journal reply");
  if (!Number.isSafeInteger(result.revision) || result.revision < 0 || !equalBinding(result.state?.binding, binding)) {
    throw invalid("coordinator journal reply is invalid", "SecurityError");
  }
  return result;
}

export function createCoordinatorJournalMirror({ binding, coordinatorCall, mirror } = {}) {
  const coordinator = requireFunction(coordinatorCall, "coordinatorCall");
  const storage = requireObject(mirror, "mirror");
  const write = requireFunction(storage.write, "mirror.write").bind(storage);
  const load = async () => {
    const result = reply(await coordinator("TARGET_WORKER_JOURNAL_LOAD", Object.freeze({ binding })), binding);
    await write(Object.freeze({ revision: result.revision, state: clone(result.state) }));
    return Object.freeze({ revision: result.revision, state: clone(result.state) });
  };
  return Object.freeze({
    load,
    async compareAndSwap(expectedRevision, state, operationID, operationBinding) {
      const result = reply(await coordinator("TARGET_WORKER_JOURNAL_CAS", Object.freeze({
        binding,
        expected_revision: expectedRevision,
        operation_binding: operationBinding,
        operation_id: requireString(operationID, "operationID", { max: 256 }),
        state,
      })), binding);
      if (typeof result.applied !== "boolean") throw invalid("coordinator journal CAS reply is invalid", "SecurityError");
      await write(Object.freeze({ revision: result.revision, state: clone(result.state) }));
      return Object.freeze({ applied: result.applied, revision: result.revision, state: clone(result.state) });
    },
  });
}
