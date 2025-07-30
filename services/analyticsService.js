const { v4: uuidv4 } = require('uuid');
const { getDatabase } = require('../database/init');

async function logAnalyticsEvent(userId, eventType, eventData = {}, ipAddress = null, userAgent = null) {
  try {
    const db = getDatabase();
    const eventId = uuidv4();

    await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO analytics_events (id, user_id, event_type, event_data, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
        [eventId, userId, eventType, JSON.stringify(eventData), ipAddress, userAgent],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

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
      WHERE user_id = ? 
      AND timestamp >= datetime('now', '-' || ? || ' days')
    `;
    
    const params = [userId, days];
    
    if (eventType) {
      query += ' AND event_type = ?';
      params.push(eventType);
    }
    
    query += ' ORDER BY timestamp DESC';

    const events = await new Promise((resolve, reject) => {
      db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

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
    const totalEvents = await new Promise((resolve, reject) => {
      db.get(
        `SELECT COUNT(*) as count 
         FROM analytics_events 
         WHERE timestamp >= datetime('now', '-' || ? || ' days')`,
        [days],
        (err, row) => {
          if (err) reject(err);
          else resolve(row?.count || 0);
        }
      );
    });

    // Get unique users
    const uniqueUsers = await new Promise((resolve, reject) => {
      db.get(
        `SELECT COUNT(DISTINCT user_id) as count 
         FROM analytics_events 
         WHERE timestamp >= datetime('now', '-' || ? || ' days')`,
        [days],
        (err, row) => {
          if (err) reject(err);
          else resolve(row?.count || 0);
        }
      );
    });

    // Get top events
    const topEvents = await new Promise((resolve, reject) => {
      db.all(
        `SELECT event_type, COUNT(*) as count
         FROM analytics_events 
         WHERE timestamp >= datetime('now', '-' || ? || ' days')
         GROUP BY event_type
         ORDER BY count DESC
         LIMIT 10`,
        [days],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

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