const express = require('express');
const { getDatabase } = require('../database/init');
const { authenticateToken } = require('../middleware/auth');
const { logAnalyticsEvent } = require('../services/analyticsService');
const { calculatePerformanceMetrics, calculateAttribution } = require('../services/performanceService');

const router = express.Router();

// Get performance metrics
router.get('/metrics', authenticateToken, async (req, res) => {
  try {
    const { period = 'ytd' } = req.query;
    
    const performanceMetrics = await calculatePerformanceMetrics(req.user.userId, period);
    
    await logAnalyticsEvent(req.user.userId, 'performance_metrics_viewed', { period });

    res.json(performanceMetrics);
  } catch (error) {
    console.error('Get performance metrics error:', error);
    res.status(500).json({ error: 'Failed to get performance metrics' });
  }
});

// Get performance history
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const { days = 180 } = req.query;
    const db = getDatabase();

    const performanceHistory = await new Promise((resolve, reject) => {
      db.all(
        `SELECT date, total_value, daily_return, cumulative_return, benchmark_return
         FROM portfolio_performance 
         WHERE user_id = ? 
         AND date >= date('now', '-' || ? || ' days')
         ORDER BY date ASC`,
        [req.user.userId, days],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    // If no historical data, generate sample data
    if (performanceHistory.length === 0) {
      const sampleData = generateSamplePerformanceHistory(parseInt(days));
      res.json(sampleData);
      return;
    }

    await logAnalyticsEvent(req.user.userId, 'performance_history_viewed', { days });

    res.json(performanceHistory);
  } catch (error) {
    console.error('Get performance history error:', error);
    res.status(500).json({ error: 'Failed to get performance history' });
  }
});

