const express = require('express');
const { getDatabase } = require('../database/init');
const { authenticateToken } = require('../middleware/auth');
const { logAnalyticsEvent } = require('../services/analyticsService');
const { 
  getMarketData, 
  searchSymbols, 
  getHistoricalData,
  getMarketOverview,
  getCompanyProfile,
  getOptionsData,
  addSymbolToTracking,
  removeSymbolFromTracking
} = require('../services/marketDataService');

const router = express.Router();

// Get market data for a symbol
router.get('/quote/:symbol', authenticateToken, async (req, res) => {
  try {
    const { symbol } = req.params;
    const marketData = await getMarketData(symbol.toUpperCase());

    if (!marketData) {
      return res.status(404).json({ error: 'Symbol not found' });
    }

    // Track symbol for real-time updates
    addSymbolToTracking(symbol);

    await logAnalyticsEvent(req.user.userId, 'market_data_viewed', { symbol });

    res.json(marketData);
  } catch (error) {
    console.error('Get market data error:', error);
    res.status(500).json({ error: 'Failed to get market data' });
  }
});

// Get market data for multiple symbols
router.get('/quotes', authenticateToken, async (req, res) => {
  try {
    const { symbols } = req.query;
    
    if (!symbols) {
      return res.status(400).json({ error: 'Symbols parameter is required' });
    }
    
    const symbolList = symbols.split(',').map(s => s.trim().toUpperCase());
    
    if (symbolList.length === 0) {
      return res.status(400).json({ error: 'At least one symbol is required' });
    }
    
    // Get quotes for all symbols in parallel
    const quotesPromises = symbolList.map(async (symbol) => {
      try {
        const data = await getMarketData(symbol);
        // Track symbol for real-time updates
        addSymbolToTracking(symbol);
        return data;
      } catch (error) {
        console.error(`Error fetching data for ${symbol}:`, error);
        return null;
      }
    });
    
    const quotes = (await Promise.all(quotesPromises)).filter(Boolean);
    
    await logAnalyticsEvent(req.user.userId, 'market_data_bulk_refresh', { 
      symbols: symbolList,
      count: quotes.length
    });
    
    res.json(quotes);
  } catch (error) {
    console.error('Get market quotes error:', error);
    res.status(500).json({ error: 'Failed to get market quotes' });
  }
});

// Search for symbols
router.get('/search', authenticateToken, async (req, res) => {
  try {
    const { q: query, limit = 10 } = req.query;

    if (!query || query.length < 1) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const results = await searchSymbols(query, parseInt(limit));

    await logAnalyticsEvent(req.user.userId, 'symbol_search', { query, results_count: results.length });

    res.json(results);
  } catch (error) {
    console.error('Search symbols error:', error);
    res.status(500).json({ error: 'Failed to search symbols' });
  }
});

// Get market overview
router.get('/overview', authenticateToken, async (req, res) => {
  try {
    const overview = await getMarketOverview();

    await logAnalyticsEvent(req.user.userId, 'market_overview_viewed');

    res.json(overview);
  } catch (error) {
    console.error('Get market overview error:', error);
    res.status(500).json({ error: 'Failed to get market overview' });
  }
});

// Get historical data
router.get('/history/:symbol', authenticateToken, async (req, res) => {
  try {
    const { symbol } = req.params;
    const { period = '1y', interval = '1d' } = req.query;

    const historicalData = await getHistoricalData(symbol, period, interval);

    await logAnalyticsEvent(req.user.userId, 'historical_data_viewed', { symbol, period, interval });

    res.json({
      symbol: symbol.toUpperCase(),
      period,
      interval,
      data: historicalData
    });
  } catch (error) {
    console.error('Get historical data error:', error);
    res.status(500).json({ error: 'Failed to get historical data' });
  }
});

// Get company profile
router.get('/profile/:symbol', authenticateToken, async (req, res) => {
  try {
    const { symbol } = req.params;
    const profile = await getCompanyProfile(symbol);

    await logAnalyticsEvent(req.user.userId, 'company_profile_viewed', { symbol });

    res.json(profile);
  } catch (error) {
    console.error('Get company profile error:', error);
    res.status(500).json({ error: 'Failed to get company profile' });
  }
});

// Get options data
router.get('/options/:symbol', authenticateToken, async (req, res) => {
  try {
    const { symbol } = req.params;
    const { expiration } = req.query;
    
    const optionsData = await getOptionsData(symbol, expiration);

    await logAnalyticsEvent(req.user.userId, 'options_data_viewed', { symbol, expiration });

    res.json(optionsData);
  } catch (error) {
    console.error('Get options data error:', error);
    res.status(500).json({ error: 'Failed to get options data' });
  }
});

