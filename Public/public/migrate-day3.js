const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS plan VARCHAR(20) NOT NULL DEFAULT 'free';
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS click_events (
      id BIGSERIAL PRIMARY KEY,
      link_id INT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      clicked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      referrer TEXT,
      user_agent TEXT
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_click_events_link_time
    ON click_events(link_id, clicked_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider VARCHAR(30) NOT NULL DEFAULT 'stripe',
      provider_customer_id TEXT,
      provider_subscription_id TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'inactive',
      current_period_end TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_subscriptions_user_provider
    ON subscriptions(user_id, provider);
  `);

  console.log("Day-3 migration done.");
  await pool.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
