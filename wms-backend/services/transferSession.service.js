
// services/transferSession.service.js

export async function getActiveTransferSession(client, userId) {
  const result = await client.query(`
    SELECT *
    FROM transfer_sessions
    WHERE user_id = $1
      AND status IN ('open','in_progress')
    ORDER BY started_at DESC
    LIMIT 1
  `, [userId]);

  if (result.rowCount === 0) {
    return null;
  }

  return result.rows[0];
}
