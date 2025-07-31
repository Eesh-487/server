const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { getDatabase } = require('../database/init');
const { authenticateToken } = require('../middleware/auth');
const { logAnalyticsEvent } = require('../services/analyticsService');
const { getMarketData } = require('../services/marketDataService');
const { calculatePortfolioMetrics } = require('../services/portfolioService');
const { logError } = require('../utils/logger');
const router = express.Router();

// Clear all portfolio data
router.delete('/clear', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase();
    const userId = req.user.userId;

    // Delete all holdings for the user
    await db.query('DELETE FROM portfolio_holdings WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM watchlists WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM portfolio_history WHERE user_id = $1', [userId]);

    // Log analytics event
    await logAnalyticsEvent(userId, 'portfolio_cleared', {}, req.ip, req.get('User-Agent'));

    res.json({ message: 'Portfolio data successfully cleared' });
  } catch (error) {
    logError(`Clear portfolio error for user ${req.user?.userId || 'unknown'}: ${error.stack || error}`);
    res.status(500).json({ error: 'Failed to clear portfolio data' });
  }
});

// ...existing code...
const yahooFinance = require('yahoo-finance2').default;

router.get('/holdings', authenticateToken, async (req, res) => {
  const { logError } = require('../utils/logger');
  try {
    const db = getDatabase();
    const userId = req.user.userId;
    console.log('Fetching holdings for user:', userId);

    const holdingsResult = await db.query('SELECT * FROM portfolio_holdings WHERE user_id = $1', [userId]);
    const holdings = holdingsResult.rows;

    console.log('Holdings:', holdings);

    if (!Array.isArray(holdings) || holdings.length === 0) {
      return res.json({ holdings: [], total_value: 0 });
    }

    const enrichedHoldings = await Promise.all(holdings.map(async (holding) => {
      let currentPrice = holding.current_price;
      try {
        const quote = await yahooFinance.quote(holding.symbol);
        currentPrice = quote.regularMarketPrice || holding.current_price || holding.average_cost || 0;
        await new Promise((resolve, reject) => {
          db.run(
            'UPDATE portfolio_holdings SET current_price = ? WHERE id = ?',
            [currentPrice, holding.id],
            (err) => {
              if (err) {
                logError(`DB error updating current_price for holding ${holding.id}: ${err.stack || err}`);
                reject(err);
              } else {
                resolve();
              }
            }
          );
        });
      } catch (err) {
        logError(`Could not fetch market data for ${holding.symbol}: ${err.stack || err}`);
      }
      // Net expenditure (purchase_price * quantity)
      const netExpenditure = (holding.purchase_price || holding.average_cost || currentPrice) * holding.quantity;
      const marketValue = currentPrice * holding.quantity;
      return {
        ...holding,
        current_price: currentPrice,
        net_expenditure: netExpenditure,
        value: netExpenditure, // For frontend compatibility
        market_value: marketValue,
        allocation: netExpenditure
      };
    }));

    const totalValue = enrichedHoldings.reduce((sum, h) => sum + (h.market_value || 0), 0);
    enrichedHoldings.forEach(h => {
      h.allocation = totalValue > 0 ? ((h.market_value || 0) / totalValue) * 100 : 0;
    });

    console.log('Enriched holdings:', enrichedHoldings);

    res.json({ holdings: enrichedHoldings, total_value: totalValue });
  } catch (error) {
    logError(`Error fetching holdings for user ${req.user?.userId || 'unknown'}: ${error.stack || error}`);
    res.status(500).json({ error: 'Failed to fetch holdings' });
  }
});
// ...existing code...
// Add holding
router.post('/holdings', authenticateToken, [
  body('symbol').trim().isLength({ min: 1 }),
  body('name').trim().isLength({ min: 1 }),
  body('category').trim().isLength({ min: 1 }),
  body('quantity').isFloat({ min: 0.001 })
  // Removed average_cost validation completely
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { symbol, name, category, quantity } = req.body;
    const db = getDatabase();

    // Fetch current market price for the symbol (required now)
    let currentPrice;
    let purchasePrice;
    
    try {
      const marketData = await getMarketData(symbol.toUpperCase());
      if (marketData && marketData.price > 0) {
        currentPrice = marketData.price;
        purchasePrice = currentPrice; // Always use current market price
      } else {
        console.error(`[Add Asset] Could not fetch current market price for ${symbol}. marketData:`, marketData);
        return res.status(400).json({ 
          error: 'Could not fetch current market price. Please try again later.' 
        });
      }
    } catch (error) {
      console.error(`[Add Asset] Error fetching market data for ${symbol}:`, error);
      return res.status(400).json({ 
        error: 'Could not fetch current market price. Please try again later.' 
      });
    }

    // Check if holding already exists (get ALL matching holdings in case of duplicates)
    const existingHoldingsResult = await db.query(
      'SELECT id, quantity, average_cost FROM portfolio_holdings WHERE user_id = $1 AND symbol = $2',
      [req.user.userId, symbol.toUpperCase()]
    );
    const existingHoldings = existingHoldingsResult.rows;

    // If multiple holdings with this symbol exist, merge them first
    let existingHolding = null;
    if (existingHoldings.length > 1) {
      console.log(`Found ${existingHoldings.length} duplicate holdings for ${symbol}, merging them first`);
      
      // Calculate merged values
      const totalQuantity = existingHoldings.reduce((sum, h) => sum + h.quantity, 0);
      const totalCost = existingHoldings.reduce((sum, h) => sum + (h.quantity * h.average_cost), 0);
      const newAverageCost = totalCost / totalQuantity;
      
      // Update the first holding with merged values
      await db.query(
        'UPDATE portfolio_holdings SET quantity = $1, average_cost = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [totalQuantity, newAverageCost, existingHoldings[0].id]
      );

      // Delete the duplicate holdings (keep the first one)
      for (let i = 1; i < existingHoldings.length; i++) {
        await db.query(
          'DELETE FROM portfolio_holdings WHERE id = $1',
          [existingHoldings[i].id]
        );
      }
      
      existingHolding = {
        id: existingHoldings[0].id,
        quantity: totalQuantity,
        average_cost: newAverageCost
      };
    } else if (existingHoldings.length === 1) {
      existingHolding = existingHoldings[0];
    }

    if (existingHolding) {
      // Update existing holding (average cost calculation)
      const totalQuantity = existingHolding.quantity + quantity;
      const newAverageCost = ((existingHolding.quantity * existingHolding.average_cost) + 
                             (quantity * purchasePrice)) / totalQuantity;

      await db.query(
        'UPDATE portfolio_holdings SET quantity = $1, average_cost = $2, current_price = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4',
        [totalQuantity, newAverageCost, currentPrice, existingHolding.id]
      );

      await logAnalyticsEvent(req.user.userId, 'holding_updated', { symbol, quantity, purchase_price: purchasePrice });
    } else {
      // Create new holding
      const holdingId = uuidv4();
      await db.query(
        'INSERT INTO portfolio_holdings (id, user_id, symbol, name, category, quantity, average_cost, purchase_price, current_price) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [holdingId, req.user.userId, symbol.toUpperCase(), name, category, quantity, purchasePrice, purchasePrice, currentPrice]
      );

      await logAnalyticsEvent(req.user.userId, 'holding_added', { symbol, quantity, purchase_price: purchasePrice });
    }

    // Automatically populate portfolio performance history after adding a holding
    const { populatePortfolioPerformanceFromHistory } = require('../services/portfolioService');
    await populatePortfolioPerformanceFromHistory(req.user.userId, '1y', '1d');

    res.status(201).json({ 
      message: 'Holding added successfully',
      currentPrice,
      purchasePrice
    });
    return;
  } catch (error) {
    logError(`Add holding error for user ${req.user?.userId || 'unknown'}: ${error.stack || error}`);
    res.status(500).json({ error: 'Failed to add holding' });
  }
});

