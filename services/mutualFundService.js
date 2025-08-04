const yahooFinance = require('yahoo-finance2').default;
const YahooFinanceService = require('./yahooFinanceService');

// AMFI code to Yahoo Finance symbol mapping
const MUTUAL_FUND_MAPPING = {
  // Large Cap Funds
  'INF179K01UY0': '0P0000X4D8.BO', // HDFC Top 100 Fund
  'INF090I01LE8': '0P0000XNHS.BO', // Axis Bluechip Fund
  'INF209K01VL0': '0P0000XHRU.BO', // ICICI Prudential Bluechip Fund
  'INF174K01LS2': '0P0000Y4KA.BO', // Mirae Asset Large Cap Fund
  
  // Mid Cap Funds
  'INF209K01UZ2': '0P0000XHSK.BO', // ICICI Prudential Midcap Fund
  'INF760K01BP0': '0P0000XMII.BO', // SBI Magnum Midcap Fund
  'INF179K01WS7': '0P0000X4EN.BO', // HDFC Mid-Cap Opportunities Fund
  
  // Small Cap Funds
  'INF090I01LM1': '0P0000XNI1.BO', // Axis Small Cap Fund
  'INF204K01Y34': '0P0000XLC3.BO', // Nippon India Small Cap Fund
  
  // Index Funds
  'INF846K01CH2': '0P0000XNEI.BO', // UTI Nifty Index Fund
  'INF179K01XE5': '0P0000X4E2.BO', // HDFC Index Fund-NIFTY 50 Plan
  
  // Debt Funds
  'INF200K01LS9': '0P0000XLWM.BO', // SBI Liquid Fund
  'INF090I01KD1': '0P0000XNHJ.BO', // Axis Liquid Fund
  'INF209K01WA1': '0P0000XHS5.BO', // ICICI Prudential Corporate Bond Fund
  'INF789F01YH2': '0P0000XIPY.BO', // Kotak Corporate Bond Fund
  
  // Hybrid Funds
  'INF109K01VW2': '0P0000XHS2.BO', // ICICI Prudential Equity & Debt Fund
  'INF205K01ZR1': '0P0000Y4K9.BO', // Mirae Asset Hybrid Equity Fund
  
  // ELSS Funds
  'INF090I01KW1': '0P0000XNHO.BO', // Axis Long Term Equity Fund
  'INF179K01VC8': '0P0000X4DD.BO'  // HDFC Taxsaver
};

class MutualFundService {
  constructor() {
    this.yahooService = YahooFinanceService; // Using the singleton instance directly
    this.cache = new Map();
    this.cacheTimeout = 3600000; // 1 hour cache for mutual funds (NAVs update less frequently)
  }

  // Get Yahoo Finance symbol for AMFI code
  getYahooSymbol(amfiCode) {
    return MUTUAL_FUND_MAPPING[amfiCode] || null;
  }
  
