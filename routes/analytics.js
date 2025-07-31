const express = require('express');
const { getDatabase } = require('../database/init');
const { authenticateToken } = require('../middleware/auth');
const { logAnalyticsEvent } = require('../services/analyticsService');

const router = express.Router();

// Clear all analytics data
router.delete('/clear', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase();
    const userId = req.user.userId;

    // Delete user analytics data
    await db.query('DELETE FROM analytics_events WHERE user_id = $1', [userId]);

    // Log the clear event itself
    await logAnalyticsEvent(userId, 'analytics_cleared', {}, req.ip, req.get('User-Agent'));

    res.json({ message: 'Analytics data successfully cleared' });
  } catch (error) {
    console.error('Clear analytics error:', error);
    res.status(500).json({ error: 'Failed to clear analytics data' });
  }
});

// Get user analytics dashboard
router.get('/dashboard', authenticateToken, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const db = getDatabase();

    // Get event counts by type
    const eventCountsResult = await db.query(
      `SELECT event_type, COUNT(*) as count
         FROM analytics_events 
         WHERE user_id = $1 
         AND timestamp >= NOW() - INTERVAL '$2 days'
         GROUP BY event_type
         ORDER BY count DESC`,
      [req.user.userId, days]
    );
    const eventCounts = eventCountsResult.rows;

    // Get daily activity
    const dailyActivityResult = await db.query(
      `SELECT DATE(timestamp) as date, COUNT(*) as events
         FROM analytics_events 
         WHERE user_id = $1 
         AND timestamp >= NOW() - INTERVAL '$2 days'
         GROUP BY DATE(timestamp)
         ORDER BY DATE ASC`,
      [req.user.userId, days]
    );
    const dailyActivity = dailyActivityResult.rows;

    // Get most viewed features
    const topFeaturesResult = await db.query(
      `SELECT event_type, COUNT(*) as views
         FROM analytics_events 
         WHERE user_id = $1 
         AND event_type LIKE '%_viewed'
         AND timestamp >= NOW() - INTERVAL '$2 days'
         GROUP BY event_type
         ORDER BY views DESC
         LIMIT 10`,
      [req.user.userId, days]
    );
    const topFeatures = topFeaturesResult.rows;

    const analytics = {
      period_days: parseInt(days),
      total_events: eventCounts.reduce((sum, item) => sum + item.count, 0),
      event_counts: eventCounts,
      daily_activity: dailyActivity,
      top_features: topFeatures.map(item => ({
        feature: item.event_type.replace('_viewed', '').replace('_', ' '),
        views: item.views
      }))
    };

    res.json(analytics);
  } catch (error) {
    console.error('Get analytics dashboard error:', error);
    res.status(500).json({ error: 'Failed to get analytics dashboard' });
  }
});

// Get portfolio insights
router.get('/insights', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase();

    // Get portfolio composition insights
    const holdingsResult = await db.query(
      `SELECT h.category, COUNT(*) as count, 
                SUM(h.quantity * COALESCE(m.price, h.average_cost)) as value
         FROM portfolio_holdings h 
         LEFT JOIN market_data m ON h.symbol = m.symbol 
         WHERE h.user_id = $1 
         GROUP BY h.category`,
      [req.user.userId]
    );
    const holdings = holdingsResult.rows;

    const totalValue = holdings.reduce((sum, h) => sum + h.value, 0);
    
    // Generate insights
    const insights = [];

    // Concentration risk insight
    const maxAllocation = holdings.reduce((max, h) => {
      const allocation = (h.value / totalValue) * 100;
      return allocation > max.percentage ? { category: h.category, percentage: allocation } : max;
    }, { category: '', percentage: 0 });

    if (maxAllocation.percentage > 30) {
      insights.push({
        type: 'warning',
        category: 'concentration_risk',
        title: 'High Concentration Risk',
        message: `Your ${maxAllocation.category} allocation (${maxAllocation.percentage.toFixed(1)}%) exceeds recommended limits. Consider diversifying.`,
        priority: 'high',
        action: 'rebalance'
      });
    }

    // Diversification insight
    if (holdings.length < 5) {
      insights.push({
        type: 'info',
        category: 'diversification',
        title: 'Limited Diversification',
        message: `Your portfolio has only ${holdings.length} asset categories. Consider adding more sectors for better diversification.`,
        priority: 'medium',
        action: 'diversify'
      });
    }

    // Performance insight (mock data for demo)
    insights.push({
      type: 'success',
      category: 'performance',
      title: 'Strong Performance',
      message: 'Your portfolio is outperforming the benchmark by 2.3% over the last 30 days.',
      priority: 'low',
      action: 'maintain'
    });

    await logAnalyticsEvent(req.user.userId, 'insights_viewed', { insights_count: insights.length });

    res.json({
      insights,
      portfolio_stats: {
        total_value: totalValue,
        categories: holdings.length,
        holdings_count: holdings.reduce((sum, h) => sum + h.count, 0)
      }
    });
  } catch (error) {
    console.error('Get insights error:', error);
    res.status(500).json({ error: 'Failed to get portfolio insights' });
  }
});

