import postgres from "postgres"

export function connect(url: string) {
  return postgres(url, { max: 5, onnotice: () => {}, types: { bigint: postgres.BigInt } })
}

export type Sql = ReturnType<typeof connect>
export { migrate } from "./migrate"
