/**
 * Input Estimation Module
 * Implements robust statistical techniques for portfolio optimization inputs
 * Based on the technical blueprint's "Data Architecture" section
 */

const math = require('mathjs');

class InputEstimationEngine {
  constructor() {
    this.defaultLookbackPeriod = 252; // 1 year of daily data
  }

  /**
   * Estimate expected returns using various methods
   */
  async estimateExpectedReturns(priceHistory, method = 'historical_mean', options = {}) {
    switch (method) {
      case 'historical_mean':
        return this.historicalMeanReturns(priceHistory, options);
      case 'exponential_weighted':
        return this.exponentialWeightedReturns(priceHistory, options);
      case 'capm':
        return this.capmReturns(priceHistory, options);
      case 'black_litterman':
        return this.blackLittermanReturns(priceHistory, options);
      default:
        throw new Error(`Unknown return estimation method: ${method}`);
    }
  }

  /**
   * Estimate covariance matrix using various methods
   */
  async estimateCovarianceMatrix(priceHistory, method = 'sample', options = {}) {
    switch (method) {
      case 'sample':
        return this.sampleCovarianceMatrix(priceHistory, options);
      case 'shrinkage':
        return this.shrinkageCovarianceMatrix(priceHistory, options);
      case 'factor_model':
        return this.factorModelCovariance(priceHistory, options);
      default:
        throw new Error(`Unknown covariance estimation method: ${method}`);
    }
  }

  /**
   * Simple historical mean returns
   */
  historicalMeanReturns(priceHistory, options = {}) {
    const lookback = options.lookback || this.defaultLookbackPeriod;
    const symbols = Object.keys(priceHistory);
    const returns = {};

    symbols.forEach(symbol => {
      const prices = priceHistory[symbol].slice(-lookback);
      if (prices.length < 2) {
        returns[symbol] = 0;
        return;
      }

      let totalReturn = 0;
      for (let i = 1; i < prices.length; i++) {
        const dailyReturn = Math.log(prices[i].close / prices[i-1].close);
        totalReturn += dailyReturn;
      }
      
      // Annualize the return
      returns[symbol] = (totalReturn / (prices.length - 1)) * 252;
    });

    return returns;
  }

  /**
   * Exponentially weighted mean returns (more recent data has higher weight)
   */
  exponentialWeightedReturns(priceHistory, options = {}) {
    const lambda = options.lambda || 0.94; // Decay factor
    const lookback = options.lookback || this.defaultLookbackPeriod;
    const symbols = Object.keys(priceHistory);
    const returns = {};

    symbols.forEach(symbol => {
      const prices = priceHistory[symbol].slice(-lookback);
      if (prices.length < 2) {
        returns[symbol] = 0;
        return;
      }

      let weightedSum = 0;
      let weightSum = 0;
      
      for (let i = 1; i < prices.length; i++) {
        const dailyReturn = Math.log(prices[i].close / prices[i-1].close);
        const weight = Math.pow(lambda, prices.length - 1 - i);
        weightedSum += weight * dailyReturn;
        weightSum += weight;
      }
      
      // Annualize the return
      returns[symbol] = (weightedSum / weightSum) * 252;
    });

    return returns;
  }

  /**
   * CAPM-based expected returns
   * E(Ri) = Rf + βi(E(Rm) - Rf)
   */
  capmReturns(priceHistory, options = {}) {
    const riskFreeRate = options.riskFreeRate || 0.02;
    const marketReturn = options.marketReturn || 0.08;
    const marketSymbol = options.marketSymbol || 'SPY';
    
    const symbols = Object.keys(priceHistory).filter(s => s !== marketSymbol);
    const returns = {};

    // Calculate betas for each asset
    const betas = this.calculateBetas(priceHistory, marketSymbol, options);
    
    symbols.forEach(symbol => {
      const beta = betas[symbol] || 1.0;
      returns[symbol] = riskFreeRate + beta * (marketReturn - riskFreeRate);
    });

    return returns;
  }

