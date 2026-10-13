const { neon } = require("@neondatabase/serverless");

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  const connectionString = process.env.POSTGRES_URL;

  if (!connectionString) {
    return res.status(503).json({
      ok: false,
      error: "Database connection is not configured"
    });
  }

  try {
    const sql = neon(connectionString);
    const result = await sql`SELECT 1 AS connected`;

    return res.status(200).json({
      ok: true,
      databaseConnected: result[0]?.connected === 1
    });
  } catch {
    return res.status(503).json({
      ok: false,
      error: "Database connection failed"
    });
  }
};
