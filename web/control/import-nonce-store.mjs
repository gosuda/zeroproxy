import { COORDINATOR_DB_NAME, openCoordinatorDatabase } from "./coordinator-database.mjs";

const STORE = "v1_import_nonces";

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), {once:true});
    request.addEventListener("error", () => reject(request.error), {once:true});
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", resolve, {once:true});
    transaction.addEventListener("abort", () => reject(transaction.error), {once:true});
    transaction.addEventListener("error", () => reject(transaction.error), {once:true});
  });
}

export async function openImportNonceStore(indexedDBFactory = indexedDB) {
  const database = await openCoordinatorDatabase(COORDINATOR_DB_NAME, indexedDBFactory);
  return Object.freeze({
    async reserve(nonce) {
      const tx = database.transaction(STORE, "readwrite", {durability:"strict"});
      const store = tx.objectStore(STORE);
      const existing = await requestResult(store.get(nonce));
      if (existing) { tx.abort(); return false; }
      store.add({nonce, state:"pending", updated_at:Date.now()});
      await transactionDone(tx);
      return true;
    },
    async commit(nonce) {
      const tx = database.transaction(STORE, "readwrite", {durability:"strict"});
      const store = tx.objectStore(STORE);
      const existing = await requestResult(store.get(nonce));
      if (!existing || existing.state !== "pending") { tx.abort(); throw new DOMException("Nonce reservation lost", "InvalidStateError"); }
      store.put({nonce, state:"consumed", updated_at:Date.now()});
      await transactionDone(tx);
    },
    async release(nonce) {
      const tx = database.transaction(STORE, "readwrite", {durability:"strict"});
      const store = tx.objectStore(STORE);
      const existing = await requestResult(store.get(nonce));
      if (existing?.state === "pending") store.delete(nonce);
      await transactionDone(tx);
    },
    close() { database.close(); }
  });
}