// Update holding
router.put('/holdings/:id', authenticateToken, [
  body('quantity').optional().isFloat({ min: 0 }),
  body('average_cost').optional().isFloat({ min: 0.01 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { id } = req.params;
    const updates = req.body;
    const db = getDatabase();

    // Verify ownership
    const holdingResult = await db.query(
      'SELECT id FROM portfolio_holdings WHERE id = $1 AND user_id = $2',
      [id, req.user.userId]
    );
    const holding = holdingResult.rows[0];

    if (!holding) {
      return res.status(404).json({ error: 'Holding not found' });
    }

    // Build update query
    const updateFields = [];
    const updateValues = [];
    let paramIndex = 1;
    if (updates.quantity !== undefined) {
      updateFields.push(`quantity = $${paramIndex}`);
      updateValues.push(updates.quantity);
      paramIndex++;
    }
    if (updates.average_cost !== undefined) {
      updateFields.push(`average_cost = $${paramIndex}`);
      updateValues.push(updates.average_cost);
      paramIndex++;
    }
    if (updateFields.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }
    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    updateValues.push(id);
    await db.query(
      `UPDATE portfolio_holdings SET ${updateFields.join(', ')} WHERE id = $${paramIndex}`,
      updateValues
    );

    await logAnalyticsEvent(req.user.userId, 'holding_updated', { holding_id: id, updates });

    // Automatically populate portfolio performance history after updating a holding
    const { populatePortfolioPerformanceFromHistory } = require('../services/portfolioService');
    await populatePortfolioPerformanceFromHistory(req.user.userId, '1y', '1d');

    res.json({ message: 'Holding updated successfully' });
  } catch (error) {
    logError(`Update holding error for user ${req.user?.userId || 'unknown'}: ${error.stack || error}`);
    res.status(500).json({ error: 'Failed to update holding' });
  }
});

// Delete holding
router.delete('/holdings/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const db = getDatabase();

    // Verify ownership and get holding info
    const holdingResult = await db.query(
      'SELECT id, symbol FROM portfolio_holdings WHERE id = $1 AND user_id = $2',
      [id, req.user.userId]
    );
    const holding = holdingResult.rows[0];

    if (!holding) {
      return res.status(404).json({ error: 'Holding not found' });
    }

    await db.query('DELETE FROM portfolio_holdings WHERE id = $1', [id]);

    await logAnalyticsEvent(req.user.userId, 'holding_deleted', { holding_id: id, symbol: holding.symbol });

    res.json({ message: 'Holding deleted successfully' });
  } catch (error) {
    logError(`Delete holding error for user ${req.user?.userId || 'unknown'}: ${error.stack || error}`);
    res.status(500).json({ error: 'Failed to delete holding' });
  }
});

