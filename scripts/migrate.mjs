// Applies db/schema.sql to DATABASE_URL. Idempotent. Run with `npm run db:migrate`.
import { readFileSync } from "node:fs";
import { Client } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Put it in .env.local.");
  process.exit(1);
}

const client = new Client({ connectionString: url });
await client.connect();
try {
  await client.query(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  const { rows } = await client.query("select table_name from information_schema.tables where table_schema = 'public' order by 1");
  console.log(`Applied schema.sql. Tables: ${rows.map((t) => t.table_name).join(", ")}`);
} finally {
  await client.end();
}
