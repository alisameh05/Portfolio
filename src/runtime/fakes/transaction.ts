/**
 * Test-only transaction fake retained from Phase 2.
 *
 * It passes one opaque context to the callback but provides no atomicity and
 * no rollback of side effects. An explicit rollback outcome is returned to
 * the caller solely so application behavior can be unit-tested.
 */
import {
  isTransactionRollback,
  requestTransactionRollback,
  type TransactionContext,
  type TransactionRollback,
  type TransactionRunner,
} from "../ports.js";

const CONTEXT: TransactionContext = Object.freeze({ kind: "transaction" });

export function createPhase2TransactionFake(): TransactionRunner {
  return {
    async run<T>(
      callback: (
        context: TransactionContext,
      ) => Promise<T | TransactionRollback<T>> | T | TransactionRollback<T>,
    ): Promise<T> {
      const result = await callback(CONTEXT);
      return isTransactionRollback(result) ? result.value : result;
    },
  };
}

export { requestTransactionRollback };
