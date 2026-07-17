import { equalBinding, invalid, requireFunction, requireInteger, requireObject } from "./validation.mjs";
import { emptyTargetWorkerState, validateState } from "./model.mjs";

function journalReply(value, binding, targetOrigin) {
  const reply = requireObject(value, "journal reply");
  requireInteger(reply.revision, "journal revision", { min: 0 });
  validateState(reply.state, binding, targetOrigin);
  return reply;
}

export function createJournalPort(port, binding, targetOrigin) {
  const adapter = requireObject(port, "journal");
  const load = requireFunction(adapter.load, "journal.load").bind(adapter);
  const compareAndSwap = requireFunction(adapter.compareAndSwap, "journal.compareAndSwap").bind(adapter);
  return Object.freeze({
    async load() {
      const reply = journalReply(await load(Object.freeze({ v: 1, type: "TARGET_WORKER_JOURNAL_LOAD", binding })), binding, targetOrigin);
      return Object.freeze({ revision: reply.revision, state: reply.state });
    },
    async compareAndSwap(expectedRevision, state, operationID, operationBinding) {
      const reply = journalReply(await compareAndSwap(Object.freeze({
        v: 1,
        type: "TARGET_WORKER_JOURNAL_CAS",
        binding,
        expected_revision: expectedRevision,
        operation_id: operationID,
        operation_binding: operationBinding,
        state,
      })), binding, targetOrigin);
      if (typeof reply.applied !== "boolean") throw invalid("journal CAS result is invalid", "SecurityError");
      if (reply.applied && reply.revision <= expectedRevision) throw invalid("journal revision did not advance", "SecurityError");
      return Object.freeze({ applied: reply.applied, revision: reply.revision, state: reply.state });
    },
  });
}

export function initialJournalState(binding) {
  return emptyTargetWorkerState(binding);
}
