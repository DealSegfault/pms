#!/usr/bin/env python3
"""
Compatibility shim.

The babysitter runtime and strategy models were extracted to:
  /babysitter

Node still launches:
  python -m bot.v7.babysitter

So this module forwards execution to the extracted runtime.
"""

from babysitter.main import main


if __name__ == "__main__":
    main()