  // Search mutual funds by name, symbol or AMC
  async searchMutualFunds(query, category) {
    query = query.toLowerCase();
    
    try {
      let results = [];
      
      // First, check if any of our mapped funds match
      const matchingFunds = Object.keys(MUTUAL_FUND_MAPPING).filter(amfiCode => {
        // Get the Yahoo symbol
        const yahooSymbol = MUTUAL_FUND_MAPPING[amfiCode];
        return amfiCode.toLowerCase().includes(query) || yahooSymbol.toLowerCase().includes(query);
      });
      
      // Get data for matching funds
      if (matchingFunds.length > 0) {
        const fundPromises = matchingFunds.map(amfiCode => this.getMutualFundData(amfiCode));
        const fundResults = await Promise.allSettled(fundPromises);
        
        results = fundResults
          .filter(result => result.status === 'fulfilled' && result.value)
          .map(result => result.value);
      }
      
      // If no results from direct mapping or we have very few results, try a more generic search
      if (results.length < 5) {
        try {
          // Use Yahoo Finance search for mutual funds
          const yahooSearchResults = await yahooFinance.search(query + ' mutual fund');
          
          const filteredResults = yahooSearchResults.quotes
            .filter(quote => 
              quote.quoteType === 'MUTUALFUND' || 
              quote.quoteType === 'ETF' ||
              (quote.shortname && quote.shortname.toLowerCase().includes('fund'))
            )
            .slice(0, 10);
            
          // Get full details for each result
          if (filteredResults.length > 0) {
            const additionalFundPromises = filteredResults.map(async quote => {
              try {
                // Get full data
                const modules = ['summaryDetail', 'fundProfile', 'topHoldings'];
                const details = await yahooFinance.quoteSummary(quote.symbol, { modules });
                
                // Create a standardized response
                return {
                  // We don't have an AMFI code, so use Yahoo symbol
                  symbol: quote.symbol,
                  yahooSymbol: quote.symbol,
                  name: quote.longname || quote.shortname || '',
                  nav: quote.regularMarketPrice || details.summaryDetail?.navPrice?.raw || 0,
                  change: quote.regularMarketChange || 0,
                  changePercent: quote.regularMarketChangePercent || 0,
                  currency: quote.currency || 'INR',
                  exchange: quote.exchange || 'AMFI',
                  type: 'mutualfund',
                  amc: details.fundProfile?.family || '',
                  category: details.fundProfile?.categoryName || 'Other',
                  expense_ratio: details.fundProfile?.feesExpensesInvestment?.annualReportExpenseRatio || 0,
                  risk_level: this.getRiskLevel(details.fundProfile?.riskOverview),
                  ytd_return: details.fundProfile?.ytdReturn || 0,
                  lastUpdated: new Date().toISOString()
                };
              } catch (error) {
                console.error(`Error getting details for ${quote.symbol}:`, error);
                return null;
              }
            });
            
            const additionalResults = await Promise.allSettled(additionalFundPromises);
            const validAdditionalResults = additionalResults
              .filter(result => result.status === 'fulfilled' && result.value)
              .map(result => result.value);
              
            results = [...results, ...validAdditionalResults];
          }
        } catch (error) {
          console.error('Error searching Yahoo Finance:', error);
        }
      }
      
      // Apply category filter if specified
      if (category) {
        results = results.filter(fund => fund.category === category);
      }
      
      // Deduplicate by symbol
      const uniqueResults = [];
      const symbols = new Set();
      for (const fund of results) {
        if (!symbols.has(fund.symbol)) {
          symbols.add(fund.symbol);
          uniqueResults.push(fund);
        }
      }
      
      return uniqueResults.slice(0, 10); // Limit to 10 results
    } catch (error) {
      console.error('Error searching mutual funds:', error);
      return [];
    }
  }

  // Get mutual fund NAV and details
  async getMutualFundData(amfiCode) {
    try {
      const cacheKey = `mf_${amfiCode}`;
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.data;
      }

      const yahooSymbol = this.getYahooSymbol(amfiCode);
      if (!yahooSymbol) {
        console.error(`No Yahoo Finance mapping for AMFI code ${amfiCode}`);
        return null;
      }

      // Use quote endpoint to get NAV data
      const quote = await yahooFinance.quote(yahooSymbol);
      if (!quote || typeof quote !== 'object') {
        console.error(`No valid data returned for ${amfiCode} (${yahooSymbol})`);
        return null;
      }

      // Get additional data using quoteSummary
      const modules = ['summaryDetail', 'fundProfile', 'topHoldings'];
      const details = await yahooFinance.quoteSummary(yahooSymbol, { modules });

      const result = {
        symbol: amfiCode,
        yahooSymbol: yahooSymbol,
        name: quote.longName || quote.shortName || '',
        nav: quote.regularMarketPrice || 0,
        change: quote.regularMarketChange || 0,
        changePercent: quote.regularMarketChangePercent || 0,
        currency: quote.currency || 'INR',
        exchange: quote.fullExchangeName || quote.exchange || 'AMFI',
        amc: details.fundProfile?.family || '',
        expense_ratio: details.fundProfile?.feesExpensesInvestment?.annualReportExpenseRatio || 0,
        risk_level: this.getRiskLevel(details.fundProfile?.riskOverview),
        category: details.fundProfile?.categoryName || 'Equity',
        aum: details.fundProfile?.totalAssets?.fmt || '0',
        ytd_return: details.fundProfile?.ytdReturn || 0,
        min_investment: 5000, // Default, as Yahoo doesn't provide this
        exit_load: '1% if redeemed within 1 year', // Default, as Yahoo doesn't provide this
        lastUpdated: new Date().toISOString()
      };

      this.cache.set(cacheKey, { data: result, timestamp: Date.now() });
      return result;
    } catch (error) {
      console.error(`Error fetching mutual fund data for ${amfiCode}:`, error);
      return null;
    }
  }

  // Map Yahoo risk description to simple levels
  getRiskLevel(riskDescription) {
    if (!riskDescription) return 'Moderate';
    
    const lowerRisk = riskDescription.toLowerCase();
    if (lowerRisk.includes('low') || lowerRisk.includes('conservative')) {
      return 'Low';
    } else if (lowerRisk.includes('high') || lowerRisk.includes('aggressive')) {
      return 'High';
    } else if (lowerRisk.includes('very high')) {
      return 'Very High';
    } else {
      return 'Moderate';
    }
  }
}

module.exports = new MutualFundService();
