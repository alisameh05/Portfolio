import { parseStableId, type StableId } from "../src/shared/domain/index.js";

export interface OperationsSummaryCliOptions {
  readonly portfolioId: StableId<"Portfolio">;
}

/** Parse only the documented scope flag; never silently ignore operator input. */
export function parseOperationsSummaryArguments(
  args: readonly string[],
  environmentPortfolioId: string | undefined,
): OperationsSummaryCliOptions | null {
  if (args.length !== 2 || args[0] !== "--portfolio-id" || args[1] === undefined || args[1].length > 64) return null;
  const portfolioId = parseStableId("Portfolio", args[1]);
  if (!portfolioId.ok) return null;
  if (environmentPortfolioId !== undefined) {
    if (environmentPortfolioId.length > 64 || !parseStableId("Portfolio", environmentPortfolioId).ok ||
        environmentPortfolioId !== portfolioId.value) return null;
  }
  return { portfolioId: portfolioId.value };
}