// Get portfolio summary
router.get('/summary', authenticateToken, async (req, res) => {
  try {
    const metrics = await calculatePortfolioMetrics(req.user.userId);
    await logAnalyticsEvent(req.user.userId, 'portfolio_summary_viewed');
    res.json(metrics);
  } catch (error) {
    logError(`Get portfolio summary error for user ${req.user?.userId || 'unknown'}: ${error.stack || error}`);
    res.status(500).json({ error: 'Failed to get portfolio summary' });
  }
});

// Get allocation by category
router.get('/allocation', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase();
    const allocationResult = await db.query(
      `SELECT 
           h.category,
           SUM(h.quantity * COALESCE(m.price, h.average_cost)) as value,
           COUNT(*) as holdings_count
         FROM portfolio_holdings h 
         LEFT JOIN market_data m ON h.symbol = m.symbol 
         WHERE h.user_id = $1 
         GROUP BY h.category
         ORDER BY value DESC`,
      [req.user.userId]
    );
    const allocation = allocationResult.rows;

    const totalValue = allocation.reduce((sum, cat) => sum + cat.value, 0);
    
    const enrichedAllocation = allocation.map((cat, index) => ({
      ...cat,
      percentage: totalValue > 0 ? (cat.value / totalValue) * 100 : 0,
      color: getColorForIndex(index)
    }));

    res.json({
      allocation: enrichedAllocation,
      total_value: totalValue
    });
  } catch (error) {
    logError(`Get allocation error for user ${req.user?.userId || 'unknown'}: ${error.stack || error}`);
    res.status(500).json({ error: 'Failed to get portfolio allocation' });
  }
});