  /**
   * Calculate asset betas relative to market
   */
  calculateBetas(priceHistory, marketSymbol, options = {}) {
    const lookback = options.lookback || this.defaultLookbackPeriod;
    const symbols = Object.keys(priceHistory).filter(s => s !== marketSymbol);
    const betas = {};

    const marketPrices = priceHistory[marketSymbol]?.slice(-lookback) || [];
    if (marketPrices.length < 2) return {};

    // Calculate market returns
    const marketReturns = [];
    for (let i = 1; i < marketPrices.length; i++) {
      marketReturns.push(Math.log(marketPrices[i].close / marketPrices[i-1].close));
    }

    symbols.forEach(symbol => {
      const assetPrices = priceHistory[symbol]?.slice(-lookback) || [];
      if (assetPrices.length < 2) {
        betas[symbol] = 1.0;
        return;
      }

      // Calculate asset returns
      const assetReturns = [];
      for (let i = 1; i < assetPrices.length; i++) {
        assetReturns.push(Math.log(assetPrices[i].close / assetPrices[i-1].close));
      }

      // Calculate beta using covariance and variance
      const minLength = Math.min(marketReturns.length, assetReturns.length);
      const alignedMarketReturns = marketReturns.slice(-minLength);
      const alignedAssetReturns = assetReturns.slice(-minLength);

      const covariance = this.calculateCovariance(alignedAssetReturns, alignedMarketReturns);
      const marketVariance = this.calculateVariance(alignedMarketReturns);

      betas[symbol] = marketVariance > 0 ? covariance / marketVariance : 1.0;
    });

    return betas;
  }

