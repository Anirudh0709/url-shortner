const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS links (
      id SERIAL PRIMARY KEY,
      short_code VARCHAR(10) UNIQUE NOT NULL,
      original_url TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      click_count INT DEFAULT 0
    );
  `);

  console.log("Database ready.");
  await pool.end();
}

main().catch((err) => {
  console.error("DB init failed:", err.message);
  process.exit(1);
});