// Get user behavior patterns
router.get('/behavior', authenticateToken, async (req, res) => {
  try {
    const { days = 90 } = req.query;
    const db = getDatabase();

    // Get login patterns
    const loginPatternResult = await db.query(
      `SELECT EXTRACT(HOUR FROM timestamp) as hour, COUNT(*) as logins
         FROM analytics_events 
         WHERE user_id = $1 
         AND event_type = 'user_login'
         AND timestamp >= NOW() - INTERVAL '$2 days'
         GROUP BY EXTRACT(HOUR FROM timestamp)
         ORDER BY hour`,
      [req.user.userId, days]
    );
    const loginPattern = loginPatternResult.rows;

    // Get feature usage patterns
    const featureUsageResult = await db.query(
      `SELECT event_type, 
                COUNT(*) as usage_count,
                AVG(EXTRACT(DAY FROM NOW() - timestamp)) as avg_days_since_last_use
         FROM analytics_events 
         WHERE user_id = $1 
         AND timestamp >= NOW() - INTERVAL '$2 days'
         GROUP BY event_type
         ORDER BY usage_count DESC`,
      [req.user.userId, days]
    );
    const featureUsage = featureUsageResult.rows;

    // Get session patterns
    const sessionPatternResult = await db.query(
      `SELECT DATE(timestamp) as date,
                COUNT(DISTINCT EXTRACT(HOUR FROM timestamp)) as active_hours,
                COUNT(*) as total_events
         FROM analytics_events 
         WHERE user_id = $1 
         AND timestamp >= NOW() - INTERVAL '$2 days'
         GROUP BY DATE(timestamp)
         ORDER BY DATE DESC
         LIMIT 30`,
      [req.user.userId, days]
    );
    const sessionPattern = sessionPatternResult.rows;

    const behaviorAnalysis = {
      login_pattern: loginPattern,
      feature_usage: featureUsage,
      session_pattern: sessionPattern,
      insights: generateBehaviorInsights(loginPattern, featureUsage, sessionPattern)
    };

    res.json(behaviorAnalysis);
  } catch (error) {
    console.error('Get behavior analysis error:', error);
    res.status(500).json({ error: 'Failed to get behavior analysis' });
  }
});

// Track custom event
router.post('/track', authenticateToken, async (req, res) => {
  try {
    const { event_type, event_data = {} } = req.body;

    if (!event_type) {
      return res.status(400).json({ error: 'Event type is required' });
    }

    await logAnalyticsEvent(
      req.user.userId, 
      event_type, 
      event_data, 
      req.ip, 
      req.get('User-Agent')
    );

    res.json({ message: 'Event tracked successfully' });
  } catch (error) {
    console.error('Track event error:', error);
    res.status(500).json({ error: 'Failed to track event' });
  }
});

// Get system-wide analytics (admin only)
router.get('/system', authenticateToken, async (req, res) => {
  try {
    // This would typically check for admin role
    // For demo purposes, we'll return sample system analytics
    
    const systemAnalytics = {
      total_users: 1247,
      active_users_today: 89,
      total_portfolios: 1156,
      total_portfolio_value: 156789234.56,
      popular_features: [
        { feature: 'Portfolio View', usage: 2341 },
        { feature: 'Risk Analysis', usage: 1876 },
        { feature: 'Performance Tracking', usage: 1654 },
        { feature: 'Optimization', usage: 987 },
        { feature: 'Analytics Dashboard', usage: 743 }
      ],
      user_growth: generateUserGrowthData(),
      system_health: {
        uptime: '99.9%',
        avg_response_time: '145ms',
        error_rate: '0.02%'
      }
    };

    res.json(systemAnalytics);
  } catch (error) {
    console.error('Get system analytics error:', error);
    res.status(500).json({ error: 'Failed to get system analytics' });
  }
});

// Helper functions
function generateBehaviorInsights(loginPattern, featureUsage, sessionPattern) {
  const insights = [];

  // Peak usage time
  if (loginPattern.length > 0) {
    const peakHour = loginPattern.reduce((max, current) => 
      current.logins > max.logins ? current : max
    );
    insights.push({
      type: 'info',
      message: `You're most active around ${peakHour.hour}:00`
    });
  }

  // Feature usage insight
  if (featureUsage.length > 0) {
    const topFeature = featureUsage[0];
    insights.push({
      type: 'info',
      message: `Your most used feature is ${topFeature.event_type.replace('_', ' ')}`
    });
  }

  return insights;
}

function generateUserGrowthData() {
  const data = [];
  for (let i = 30; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    data.push({
      date: date.toISOString().split('T')[0],
      new_users: Math.floor(Math.random() * 20) + 5,
      total_users: 1200 + (30 - i) * 15
    });
  }
  return data;
}

module.exports = router;