// Refresh portfolio data, clean duplicates, and update prices
router.post('/refresh', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase();
    
    // First, check for and clean up any duplicate holdings in the database
    const duplicatesResult = await db.query(
      `SELECT symbol, COUNT(*) as count 
         FROM portfolio_holdings 
         WHERE user_id = $1 
         GROUP BY symbol 
         HAVING COUNT(*) > 1`,
      [req.user.userId]
    );
    const duplicates = duplicatesResult.rows;
    
    let cleanedCount = 0;
    
    // Merge duplicates in the database
    for (const duplicate of duplicates) {
      const allHoldingsResult = await db.query(
        'SELECT * FROM portfolio_holdings WHERE user_id = $1 AND symbol = $2 ORDER BY created_at ASC',
        [req.user.userId, duplicate.symbol]
      );
      const allHoldings = allHoldingsResult.rows;

      if (allHoldings.length > 1) {
        // Calculate merged values
        const totalQuantity = allHoldings.reduce((sum, h) => sum + h.quantity, 0);
        const totalCost = allHoldings.reduce((sum, h) => sum + (h.quantity * h.average_cost), 0);
        const newAverageCost = totalCost / totalQuantity;
        const firstHolding = allHoldings[0];

        // Update the first holding with merged values
        await db.query(
          'UPDATE portfolio_holdings SET quantity = $1, average_cost = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
          [totalQuantity, newAverageCost, firstHolding.id]
        );

        // Delete the duplicate holdings (keep the first one)
        for (let i = 1; i < allHoldings.length; i++) {
          await db.query(
            'DELETE FROM portfolio_holdings WHERE id = $1',
            [allHoldings[i].id]
          );
        }

        cleanedCount++;
      }
    }
    
    // Now get all symbols in the user's portfolio (after cleanup)
    const symbolsResult = await db.query(
      'SELECT DISTINCT symbol FROM portfolio_holdings WHERE user_id = $1',
      [req.user.userId]
    );
    const symbols = symbolsResult.rows.map(row => row.symbol);

    if (symbols.length === 0) {
      return res.json({ 
        message: 'No holdings to refresh', 
        updated_count: 0,
        duplicates_cleaned: cleanedCount
      });
    }

    let updatedCount = 0;

    // Update market data for each symbol
    await Promise.all(symbols.map(async (symbol) => {
      try {
        const marketData = await getMarketData(symbol);
        if (marketData && marketData.price > 0) {
          // Update current_price in holdings
          await db.query(
            'UPDATE portfolio_holdings SET current_price = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2 AND symbol = $3',
            [marketData.price, req.user.userId, symbol]
          );
        }
      } catch (error) {
        console.warn(`Could not update price for ${symbol}:`, error.message);
      }
    }));

    await logAnalyticsEvent(req.user.userId, 'portfolio_refreshed', { 
      symbols_updated: updatedCount,
      duplicates_cleaned: cleanedCount
    });
    
    res.json({ 
      message: 'Portfolio data refreshed successfully',
      updated_count: updatedCount,
      total_symbols: symbols.length,
      duplicates_cleaned: cleanedCount,
      last_updated: new Date().toISOString()
    });
  } catch (error) {
    logError(`Refresh portfolio error for user ${req.user?.userId || 'unknown'}: ${error.stack || error}`);
    res.status(500).json({ error: 'Failed to refresh portfolio data' });
  }
});

// Helper function to get colors for allocation chart
function getColorForIndex(index) {
  const colors = [
    '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', 
    '#EC4899', '#06B6D4', '#84CC16', '#F97316'
  ];
  return colors[index % colors.length];
}

module.exports = router;