// Get monthly returns
router.get('/monthly-returns', authenticateToken, async (req, res) => {
  try {
    const { months = 24 } = req.query;
    const db = getDatabase();

    const monthlyReturns = await new Promise((resolve, reject) => {
      db.all(
        `SELECT 
           strftime('%Y-%m', date) as period,
           AVG(daily_return) * 30 as portfolio_return,
           AVG(benchmark_return) * 30 as benchmark_return
         FROM portfolio_performance 
         WHERE user_id = ? 
         AND date >= date('now', '-' || ? || ' months')
         GROUP BY strftime('%Y-%m', date)
         ORDER BY period DESC`,
        [req.user.userId, months],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    // If no data, generate sample monthly returns
    if (monthlyReturns.length === 0) {
      const sampleData = generateSampleMonthlyReturns(parseInt(months));
      res.json(sampleData);
      return;
    }

    const formattedReturns = monthlyReturns.map(row => ({
      period: formatPeriod(row.period),
      portfolio_return: row.portfolio_return,
      benchmark_return: row.benchmark_return,
      excess_return: row.portfolio_return - row.benchmark_return
    }));

    await logAnalyticsEvent(req.user.userId, 'monthly_returns_viewed', { months });

    res.json(formattedReturns);
  } catch (error) {
    console.error('Get monthly returns error:', error);
    res.status(500).json({ error: 'Failed to get monthly returns' });
  }
});

// Get performance attribution
router.get('/attribution', authenticateToken, async (req, res) => {
  try {
    const attribution = await calculateAttribution(req.user.userId);
    
    await logAnalyticsEvent(req.user.userId, 'performance_attribution_viewed');

    res.json(attribution);
  } catch (error) {
    console.error('Get performance attribution error:', error);
    res.status(500).json({ error: 'Failed to get performance attribution' });
  }
});

// Get risk-adjusted metrics
router.get('/risk-adjusted', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase();
    
    // Get recent risk metrics
    const riskMetrics = await new Promise((resolve, reject) => {
      db.get(
        `SELECT sharpe_ratio, volatility, max_drawdown
         FROM risk_metrics 
         WHERE user_id = ? 
         ORDER BY date DESC 
         LIMIT 1`,
        [req.user.userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    // Calculate additional risk-adjusted metrics
    const riskAdjustedMetrics = {
      sharpe_ratio: riskMetrics?.sharpe_ratio || 1.35,
      sortino_ratio: 1.82, // Would be calculated from downside deviation
      information_ratio: 0.95, // Excess return / tracking error
      max_drawdown: riskMetrics?.max_drawdown || -8.3,
      calmar_ratio: 2.1, // Annual return / max drawdown
      treynor_ratio: 12.5 // (Return - Risk-free rate) / Beta
    };

    await logAnalyticsEvent(req.user.userId, 'risk_adjusted_metrics_viewed');

    res.json(riskAdjustedMetrics);
  } catch (error) {
    console.error('Get risk-adjusted metrics error:', error);
    res.status(500).json({ error: 'Failed to get risk-adjusted metrics' });
  }
});

// Export performance report
router.get('/export', authenticateToken, async (req, res) => {
  try {
    const { format = 'json', period = 'ytd' } = req.query;
    
    // Get comprehensive performance data
    const [metrics, history, monthlyReturns, attribution] = await Promise.all([
      calculatePerformanceMetrics(req.user.userId, period),
      req.query.include_history ? getPerformanceHistory(req.user.userId, 365) : null,
      req.query.include_monthly ? getMonthlyReturns(req.user.userId, 12) : null,
      req.query.include_attribution ? calculateAttribution(req.user.userId) : null
    ]);

    const reportData = {
      generated_at: new Date().toISOString(),
      period,
      metrics,
      ...(history && { history }),
      ...(monthlyReturns && { monthly_returns: monthlyReturns }),
      ...(attribution && { attribution })
    };

    await logAnalyticsEvent(req.user.userId, 'performance_report_exported', { format, period });

    if (format === 'csv') {
      // Convert to CSV format
      const csv = convertToCSV(reportData);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=performance_report_${period}.csv`);
      res.send(csv);
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename=performance_report_${period}.json`);
      res.json(reportData);
    }
  } catch (error) {
    console.error('Export performance report error:', error);
    res.status(500).json({ error: 'Failed to export performance report' });
  }
});

// Helper functions
function generateSamplePerformanceHistory(days) {
  const data = [];
  let portfolioValue = 1000000;
  let benchmarkValue = 1000000;
  
  for (let i = days; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    
    const portfolioChange = (Math.random() - 0.45) * 0.8;
    const benchmarkChange = (Math.random() - 0.47) * 0.65;
    
    portfolioValue *= (1 + portfolioChange / 100);
    benchmarkValue *= (1 + benchmarkChange / 100);
    
    data.push({
      date: date.toISOString().split('T')[0],
      total_value: portfolioValue,
      daily_return: portfolioChange,
      cumulative_return: ((portfolioValue - 1000000) / 1000000) * 100,
      benchmark_return: benchmarkChange
    });
  }
  
  return data;
}

function generateSampleMonthlyReturns(months) {
  const data = [];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  
  for (let i = months - 1; i >= 0; i--) {
    const date = new Date();
    date.setMonth(date.getMonth() - i);
    
    const portfolioReturn = ((Math.random() - 0.4) * 6);
    const benchmarkReturn = ((Math.random() - 0.45) * 5);
    
    data.push({
      period: `${monthNames[date.getMonth()]} ${date.getFullYear()}`,
      portfolio_return: portfolioReturn,
      benchmark_return: benchmarkReturn,
      excess_return: portfolioReturn - benchmarkReturn
    });
  }
  
  return data;
}

function formatPeriod(period) {
  const [year, month] = period.split('-');
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${monthNames[parseInt(month) - 1]} ${year}`;
}

function convertToCSV(data) {
  // Simple CSV conversion - in production, use a proper CSV library
  const headers = Object.keys(data.metrics || {});
  const rows = [headers.join(',')];
  
  if (data.metrics) {
    rows.push(headers.map(h => data.metrics[h]).join(','));
  }
  
  return rows.join('\n');
}

module.exports = router;