import { connect, migrate } from "./index"

const url = process.env.DATABASE_URL
if (!url) throw new Error("DATABASE_URL is not set")
const sql = connect(url)
const applied = await migrate(sql)
console.log(applied.length ? `applied ${applied.join(", ")}` : "schema up to date")
await sql.end()
