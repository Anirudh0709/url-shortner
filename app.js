const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const path = require("path");
require("dotenv").config();

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const FREE_PLAN_MONTHLY_LIMIT = Number(process.env.FREE_PLAN_MONTHLY_LIMIT || 50);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "Public", "public")));

function isValidHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function makeCode() {
  return crypto.randomBytes(4).toString("base64url").slice(0, 6);
}

async function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const q = await pool.query(
      "SELECT id, email, plan FROM users WHERE id = $1",
      [payload.id]
    );
    if (!q.rows.length) return res.status(401).json({ error: "User not found" });

    req.user = q.rows[0];
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

app.post("/api/auth/signup", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: "Email and password(6+) required" });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const q = await pool.query(
      "INSERT INTO users (email, password_hash, plan) VALUES ($1, $2, 'free') RETURNING id, email, plan",
      [email.toLowerCase().trim(), hash]
    );
    const user = q.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: "7d" });
    return res.json({ token, user });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Email already exists" });
    console.error("signup error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });

  try {
    const q = await pool.query(
      "SELECT id, email, password_hash, plan FROM users WHERE email = $1",
      [email.toLowerCase().trim()]
    );
    if (!q.rows.length) return res.status(401).json({ error: "Invalid credentials" });

    const user = q.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: "7d" });
    return res.json({ token, user: { id: user.id, email: user.email, plan: user.plan } });
  } catch (err) {
    console.error("login error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/me", auth, async (req, res) => {
  try {
    const usage = await pool.query(
      `SELECT COUNT(*)::int AS used
       FROM links
       WHERE user_id = $1
         AND created_at >= date_trunc('month', NOW())
         AND created_at < (date_trunc('month', NOW()) + interval '1 month')`,
      [req.user.id]
    );

    return res.json({
      id: req.user.id,
      email: req.user.email,
      plan: req.user.plan,
      monthlyLimit: req.user.plan === "free" ? FREE_PLAN_MONTHLY_LIMIT : null,
      monthlyUsed: usage.rows[0].used
    });
  } catch (err) {
    console.error("me error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/analytics/summary", auth, async (req, res) => {
  try {
    const totals = await pool.query(
      `SELECT COUNT(*)::int AS total_links, COALESCE(SUM(click_count), 0)::int AS total_clicks
       FROM links
       WHERE user_id = $1`,
      [req.user.id]
    );

    const top = await pool.query(
      `SELECT short_code, original_url, click_count
       FROM links
       WHERE user_id = $1
       ORDER BY click_count DESC, id DESC
       LIMIT 1`,
      [req.user.id]
    );

    const daily = await pool.query(
      `SELECT DATE(ce.clicked_at) AS day, COUNT(*)::int AS clicks
       FROM click_events ce
       JOIN links l ON l.id = ce.link_id
       WHERE l.user_id = $1
         AND ce.clicked_at >= NOW() - interval '14 day'
       GROUP BY DATE(ce.clicked_at)
       ORDER BY day ASC`,
      [req.user.id]
    );

    return res.json({
      totalLinks: totals.rows[0].total_links,
      totalClicks: totals.rows[0].total_clicks,
      topLink: top.rows[0] || null,
      dailyClicks: daily.rows
    });
  } catch (err) {
    console.error("analytics error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/shorten", auth, async (req, res) => {
  const { url } = req.body || {};
  if (!url || !isValidHttpUrl(url)) {
    return res.status(400).json({ error: "Please enter a valid http/https URL." });
  }

  try {
    if (req.user.plan === "free") {
      const usage = await pool.query(
        `SELECT COUNT(*)::int AS used
         FROM links
         WHERE user_id = $1
           AND created_at >= date_trunc('month', NOW())
           AND created_at < (date_trunc('month', NOW()) + interval '1 month')`,
        [req.user.id]
      );

      if (usage.rows[0].used >= FREE_PLAN_MONTHLY_LIMIT) {
        return res.status(403).json({
          error: `Free plan limit reached (${FREE_PLAN_MONTHLY_LIMIT}/month). Upgrade to Pro.`
        });
      }
    }

    for (let i = 0; i < 5; i++) {
      const code = makeCode();
      try {
        await pool.query(
          "INSERT INTO links (short_code, original_url, user_id) VALUES ($1, $2, $3)",
          [code, url, req.user.id]
        );
        return res.json({
          shortUrl: `${process.env.BASE_URL}/${code}`,
          shortCode: code,
          originalUrl: url
        });
      } catch (err) {
        if (err.code !== "23505") throw err;
      }
    }

    return res.status(500).json({ error: "Could not generate unique code." });
  } catch (err) {
    console.error("shorten error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/links", auth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, short_code, original_url, click_count, created_at FROM links WHERE user_id = $1 ORDER BY id DESC LIMIT 20",
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("links error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/billing/mock-upgrade", auth, async (req, res) => {
  const { plan } = req.body || {};
  if (!plan || !["free", "pro", "business"].includes(plan)) {
    return res.status(400).json({ error: "plan must be free/pro/business" });
  }

  try {
    await pool.query("UPDATE users SET plan = $1 WHERE id = $2", [plan, req.user.id]);
    return res.json({ ok: true, plan });
  } catch (err) {
    console.error("billing mock error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

app.get("/:code", async (req, res) => {
  const { code } = req.params;

  try {
    const result = await pool.query(
      "SELECT id, original_url FROM links WHERE short_code = $1",
      [code]
    );

    if (!result.rows.length) return res.status(404).send("Short link not found.");

    const link = result.rows[0];

    await pool.query("UPDATE links SET click_count = click_count + 1 WHERE id = $1", [link.id]);

    await pool.query(
      "INSERT INTO click_events (link_id, referrer, user_agent) VALUES ($1, $2, $3)",
      [link.id, req.get("referer") || null, req.get("user-agent") || null]
    );

    return res.redirect(302, link.original_url);
  } catch (err) {
    console.error("redirect error:", err.message);
    return res.status(500).send("Server error");
  }
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
