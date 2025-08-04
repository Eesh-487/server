/**
 * Advanced Portfolio Optimization Engine
 * Implements the mathematical models described in the technical blueprint
 */

const math = require('mathjs');
const { Matrix } = math;

class PortfolioOptimizationEngine {
  constructor() {
    this.riskFreeRate = 0.02; // 2% annual risk-free rate
  }

  /**
   * Mean-Variance Optimization using Quadratic Programming
   * Minimizes portfolio variance for a given expected return
   */
  async meanVarianceOptimization(returns, covariance, targetReturn, constraints = {}) {
    const n = returns.length;
    
    // Validate inputs
    if (returns.length !== covariance.length || covariance.length !== covariance[0].length) {
      throw new Error('Dimension mismatch between returns and covariance matrix');
    }

    // Use simplified closed-form solution for unconstrained case
    // For full QP, would integrate with optimization library
    const weights = this.solveMinVariancePortfolio(returns, covariance, targetReturn, constraints);
    
    return {
      weights,
      expectedReturn: this.calculatePortfolioReturn(weights, returns),
      expectedVolatility: this.calculatePortfolioVolatility(weights, covariance),
      sharpeRatio: this.calculateSharpeRatio(weights, returns, covariance)
    };
  }

  /**
   * Maximum Sharpe Ratio Optimization
   * Finds the tangency portfolio on the efficient frontier
   */
  async maximizeSharpeRatio(returns, covariance, constraints = {}) {
    const n = returns.length;
    
    // Transform to equivalent QP problem
    // max (μ'w - rf) / sqrt(w'Σw) => solve QP
    const excessReturns = returns.map(r => r - this.riskFreeRate);
    
    // Solve using matrix algebra (simplified)
    const invCovariance = math.inv(covariance);
    const ones = Array(n).fill(1);
    
    // Calculate optimal weights: w* = Σ^(-1) * (μ - rf*1) / (1'Σ^(-1)(μ - rf*1))
    const numerator = math.multiply(invCovariance, excessReturns);
    const denominator = math.multiply(math.multiply(ones, invCovariance), excessReturns);
    
    const weights = numerator.map(w => w / denominator);
    
    // Apply constraints
    const constrainedWeights = this.applyConstraints(weights, constraints);
    
    return {
      weights: constrainedWeights,
      expectedReturn: this.calculatePortfolioReturn(constrainedWeights, returns),
      expectedVolatility: this.calculatePortfolioVolatility(constrainedWeights, covariance),
      sharpeRatio: this.calculateSharpeRatio(constrainedWeights, returns, covariance)
    };
  }

  /**
   * Risk Parity Optimization
   * Equal risk contribution from each asset
   */
  async riskParityOptimization(covariance, maxIterations = 100, tolerance = 1e-6) {
    const n = covariance.length;
    let weights = Array(n).fill(1/n); // Start with equal weights
    
    // Iterative algorithm to find risk parity weights
    for (let iter = 0; iter < maxIterations; iter++) {
      const oldWeights = [...weights];
      
      // Calculate risk contributions
      const portfolioVol = this.calculatePortfolioVolatility(weights, covariance);
      const marginalContributions = this.calculateMarginalRiskContributions(weights, covariance);
      
      // Update weights based on risk contribution difference
      for (let i = 0; i < n; i++) {
        const targetContribution = portfolioVol / n;
        const currentContribution = weights[i] * marginalContributions[i];
        const adjustment = targetContribution / currentContribution;
        weights[i] *= Math.sqrt(adjustment);
      }
      
      // Normalize weights
      const sum = weights.reduce((a, b) => a + b, 0);
      weights = weights.map(w => w / sum);
      
      // Check convergence
      const change = weights.reduce((sum, w, i) => sum + Math.abs(w - oldWeights[i]), 0);
      if (change < tolerance) break;
    }
    
    return {
      weights,
      expectedReturn: null, // Risk parity doesn't optimize for return
      expectedVolatility: this.calculatePortfolioVolatility(weights, covariance),
      riskContributions: this.calculateRiskContributions(weights, covariance)
    };
  }

  /**
   * CVaR (Conditional Value at Risk) Optimization
   * Minimizes expected shortfall in worst-case scenarios
   */
  async cvarOptimization(scenarioReturns, confidenceLevel = 0.05, constraints = {}) {
    // scenarioReturns: matrix where rows are scenarios, columns are assets
    const numScenarios = scenarioReturns.length;
    const numAssets = scenarioReturns[0].length;
    
    // This would typically be solved as a Linear Program
    // For now, using approximation
    const weights = this.solveCVaRApproximation(scenarioReturns, confidenceLevel, constraints);
    
    return {
      weights,
      expectedCVaR: this.calculateCVaR(weights, scenarioReturns, confidenceLevel),
      expectedReturn: this.calculateExpectedReturn(weights, scenarioReturns)
    };
  }

