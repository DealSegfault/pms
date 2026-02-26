"""
Exchange clients package

This package contains exchange-specific client implementations.
"""

# Make the exchanges package available as a top-level import
import sys
from pathlib import Path

# Add the parent directory to sys.path to allow imports from 'exchanges'
parent_dir = str(Path(__file__).parent.parent.parent)
if parent_dir not in sys.path:
    sys.path.append(parent_dir) 