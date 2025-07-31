const { v4: uuidv4 } = require('uuid');
const { getDatabase } = require('../database/init');

async function logAnalyticsEvent(userId, eventType, eventData = {}, ipAddress = null, userAgent = null) {
  try {
    const db = getDatabase();
    const eventId = uuidv4();

    await db.query(
      'INSERT INTO analytics_events (id, user_id, event_type, event_data, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5, $6)',
      [eventId, userId, eventType, JSON.stringify(eventData), ipAddress, userAgent]
    );

    console.log(`Analytics event logged: ${eventType} for user ${userId}`);
  } catch (error) {
    console.error('Failed to log analytics event:', error);
    // Don't throw error to avoid breaking the main flow
  }
}

async function getAnalyticsData(userId, eventType = null, days = 30) {
  try {
    const db = getDatabase();
    
    let query = `
      SELECT event_type, event_data, timestamp
      FROM analytics_events 
      WHERE user_id = $1 
      AND timestamp >= NOW() - INTERVAL '$2 days'
    `;
    const params = [userId, days];
    if (eventType) {
      query += ' AND event_type = $3';
      params.push(eventType);
    }
    query += ' ORDER BY timestamp DESC';
    const eventsResult = await db.query(query, params);
    const events = eventsResult.rows;

    return events.map(event => ({
      ...event,
      event_data: JSON.parse(event.event_data || '{}')
    }));
  } catch (error) {
    console.error('Failed to get analytics data:', error);
    return [];
  }
}

async function getSystemAnalytics(days = 30) {
  try {
    const db = getDatabase();

    // Get total events
    const totalEventsResult = await db.query(
      `SELECT COUNT(*) as count 
         FROM analytics_events 
         WHERE timestamp >= NOW() - INTERVAL '$1 days'`,
      [days]
    );
    const totalEvents = totalEventsResult.rows[0]?.count || 0;

    // Get unique users
    const uniqueUsersResult = await db.query(
      `SELECT COUNT(DISTINCT user_id) as count 
         FROM analytics_events 
         WHERE timestamp >= NOW() - INTERVAL '$1 days'`,
      [days]
    );
    const uniqueUsers = uniqueUsersResult.rows[0]?.count || 0;

    // Get top events
    const topEventsResult = await db.query(
      `SELECT event_type, COUNT(*) as count
         FROM analytics_events 
         WHERE timestamp >= NOW() - INTERVAL '$1 days'
         GROUP BY event_type
         ORDER BY count DESC
         LIMIT 10`,
      [days]
    );
    const topEvents = topEventsResult.rows;

    return {
      total_events: totalEvents,
      unique_users: uniqueUsers,
      top_events: topEvents,
      period_days: days
    };
  } catch (error) {
    console.error('Failed to get system analytics:', error);
    return null;
  }
}

module.exports = {
  logAnalyticsEvent,
  getAnalyticsData,
  getSystemAnalytics
};