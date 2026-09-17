/**
 * cv-portfolio module public interface.
 *
 * This barrel is the single public import surface for the CV Portfolio module.
 * Other modules must never deep-import internal paths.
 */

export type {
  CvVersion,
  CurrentCvChangedEvent,
} from "./domain/index.js";

export type {
  RegisterCvCandidateCommand,
  AcceptCvVersionCommand,
  ActivateCvVersionCommand,
  GetCurrentCvQuery,
  DownloadCurrentCvQuery,
  CvPortfolioService,
} from "./application/index.js";

export type {
  CvRepositoryPort,
  CvStoragePort,
} from "./ports/index.js";
