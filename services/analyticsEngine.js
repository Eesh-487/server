const cron = require('node-cron');
const { getDatabase } = require('../database/init');
const { updatePortfolioPerformance } = require('./portfolioService');
const { calculateRiskMetrics } = require('./riskService');
const { logAnalyticsEvent } = require('./analyticsService');

let analyticsInterval;

async function startAnalyticsEngine(io) {
  console.log('Starting analytics engine...');
  
  // Schedule daily analytics updates at midnight
  cron.schedule('0 0 * * *', async () => {
    console.log('Running daily analytics update...');
    await runDailyAnalytics(io);
  });

  // Schedule hourly portfolio updates during market hours (9 AM - 4 PM EST)
  cron.schedule('0 9-16 * * 1-5', async () => {
    console.log('Running hourly portfolio updates...');
    await runHourlyUpdates(io);
  });

  // Schedule real-time analytics every 5 minutes
  analyticsInterval = setInterval(async () => {
    await runRealTimeAnalytics(io);
  }, 5 * 60 * 1000); // 5 minutes

  console.log('Analytics engine started');
}

async function runDailyAnalytics(io) {
  try {
    const db = getDatabase();
    
    // Get all users
    const result = await db.query('SELECT id FROM users');
    const users = result.rows;

    for (const user of users) {
      try {
        // Update portfolio performance
        await updatePortfolioPerformance(user.id);
        
        // Calculate risk metrics
        await calculateRiskMetrics(user.id);
        
        // Generate insights
        const insights = await generateDailyInsights(user.id);
        
        // Send notifications if needed
        await processInsightsForNotifications(user.id, insights, io);
        
        console.log(`Daily analytics completed for user ${user.id}`);
      } catch (error) {
        console.error(`Failed to run daily analytics for user ${user.id}:`, error);
      }
    }
  } catch (error) {
    console.error('Failed to run daily analytics:', error);
  }
}

async function runHourlyUpdates(io) {
  try {
    const db = getDatabase();
    
    // Get active users (users who logged in within last 24 hours)
    const result = await db.query(
      `SELECT DISTINCT user_id 
         FROM analytics_events 
         WHERE event_type = 'user_login' 
         AND timestamp >= NOW() - INTERVAL '1 day'`
    );
    const activeUsers = result.rows;

    for (const user of activeUsers) {
      try {
        // Update portfolio metrics
        const metrics = await updatePortfolioPerformance(user.user_id);
        
        // Emit real-time updates to connected clients
        io.to(`user_${user.user_id}`).emit('portfolio_update', metrics);
        
      } catch (error) {
        console.error(`Failed to run hourly update for user ${user.user_id}:`, error);
      }
    }
  } catch (error) {
    console.error('Failed to run hourly updates:', error);
  }
}

async function runRealTimeAnalytics(io) {
  try {
    // Generate system-wide analytics
    const systemMetrics = await generateSystemMetrics();
    
    // Emit system metrics to admin users
    io.emit('system_metrics', systemMetrics);
    
    // Check for alerts and anomalies
    await checkForAlerts(io);
    
  } catch (error) {
    console.error('Failed to run real-time analytics:', error);
  }
}

async function generateDailyInsights(userId) {
  const db = getDatabase();
  const insights = [];

  try {
    // Get portfolio holdings
    const result = await db.query(
      `SELECT h.*, m.price as current_price, m.change_percent
         FROM portfolio_holdings h 
         LEFT JOIN market_data m ON h.symbol = m.symbol 
         WHERE h.user_id = $1`,
      [userId]
    );
    const holdings = result.rows;

    if (holdings.length === 0) return insights;

    // Calculate total portfolio value
    const totalValue = holdings.reduce((sum, holding) => {
      const price = holding.current_price || holding.average_cost;
      return sum + (holding.quantity * price);
    }, 0);

    // Concentration risk analysis
    const categoryAllocation = new Map();
    holdings.forEach(holding => {
      const price = holding.current_price || holding.average_cost;
      const value = holding.quantity * price;
      const current = categoryAllocation.get(holding.category) || 0;
      categoryAllocation.set(holding.category, current + value);
    });

    // Check for high concentration
    for (const [category, value] of categoryAllocation) {
      const allocation = (value / totalValue) * 100;
      if (allocation > 30) {
        insights.push({
          type: 'warning',
          category: 'concentration_risk',
          title: 'High Concentration Risk',
          message: `Your ${category} allocation (${allocation.toFixed(1)}%) exceeds recommended limits.`,
          priority: 'high',
          data: { category, allocation }
        });
      }
    }

    // Performance insights
    const topPerformers = holdings
      .filter(h => h.change_percent > 5)
      .sort((a, b) => b.change_percent - a.change_percent)
      .slice(0, 3);

    if (topPerformers.length > 0) {
      insights.push({
        type: 'success',
        category: 'performance',
        title: 'Strong Performers',
        message: `${topPerformers.length} holdings are up more than 5% today.`,
        priority: 'medium',
        data: { performers: topPerformers.map(h => ({ symbol: h.symbol, change: h.change_percent })) }
      });
    }

    // Diversification insights
    if (categoryAllocation.size < 4) {
      insights.push({
        type: 'info',
        category: 'diversification',
        title: 'Limited Diversification',
        message: `Consider adding more sectors for better diversification. Currently invested in ${categoryAllocation.size} sectors.`,
        priority: 'medium',
        data: { sectors_count: categoryAllocation.size }
      });
    }

    return insights;
  } catch (error) {
    console.error(`Failed to generate insights for user ${userId}:`, error);
    return insights;
  }
}