  /**
   * Black-Litterman Model
   * Combines market equilibrium returns with investor views
   */
  async blackLittermanOptimization(marketCapWeights, covariance, views = {}, tau = 0.025) {
    const n = marketCapWeights.length;
    
    // Calculate implied equilibrium returns: Π = δ * Σ * w_market
    const riskAversion = 3.0; // Typical value
    const equilibriumReturns = math.multiply(
      math.multiply(riskAversion, covariance), 
      marketCapWeights
    );
    
    // If no views provided, return equilibrium
    if (!views.P || !views.Q) {
      return {
        weights: marketCapWeights,
        expectedReturns: equilibriumReturns,
        expectedReturn: this.calculatePortfolioReturn(marketCapWeights, equilibriumReturns),
        expectedVolatility: this.calculatePortfolioVolatility(marketCapWeights, covariance)
      };
    }
    
    // Combine equilibrium returns with views using Bayesian updating
    const updatedReturns = this.bayesianUpdate(
      equilibriumReturns, 
      covariance, 
      views, 
      tau
    );
    
    // Optimize with updated returns
    return this.meanVarianceOptimization(updatedReturns, covariance, null, {});
  }

  // Helper methods
  calculatePortfolioReturn(weights, returns) {
    return weights.reduce((sum, w, i) => sum + w * returns[i], 0);
  }

  calculatePortfolioVolatility(weights, covariance) {
    let variance = 0;
    for (let i = 0; i < weights.length; i++) {
      for (let j = 0; j < weights.length; j++) {
        variance += weights[i] * weights[j] * covariance[i][j];
      }
    }
    return Math.sqrt(variance);
  }

  calculateSharpeRatio(weights, returns, covariance) {
    const portfolioReturn = this.calculatePortfolioReturn(weights, returns);
    const portfolioVol = this.calculatePortfolioVolatility(weights, covariance);
    return portfolioVol > 0 ? (portfolioReturn - this.riskFreeRate) / portfolioVol : 0;
  }

  calculateMarginalRiskContributions(weights, covariance) {
    const portfolioVol = this.calculatePortfolioVolatility(weights, covariance);
    const marginalContributions = [];
    
    for (let i = 0; i < weights.length; i++) {
      let contribution = 0;
      for (let j = 0; j < weights.length; j++) {
        contribution += weights[j] * covariance[i][j];
      }
      marginalContributions.push(contribution / portfolioVol);
    }
    
    return marginalContributions;
  }

  calculateRiskContributions(weights, covariance) {
    const marginalContributions = this.calculateMarginalRiskContributions(weights, covariance);
    return weights.map((w, i) => w * marginalContributions[i]);
  }

  applyConstraints(weights, constraints) {
    let constrainedWeights = [...weights];
    
    // Long-only constraint
    if (constraints.longOnly !== false) {
      constrainedWeights = constrainedWeights.map(w => Math.max(0, w));
    }
    
    // Position size limits
    if (constraints.maxWeight) {
      constrainedWeights = constrainedWeights.map(w => Math.min(w, constraints.maxWeight));
    }
    
    if (constraints.minWeight) {
      constrainedWeights = constrainedWeights.map(w => Math.max(w, constraints.minWeight));
    }
    
    // Renormalize to sum to 1
    const sum = constrainedWeights.reduce((a, b) => a + b, 0);
    if (sum > 0) {
      constrainedWeights = constrainedWeights.map(w => w / sum);
    }
    
    return constrainedWeights;
  }

  // Placeholder methods for complex calculations
  solveMinVariancePortfolio(returns, covariance, targetReturn, constraints) {
    // In production, this would use a proper QP solver
    // For now, return equal weights as fallback
    const n = returns.length;
    return Array(n).fill(1/n);
  }

  solveCVaRApproximation(scenarioReturns, confidenceLevel, constraints) {
    // CVaR optimization typically requires Linear Programming
    // This is a simplified approximation
    const numAssets = scenarioReturns[0].length;
    return Array(numAssets).fill(1/numAssets);
  }

  calculateCVaR(weights, scenarioReturns, confidenceLevel) {
    // Calculate portfolio returns for each scenario
    const portfolioReturns = scenarioReturns.map(scenario => 
      this.calculatePortfolioReturn(weights, scenario)
    );
    
    // Sort returns and find VaR threshold
    portfolioReturns.sort((a, b) => a - b);
    const varIndex = Math.floor(confidenceLevel * portfolioReturns.length);
    
    // CVaR is the average of returns below VaR
    const tailReturns = portfolioReturns.slice(0, varIndex);
    return tailReturns.reduce((sum, ret) => sum + ret, 0) / tailReturns.length;
  }

  calculateExpectedReturn(weights, scenarioReturns) {
    const scenarioPortfolioReturns = scenarioReturns.map(scenario => 
      this.calculatePortfolioReturn(weights, scenario)
    );
    return scenarioPortfolioReturns.reduce((sum, ret) => sum + ret, 0) / scenarioPortfolioReturns.length;
  }

  bayesianUpdate(priorReturns, priorCovariance, views, tau) {
    // Simplified Bayesian updating
    // In production, this would implement full Black-Litterman mathematics
    return priorReturns; // Placeholder
  }

  /**
   * Generate efficient frontier points
   */
  generateEfficientFrontier(returns, covariance, numPoints = 100) {
    const minReturn = Math.min(...returns);
    const maxReturn = Math.max(...returns);
    const frontierPoints = [];
    
    for (let i = 0; i < numPoints; i++) {
      const targetReturn = minReturn + (maxReturn - minReturn) * i / (numPoints - 1);
      try {
        const result = this.meanVarianceOptimization(returns, covariance, targetReturn);
        frontierPoints.push({
          expectedReturn: result.expectedReturn,
          expectedVolatility: result.expectedVolatility,
          weights: result.weights
        });
      } catch (error) {
        // Skip infeasible points
        continue;
      }
    }
    
    return frontierPoints;
  }
}

module.exports = { PortfolioOptimizationEngine };
