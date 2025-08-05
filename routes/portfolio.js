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
        await db.query(
          'UPDATE portfolio_holdings SET current_price = $1 WHERE id = $2',
          [currentPrice, holding.id]
        );
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
  body('asset_type').trim().optional().default('Stock'),
  body('name').trim().isLength({ min: 1 }),
  body('category').trim().isLength({ min: 1 }),
  body('quantity').isFloat({ min: 0.001 }),
  body('symbol').custom((value, { req }) => {
    // Symbol required for all except Cash/Other/Real Estate
    const assetType = req.body.asset_type || 'Stock';
    if (['Cash', 'Other', 'Real Estate'].includes(assetType)) return true;
    return typeof value === 'string' && value.trim().length > 0;
  }).withMessage('Symbol is required for this asset type.'),
  body('purchase_price').custom((value, { req }) => {
    // Manual price required for Cash/Other/Real Estate
    const assetType = req.body.asset_type || 'Stock';
    if (['Cash', 'Other', 'Real Estate'].includes(assetType)) {
      return value !== undefined && !isNaN(parseFloat(value));
    }
    return true;
  }).withMessage('Purchase price is required for this asset type.')
], async (req, res) => {
  try {
    console.log('Received holding data:', JSON.stringify(req.body, null, 2));
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('Validation errors:', errors.array());
      return res.status(400).json({ errors: errors.array() });
    }

    // Check if asset_type column exists in the database
    try {
      const db = getDatabase();
      const checkColumn = await db.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name='portfolio_holdings' AND column_name='asset_type'
      `);
      
      const hasAssetTypeColumn = checkColumn.rows.length > 0;
      console.log('Database has asset_type column:', hasAssetTypeColumn);
      
      if (!hasAssetTypeColumn) {
        // Add the column if it doesn't exist
        await db.query(`ALTER TABLE portfolio_holdings ADD COLUMN IF NOT EXISTS asset_type TEXT DEFAULT 'Stock'`);
        console.log('Added asset_type column to portfolio_holdings table');
      }
    } catch (schemaError) {
      console.error('Error checking schema:', schemaError);
      // Continue execution even if this check fails
    }

    // Set default values if not provided
    const asset_type = req.body.asset_type || 'Stock';
    const symbol = req.body.symbol || null;
    const name = req.body.name;
    const category = req.body.category;
    // Make sure quantity is a proper number
    const quantity = parseFloat(req.body.quantity);
    if (isNaN(quantity)) {
      return res.status(400).json({ error: 'Invalid quantity value' });
    }
    
    // Handle purchase_price carefully
    let purchase_price = null;
    if (req.body.purchase_price !== undefined && req.body.purchase_price !== null && req.body.purchase_price !== '') {
      purchase_price = parseFloat(req.body.purchase_price);
      if (isNaN(purchase_price)) {
        return res.status(400).json({ error: 'Invalid purchase price value' });
      }
    }
    
    console.log('Processed holding data:', { 
      asset_type, 
      symbol, 
      name, 
      category, 
      quantity, 
      purchase_price,
      purchase_price_raw: req.body.purchase_price 
    });

    const db = getDatabase();

          // Determine price logic based on asset type
    let currentPrice = 0;
    let purchasePrice = 0;
    if (['Cash', 'Other', 'Real Estate'].includes(asset_type)) {
      // For these asset types, use the provided purchase price directly
      currentPrice = purchase_price || 100.00;
      purchasePrice = purchase_price || 100.00;
      console.log(`Using provided price for ${asset_type}: ${currentPrice}`);
    }
    else if (['Stock', 'ETF', 'Bond', 'Commodity', 'Crypto'].includes(asset_type) && symbol) {
      try {
        const marketData = symbol ? await getMarketData(symbol.toUpperCase()) : null;
        if (marketData && marketData.price > 0) {
          currentPrice = marketData.price;
          purchasePrice = purchase_price || currentPrice;
          console.log(`Got market price for ${symbol}: ${currentPrice}`);
        } else {
          console.error(`[Add Asset] Could not fetch current market price for ${symbol}. marketData:`, marketData);
          
          // Use fallback price mechanism for all symbols when market data fails
          // Allow the user to add the asset with an estimated price or last known price
          console.log(`Using fallback mechanism for ${symbol}`);
          
          // Option 1: If purchase_price is provided in the request, use that
          if (purchase_price && !isNaN(parseFloat(purchase_price))) {
            currentPrice = parseFloat(purchase_price);
            purchasePrice = currentPrice;
          } 
          // Option 2: Use a default fallback price for demonstration purposes
          else {
            currentPrice = 100.00; // Fallback default price
            purchasePrice = currentPrice;
          }
          
          // Log that we're using a fallback price
          console.log(`Using fallback price for ${symbol}: ${currentPrice}`);
        }
      } catch (error) {
        console.error(`Error fetching market data for ${symbol}:`, error);
        // Set fallback values
        currentPrice = purchase_price || 100.00;
        purchasePrice = currentPrice;
      }
    } else {
      // For any other asset types or missing symbols
      currentPrice = purchase_price || 100.00;
      purchasePrice = purchase_price || 100.00;
    }

    // Check if holding already exists (get ALL matching holdings in case of duplicates)
    const existingHoldingsResult = await db.query(
      'SELECT id, quantity, average_cost FROM portfolio_holdings WHERE user_id = $1 AND symbol = $2',
      [req.user.userId, symbol ? symbol.toUpperCase() : null]
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

    try {
      if (existingHolding) {
        console.log(`Updating existing holding for ${symbol}`, existingHolding);
        
        // Verify the values before calculations
        console.log(`Calculations: existingQuantity=${existingHolding.quantity}, quantity=${quantity}, existingCost=${existingHolding.average_cost}, purchasePrice=${purchasePrice}`);
        
        // Calculate new average cost using the weighted average method
        const totalShares = existingHolding.quantity + quantity;
        const newAverageCost = ((existingHolding.quantity * existingHolding.average_cost) + (quantity * purchasePrice)) / totalShares;
        
        console.log(`Calculated values: totalShares=${totalShares}, newAverageCost=${newAverageCost}`);
        
        // Update the existing holding
        await db.query(
          'UPDATE portfolio_holdings SET quantity = $1, average_cost = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
          [totalShares, newAverageCost, existingHolding.id]
        );
        
        console.log(`Successfully updated holding ${existingHolding.id}`);
      } else {
        console.log(`Creating new holding for ${symbol || 'non-stock asset'}`);
        
        // Create a new holding
        const holdingId = uuidv4();
        
        // Log the parameters
        console.log('Insert parameters:', {
          id: holdingId,
          userId: req.user.userId,
          assetType: asset_type,
          symbol: symbol ? symbol.toUpperCase() : null,
          name,
          category,
          quantity,
          purchasePrice,
          purchasePriceInput: purchase_price,
          currentPrice
        });
        
        await db.query(
          'INSERT INTO portfolio_holdings (id, user_id, symbol, name, category, quantity, average_cost, purchase_price, current_price, asset_type) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
          [
            holdingId,
            req.user.userId,
            symbol ? symbol.toUpperCase() : null,
            name,
            category,
            quantity,
            purchasePrice,
            purchase_price,
            currentPrice,
            asset_type
          ]
        );
        
        console.log(`Successfully created new holding with ID ${holdingId}`);
      }
    } catch (error) {
      console.error('Detailed error in holding update/create logic:', error);
      console.error('Error SQL state:', error.code);
      console.error('Error message:', error.message);
      console.error('Error detail:', error.detail);
      console.error('Error constraint:', error.constraint);
      return res.status(500).json({ error: 'An unexpected error occurred processing the holding', details: error.message });
    }

    // We need to update the portfolio performance after adding a holding
    try {
      const { updatePortfolioPerformance } = require('../services/portfolioService');
      await updatePortfolioPerformance(req.user.userId);
      console.log('Portfolio performance updated successfully');
    } catch (performanceError) {
      // Don't let performance update failure prevent the holding from being added
      console.error(`Error updating portfolio performance: ${performanceError.message || performanceError}`);
      // Just log the error and continue
    }

    res.status(201).json({ 
      message: 'Holding added successfully',
      currentPrice,
      purchasePrice
    });
    return;
  } catch (error) {
    console.error(`Add holding error for user ${req.user?.userId || 'unknown'}:`, error);
    logError(`Add holding error for user ${req.user?.userId || 'unknown'}: ${error.stack || error}`);
    
    // Send more specific error message to help with debugging
    let errorMessage = 'Failed to add holding';
    let errorDetail = '';
    
    if (error.code === '23505') {
      errorMessage = 'A holding with this symbol already exists';
      errorDetail = error.detail || '';
    } else if (error.code === '23503') {
      errorMessage = 'Referenced record does not exist';
      errorDetail = error.detail || '';
    } else if (error.code === '42P01') {
      errorMessage = 'Database table not found';
    } else if (error.code === '22P02') {
      errorMessage = 'Invalid input syntax for type';
      errorDetail = error.detail || '';
    } else if (error.message) {
      // Include the actual error message (sanitized) to help with debugging
      errorDetail = error.message.substring(0, 200);
    }
    
    console.error('Sending error response:', errorMessage, errorDetail);
    res.status(500).json({ 
      error: errorMessage,
      detail: errorDetail 
    });
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