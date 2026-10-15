import type { Result, Rejection, StableId } from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import type { ContactChannelType, SupportedLocale } from "../domain/index.js";

/** Narrow, transaction-bound public facts used to validate consented observations. */
export interface MeasurementConfigurationPublicFactsPort {
  hasPublicContactChannel(input: {
    readonly portfolioId: StableId<"Portfolio">;
    readonly channel: Extract<ContactChannelType, "linkedin" | "whatsapp" | "instagram" | "phone">;
    readonly locale: SupportedLocale;
  }, transaction: TransactionContext): Promise<Result<boolean, Rejection>>;
  /** Only an available destination can be opened; the configured fallback is display text. */
  hasAvailableGlobalProjectCta(input: {
    readonly portfolioId: StableId<"Portfolio">;
  }, transaction: TransactionContext): Promise<Result<boolean, Rejection>>;
}
