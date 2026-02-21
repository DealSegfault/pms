
import numpy as np
from scipy.stats import norm, kendalltau, rankdata
from typing import List, Tuple, Optional, Dict
from dataclasses import dataclass

@dataclass
class CopulaParams:
    rho: float
    df: Optional[float] = None  # Degrees of freedom for t-copula

class BivariateCopula:
    """Base class for bivariate copulas."""
    def h(self, u: float, v: float, params: CopulaParams) -> float:
        """
        Conditional probability P(U <= u | V = v).
        h(u|v) = partial C(u,v) / partial v
        """
        raise NotImplementedError

class GaussianCopula(BivariateCopula):
    """Gaussian Copula implementation."""
    def h(self, u: float, v: float, params: CopulaParams) -> float:
        rho = params.rho
        # Clamp rho to avoid division by zero or numerical instability
        rho = np.clip(rho, -0.999, 0.999)
        
        # Handle edge cases for numerical stability
        u = np.clip(u, 1e-9, 1 - 1e-9)
        v = np.clip(v, 1e-9, 1 - 1e-9)
        
        x = norm.ppf(u)
        y = norm.ppf(v)
        
        num = x - rho * y
        den = np.sqrt(1 - rho**2)
        
        return norm.cdf(num / den)

class PartnerSelector:
    """
    Selects the best partners for a target asset based on statistical dependence (Kendall's Tau).
    """
    def __init__(self, target_symbol: str, candidate_symbols: List[str]):
        self.target = target_symbol
        self.candidates = candidate_symbols

    def select(self, returns_df, n: int = 3) -> List[str]:
        """
        Selects top n partners with highest absolute Kendall's Tau with the target.
        returns_df should be a DataFrame or dictionary-like object where keys/columns are symbols.
        """
        target_returns = returns_df[self.target]
        correlations = []
        
        for cand in self.candidates:
            if cand == self.target:
                continue
            cand_returns = returns_df[cand]
            tau, _ = kendalltau(target_returns, cand_returns)
            correlations.append((cand, abs(tau)))
            
        # Sort by absolute correlation descending
        correlations.sort(key=lambda x: x[1], reverse=True)
        
        return [c for c, _ in correlations[:n]]

class VineCopulaStrategy:
    """
    Implements a C-Vine Copula based Statistical Arbitrage Strategy.
    Reference: 'Statistical arbitrage with vine copulas'
    """
    
    def __init__(self, partner_symbols: List[str] = [], lookback_window: int = 500):
        self.lookback_window = lookback_window
        self.copula = GaussianCopula() # Using Gaussian for simplicity/speed
        self.partner_symbols = partner_symbols
        self.fitted_params: Dict[str, CopulaParams] = {}
        self.mispricing_index_history: List[float] = []

    def _estimate_rho(self, u: np.ndarray, v: np.ndarray) -> float:
        """Estimate Gaussian rho from Kendall's Tau."""
        tau, _ = kendalltau(u, v)
        # transform tau to rho for Gaussian
        return np.sin(np.pi * tau / 2)

    def fit(self, returns_matrix: np.ndarray) -> None:
        """
        Fits a 4-dim C-Vine.
        returns_matrix should be shape (N, 4).
        Columns: [P1, P2, P3, Target].
        We treat P1 as root (index 0).
        Structure: 0-1-2-3 (Target is 3).
        """
        n, d = returns_matrix.shape
        if d != 4:
            raise ValueError("Expected 4 assets (3 partners + 1 target)")
        
        # 1. Transform marginals to Uniform using ECDF
        U = np.zeros_like(returns_matrix)
        for i in range(d):
            U[:, i] = rankdata(returns_matrix[:, i]) / (n + 1)
        
        # Fit Tree 1: Pairs (0,1), (0,2), (0,3)
        self.fitted_params['c01'] = CopulaParams(rho=self._estimate_rho(U[:,0], U[:,1]))
        self.fitted_params['c02'] = CopulaParams(rho=self._estimate_rho(U[:,0], U[:,2]))
        self.fitted_params['c03'] = CopulaParams(rho=self._estimate_rho(U[:,0], U[:,3]))
        
        # Compute pseudo-observations for Tree 2
        # h(u1|u0), h(u2|u0), h(u3|u0)
        V1_0 = np.array([self.copula.h(u1, u0, self.fitted_params['c01']) for u1, u0 in zip(U[:,1], U[:,0])])
        V2_0 = np.array([self.copula.h(u2, u0, self.fitted_params['c02']) for u2, u0 in zip(U[:,2], U[:,0])])
        V3_0 = np.array([self.copula.h(u3, u0, self.fitted_params['c03']) for u3, u0 in zip(U[:,3], U[:,0])])
        
        # Fit Tree 2: Pairs (1,2|0), (1,3|0) using V1_0 as pivot
        # Note: In C-Vine with root '0', the next root is '1'.
        self.fitted_params['c12_0'] = CopulaParams(rho=self._estimate_rho(V1_0, V2_0)) # (1,2|0)
        self.fitted_params['c13_0'] = CopulaParams(rho=self._estimate_rho(V1_0, V3_0)) # (1,3|0)
        
        # Compute pseudo-observations for Tree 3
        V2_01 = np.array([self.copula.h(v2, v1, self.fitted_params['c12_0']) for v2, v1 in zip(V2_0, V1_0)])
        V3_01 = np.array([self.copula.h(v3, v1, self.fitted_params['c13_0']) for v3, v1 in zip(V3_0, V1_0)])
        
        # Fit Tree 3: Pair (2,3|0,1)
        self.fitted_params['c23_01'] = CopulaParams(rho=self._estimate_rho(V2_01, V3_01))

    def get_mispricing_index(self, u_target: float, u_partners: List[float]) -> float:
        """
        Calculates M_t = P(U_target <= u_target | U_partners).
        u_partners = [u0, u1, u2]. Target = u3.
        """
        u0, u1, u2 = u_partners[0], u_partners[1], u_partners[2]
        u3 = u_target
        
        # Tree 1
        v1_0 = self.copula.h(u1, u0, self.fitted_params['c01'])
        v2_0 = self.copula.h(u2, u0, self.fitted_params['c02'])
        v3_0 = self.copula.h(u3, u0, self.fitted_params['c03'])
        
        # Tree 2
        v2_01 = self.copula.h(v2_0, v1_0, self.fitted_params['c12_0'])
        v3_01 = self.copula.h(v3_0, v1_0, self.fitted_params['c13_0'])
        
        # Tree 3
        v3_012 = self.copula.h(v3_01, v2_01, self.fitted_params['c23_01'])
        
        return v3_012

    def get_signal(self, current_m: float, threshold: float = 0.8) -> str:
        """
        Mean reversion signal on M_t.
        """
        if current_m < (1 - threshold): 
            return "LONG"
        elif current_m > threshold: 
            return "SHORT"
        return "NEUTRAL"