async function processInsightsForNotifications(userId, insights, io) {
  const db = getDatabase();
  
  // Create notifications for high-priority insights
  const highPriorityInsights = insights.filter(insight => insight.priority === 'high');
  
  for (const insight of highPriorityInsights) {
    const notificationId = require('uuid').v4();
    
    await db.query(
      'INSERT INTO notifications (id, user_id, type, title, message) VALUES ($1, $2, $3, $4, $5)',
      [notificationId, userId, insight.type, insight.title, insight.message]
    );

    // Emit real-time notification
    io.to(`user_${userId}`).emit('notification', {
      id: notificationId,
      type: insight.type,
      title: insight.title,
      message: insight.message,
      timestamp: new Date().toISOString()
    });
  }
}

async function generateSystemMetrics() {
  const db = getDatabase();
  
  try {
    // Get total users
    const totalUsersResult = await db.query('SELECT COUNT(*) as count FROM users');
    const totalUsers = totalUsersResult.rows[0]?.count || 0;

    // Get active users today
    const activeUsersTodayResult = await db.query(
      `SELECT COUNT(DISTINCT user_id) as count 
         FROM analytics_events 
         WHERE DATE(timestamp) = CURRENT_DATE`
    );
    const activeUsersToday = activeUsersTodayResult.rows[0]?.count || 0;

    // Get total portfolio value
    const totalPortfolioValueResult = await db.query(
      `SELECT SUM(h.quantity * COALESCE(m.price, h.average_cost)) as total
         FROM portfolio_holdings h 
         LEFT JOIN market_data m ON h.symbol = m.symbol`
    );
    const totalPortfolioValue = totalPortfolioValueResult.rows[0]?.total || 0;

    // Get popular features
    const popularFeaturesResult = await db.query(
      `SELECT event_type, COUNT(*) as usage_count
         FROM analytics_events 
         WHERE timestamp >= NOW() - INTERVAL '7 days'
         AND event_type LIKE '%_viewed'
         GROUP BY event_type
         ORDER BY usage_count DESC
         LIMIT 5`
    );
    const popularFeatures = popularFeaturesResult.rows;

    return {
      total_users: totalUsers,
      active_users_today: activeUsersToday,
      total_portfolio_value: totalPortfolioValue,
      popular_features: popularFeatures,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('Failed to generate system metrics:', error);
    return null;
  }
}

async function checkForAlerts(io) {
  const db = getDatabase();
  
  try {
    // Check for unusual market movements
    const unusualMovementsResult = await db.query(
      `SELECT symbol, price, change_percent 
         FROM market_data 
         WHERE ABS(change_percent) > 10
         ORDER BY ABS(change_percent) DESC`
    );
    const unusualMovements = unusualMovementsResult.rows;

    if (unusualMovements.length > 0) {
      // Emit market alert
      io.emit('market_alert', {
        type: 'unusual_movement',
        message: `${unusualMovements.length} stocks showing unusual movements (>10%)`,
        data: unusualMovements,
        timestamp: new Date().toISOString()
      });
    }

    // Check for system performance issues
    const errorRate = await calculateErrorRate();
    if (errorRate > 0.05) { // 5% error rate threshold
      io.emit('system_alert', {
        type: 'high_error_rate',
        message: `System error rate is ${(errorRate * 100).toFixed(2)}%`,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error('Failed to check for alerts:', error);
  }
}

async function calculateErrorRate() {
  // Mock error rate calculation
  // In production, this would analyze server logs and error metrics
  return Math.random() * 0.02; // Random error rate between 0-2%
}

function stopAnalyticsEngine() {
  if (analyticsInterval) {
    clearInterval(analyticsInterval);
    console.log('Analytics engine stopped');
  }
}

module.exports = {
  startAnalyticsEngine,
  stopAnalyticsEngine,
  runDailyAnalytics,
  generateDailyInsights
};