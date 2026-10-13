/**
 * cv-portfolio module public interface.
 *
 * This barrel is the single public import surface for the CV Portfolio module.
 * Other modules must never deep-import internal paths.
 */

export type {
  CvVersion,
  CurrentCvDisposition,
  CurrentCvChangedEvent,
} from "./domain/index.js";

export type {
  RegisterCvCandidateCommand,
  AcceptCvVersionCommand,
  ActivateCvVersionCommand,
  GetCurrentCvQuery,
  DownloadCurrentCvQuery,
  CvPortfolioService,
  LegacyCvPortfolioService,
} from "./application/index.js";
export { createOwnerCvApplicationService, createCurrentCvDeliveryService } from "./application/index.js";
export type {
  AcceptCvPortfolioVersionInput,
  ActivateCvPortfolioVersionInput,
  CvPortfolioRepositoryPort,
  GetCurrentCvMediaUsageInput,
  RegisterCvPortfolioVersionInput,
} from "./application/index.js";
export type { CurrentCvSnapshotRepositoryPort, CurrentCvObjectDeliveryPort, CurrentCvDeliveryService } from "./application/index.js";
export { createPostgresCvPortfolioRepository, createPostgresCurrentCvSnapshotRepository } from "./adapters/index.js";

export type {
  GetOwnerCvPortfolioQuery,
  RegisterOwnerCvVersionApplicationCommand,
  AcceptOwnerCvVersionApplicationCommand,
  ActivateOwnerCvVersionApplicationCommand,
  GetCurrentCvMediaUsageQuery,
  OwnerCvVersionView,
  OwnerCvActivationView,
  OwnerCvPortfolioView,
  RegisterOwnerCvVersionReceipt,
  OwnerCvCommandReceipt,
  OwnerCvApplicationService,
  CvPortfolioRootView,
  CurrentCvDownloadQuery,
  CurrentCvDelivery,
  CurrentCvSnapshot,
  CvPortfolioApplicationService,
} from "./application/index.js";

export type {
  CvRepositoryPort,
  CvStoragePort,
  CvCurrentDeliveryPort,
} from "./ports/index.js";
