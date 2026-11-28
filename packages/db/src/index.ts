import postgres from "postgres"

export function connect(url: string) {
  return postgres(url, { max: 5, onnotice: () => {}, types: { bigint: postgres.BigInt } })
}

export type Sql = ReturnType<typeof connect>

/** The error class `Sql` throws for a server-side failure, so callers need no second `postgres` copy to test for it. */
export const PostgresError = postgres.PostgresError
export type PostgresError = InstanceType<typeof postgres.PostgresError>
export { migrate } from "./migrate"
