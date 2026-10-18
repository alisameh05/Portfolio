/**
 * Portability and Operations ports are declared beside their consuming
 * application interfaces and re-exported by the module public barrel.
 * Provider adapters must implement only the ports needed by an accepted
 * vertical slice.
 */
export type {
  ModuleOwnedSnapshotReader,
  OperationsObservationPort,
  OwnerExportObjectReadPort,
  OwnerExportSnapshotReaders,
} from "../application/index.js";