  /**
   * Sample covariance matrix
   */
  sampleCovarianceMatrix(priceHistory, options = {}) {
    const lookback = options.lookback || this.defaultLookbackPeriod;
    const symbols = Object.keys(priceHistory);
    const n = symbols.length;
    
    // Calculate return series for each asset
    const returnSeries = {};
    symbols.forEach(symbol => {
      const prices = priceHistory[symbol].slice(-lookback);
      if (prices.length < 2) {
        returnSeries[symbol] = [];
        return;
      }
      
      returnSeries[symbol] = [];
      for (let i = 1; i < prices.length; i++) {
        returnSeries[symbol].push(Math.log(prices[i].close / prices[i-1].close));
      }
    });

    // Build covariance matrix
    const covMatrix = Array(n).fill().map(() => Array(n).fill(0));
    
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const returns1 = returnSeries[symbols[i]];
        const returns2 = returnSeries[symbols[j]];
        
        if (returns1.length > 0 && returns2.length > 0) {
          const minLength = Math.min(returns1.length, returns2.length);
          const aligned1 = returns1.slice(-minLength);
          const aligned2 = returns2.slice(-minLength);
          
          if (i === j) {
            covMatrix[i][j] = this.calculateVariance(aligned1) * 252; // Annualized
          } else {
            covMatrix[i][j] = this.calculateCovariance(aligned1, aligned2) * 252; // Annualized
          }
        } else {
          covMatrix[i][j] = i === j ? 0.01 : 0; // Small default variance
        }
      }
    }

    return { matrix: covMatrix, symbols };
  }

  /**
   * Ledoit-Wolf shrinkage covariance matrix
   * Shrinks sample covariance toward structured target
   */
  shrinkageCovarianceMatrix(priceHistory, options = {}) {
    const sampleCov = this.sampleCovarianceMatrix(priceHistory, options);
    const shrinkageIntensity = options.shrinkageIntensity || this.calculateOptimalShrinkage(sampleCov);
    
    const n = sampleCov.symbols.length;
    const sampleMatrix = sampleCov.matrix;
    
    // Create structured target (constant correlation model)
    const avgVariance = sampleMatrix.reduce((sum, row, i) => sum + row[i], 0) / n;
    const avgCovariance = this.calculateAverageCovariance(sampleMatrix);
    
    const targetMatrix = Array(n).fill().map((_, i) =>
      Array(n).fill().map((_, j) => i === j ? avgVariance : avgCovariance)
    );
    
    // Shrink sample toward target
    const shrunkMatrix = Array(n).fill().map((_, i) =>
      Array(n).fill().map((_, j) =>
        (1 - shrinkageIntensity) * sampleMatrix[i][j] + shrinkageIntensity * targetMatrix[i][j]
      )
    );

    return { matrix: shrunkMatrix, symbols: sampleCov.symbols };
  }

  /**
   * Factor model covariance matrix
   * Σ = B * F * B' + D
   * where B is factor loadings, F is factor covariance, D is specific risk
   */
  factorModelCovariance(priceHistory, options = {}) {
    const factors = options.factors || ['market', 'size', 'value'];
    // This is a simplified implementation
    // In practice, would use PCA or predefined factor models
    
    // For now, fall back to sample covariance
    return this.sampleCovarianceMatrix(priceHistory, options);
  }

  /**
   * Generate Monte Carlo scenarios for CVaR optimization
   */
  generateMonteCarloScenarios(returns, covariance, numScenarios = 1000, horizon = 1) {
    const n = returns.length;
    const scenarios = [];
    
    // Use Cholesky decomposition for correlated random samples
    const L = this.choleskyDecomposition(covariance.matrix);
    
    for (let s = 0; s < numScenarios; s++) {
      // Generate independent standard normal variables
      const z = Array(n).fill().map(() => this.boxMullerRandom());
      
      // Transform to correlated variables
      const correlatedZ = this.matrixVectorMultiply(L, z);
      
      // Scale by volatility and add expected returns
      const scenario = correlatedZ.map((shock, i) => 
        returns[covariance.symbols[i]] * horizon + shock * Math.sqrt(horizon)
      );
      
      scenarios.push(scenario);
    }
    
    return scenarios;
  }

  // Helper methods
  calculateCovariance(series1, series2) {
    if (series1.length !== series2.length || series1.length === 0) return 0;
    
    const mean1 = series1.reduce((sum, val) => sum + val, 0) / series1.length;
    const mean2 = series2.reduce((sum, val) => sum + val, 0) / series2.length;
    
    let covariance = 0;
    for (let i = 0; i < series1.length; i++) {
      covariance += (series1[i] - mean1) * (series2[i] - mean2);
    }
    
    return covariance / (series1.length - 1);
  }

  calculateVariance(series) {
    if (series.length === 0) return 0;
    
    const mean = series.reduce((sum, val) => sum + val, 0) / series.length;
    let variance = 0;
    
    for (let i = 0; i < series.length; i++) {
      variance += Math.pow(series[i] - mean, 2);
    }
    
    return variance / (series.length - 1);
  }

  calculateOptimalShrinkage(sampleCov) {
    // Simplified Ledoit-Wolf shrinkage intensity calculation
    // In practice, this would be more sophisticated
    return 0.1; // 10% shrinkage
  }

  calculateAverageCovariance(matrix) {
    const n = matrix.length;
    let sum = 0;
    let count = 0;
    
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i !== j) {
          sum += matrix[i][j];
          count++;
        }
      }
    }
    
    return count > 0 ? sum / count : 0;
  }

  choleskyDecomposition(matrix) {
    const n = matrix.length;
    const L = Array(n).fill().map(() => Array(n).fill(0));
    
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        if (i === j) {
          let sum = 0;
          for (let k = 0; k < j; k++) {
            sum += L[j][k] * L[j][k];
          }
          L[i][j] = Math.sqrt(Math.max(0, matrix[i][i] - sum));
        } else {
          let sum = 0;
          for (let k = 0; k < j; k++) {
            sum += L[i][k] * L[j][k];
          }
          L[i][j] = L[j][j] > 0 ? (matrix[i][j] - sum) / L[j][j] : 0;
        }
      }
    }
    
    return L;
  }

  matrixVectorMultiply(matrix, vector) {
    return matrix.map(row => 
      row.reduce((sum, val, i) => sum + val * vector[i], 0)
    );
  }

  boxMullerRandom() {
    // Box-Muller transformation for normal random variables
    const u1 = Math.random();
    const u2 = Math.random();
    
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /**
   * Configuration factory for different estimation strategies
   */
  static getEstimationConfig(strategy = 'conservative') {
    const configs = {
      conservative: {
        returns: { method: 'historical_mean', lookback: 504 }, // 2 years
        covariance: { method: 'shrinkage', shrinkageIntensity: 0.2 }
      },
      moderate: {
        returns: { method: 'exponential_weighted', lambda: 0.94 },
        covariance: { method: 'shrinkage', shrinkageIntensity: 0.1 }
      },
      aggressive: {
        returns: { method: 'exponential_weighted', lambda: 0.98 },
        covariance: { method: 'sample', lookback: 252 }
      },
      capm_based: {
        returns: { method: 'capm', riskFreeRate: 0.02, marketReturn: 0.08 },
        covariance: { method: 'factor_model' }
      }
    };
    
    return configs[strategy] || configs.moderate;
  }
}

module.exports = { InputEstimationEngine };
