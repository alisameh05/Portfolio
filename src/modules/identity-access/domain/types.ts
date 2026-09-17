import type { StableId } from "@shared/domain";

export type Role = "owner" | "visitor" | "system";

export type Permission =
  | "read:public"
  | "write:owner"
  | "admin:all"
  | "job:execute";

export interface OwnerIdentity {
  readonly ownerId: StableId<"Owner">;
  readonly githubUsername: string;
  readonly email: string;
}

export interface PseudonymousToken {
  readonly tokenString: string;
  readonly expiresAt: string;
  readonly purpose: "visitor_functional" | "visitor_measurement";
}