// Add to watchlist
router.post('/watchlist', authenticateToken, async (req, res) => {
  try {
    const { symbol } = req.body;

    if (!symbol) {
      return res.status(400).json({ error: 'Symbol is required' });
    }

    // Verify symbol exists
    const marketData = await getMarketData(symbol);
    if (!marketData) {
      return res.status(404).json({ error: 'Symbol not found' });
    }

    const db = getDatabase();
    const watchlistId = require('uuid').v4();

    try {
      await new Promise((resolve, reject) => {
        db.run(
          'INSERT INTO watchlist (id, user_id, symbol) VALUES (?, ?, ?)',
          [watchlistId, req.user.userId, symbol.toUpperCase()],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });

      // Track symbol for real-time updates
      addSymbolToTracking(symbol);

      await logAnalyticsEvent(req.user.userId, 'watchlist_added', { symbol });

      res.status(201).json({ message: 'Symbol added to watchlist' });
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT') {
        return res.status(400).json({ error: 'Symbol already in watchlist' });
      }
      throw error;
    }
  } catch (error) {
    console.error('Add to watchlist error:', error);
    res.status(500).json({ error: 'Failed to add to watchlist' });
  }
});

// Get watchlist
router.get('/watchlist', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase();

    const watchlist = await new Promise((resolve, reject) => {
      db.all(
        'SELECT symbol, added_at FROM watchlist WHERE user_id = ? ORDER BY added_at DESC',
        [req.user.userId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    // Enrich with current market data
    const enrichedWatchlist = await Promise.all(
      watchlist.map(async (item) => {
        try {
          const marketData = await getMarketData(item.symbol);
          return {
            symbol: item.symbol,
            addedAt: item.added_at,
            ...marketData
          };
        } catch (error) {
          console.error(`Error getting data for ${item.symbol}:`, error);
          return {
            symbol: item.symbol,
            addedAt: item.added_at,
            name: 'Unknown',
            price: 0,
            changePercent: 0,
            error: 'Data unavailable'
          };
        }
      })
    );

    res.json(enrichedWatchlist);
  } catch (error) {
    console.error('Get watchlist error:', error);
    res.status(500).json({ error: 'Failed to get watchlist' });
  }
});

// Remove from watchlist
router.delete('/watchlist/:symbol', authenticateToken, async (req, res) => {
  try {
    const { symbol } = req.params;
    const db = getDatabase();

    await new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM watchlist WHERE user_id = ? AND symbol = ?',
        [req.user.userId, symbol.toUpperCase()],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    // Remove from tracking if no other users are watching
    removeSymbolFromTracking(symbol);

    await logAnalyticsEvent(req.user.userId, 'watchlist_removed', { symbol });

    res.json({ message: 'Symbol removed from watchlist' });
  } catch (error) {
    console.error('Remove from watchlist error:', error);
    res.status(500).json({ error: 'Failed to remove from watchlist' });
  }
});

// Get real-time market status
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const { getMarketStatus, isMarketHours } = require('../services/marketDataService');
    
    res.json({
      status: getMarketStatus(),
      isOpen: isMarketHours(),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Get market status error:', error);
    res.status(500).json({ error: 'Failed to get market status' });
  }
});

// Get top movers
router.get('/movers', authenticateToken, async (req, res) => {
  try {
    const { type = 'both', limit = 10 } = req.query;
    const overview = await getMarketOverview();
    
    let result = {};
    
    if (type === 'gainers' || type === 'both') {
      result.gainers = overview.topGainers.slice(0, parseInt(limit));
    }
    
    if (type === 'losers' || type === 'both') {
      result.losers = overview.topLosers.slice(0, parseInt(limit));
    }

    await logAnalyticsEvent(req.user.userId, 'market_movers_viewed', { type, limit });

    res.json(result);
  } catch (error) {
    console.error('Get market movers error:', error);
    res.status(500).json({ error: 'Failed to get market movers' });
  }
});

// Get sector performance
router.get('/sectors', authenticateToken, async (req, res) => {
  try {
    const overview = await getMarketOverview();

    await logAnalyticsEvent(req.user.userId, 'sector_performance_viewed');

    res.json({
      sectors: overview.sectorPerformance,
      lastUpdated: overview.lastUpdated
    });
  } catch (error) {
    console.error('Get sector performance error:', error);
    res.status(500).json({ error: 'Failed to get sector performance' });
  }
});

module.exports = router;