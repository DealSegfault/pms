from __future__ import annotations

import os
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parents[1]
_ENV_FILE = _PROJECT_ROOT / ".env"


def load_project_env(*, override: bool = False, env_file: Path | None = None) -> Path:
    """Load the repo .env file without shell parsing.

    This keeps values like DATABASE_URL intact when they contain characters such
    as '&' that would be interpreted by `source .env` in bash.
    """

    path = env_file or _ENV_FILE
    if not path.exists():
        return path

    with path.open() as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:].lstrip()

            key, sep, value = line.partition("=")
            if not sep:
                continue

            key = key.strip()
            value = value.strip()
            if not key:
                continue

            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                value = value[1:-1]

            if override or key not in os.environ:
                os.environ[key] = value

    return path
