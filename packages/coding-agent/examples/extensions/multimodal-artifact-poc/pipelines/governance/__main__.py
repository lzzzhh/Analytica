"""Entry point for `python3 -m pipelines.governance`."""
import sys

from pipelines.governance.cli import main

if __name__ == "__main__":
    sys.exit(main())
