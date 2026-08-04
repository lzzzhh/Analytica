"""Agent caller tests — LLM wiring for governance agent roles.

- default stub fails loudly (core stays deterministic)
- caller_from_env without PIPELINE_GOVERNANCE_PI_CLI → stub with clear error
- caller_from_env with a configured CLI → returns a callable
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from pipelines.governance.agent_caller import (  # noqa: E402
    caller_from_env,
    create_pi_rpc_caller,
    create_stub_caller,
)


class TestStubCaller:
    def test_stub_fails_loudly(self):
        c = create_stub_caller()
        r = c("prompt")
        assert not r["ok"]
        assert "no agent caller injected" in r["error"]

    def test_stub_custom_error(self):
        c = create_stub_caller("brain offline")
        r = c("prompt")
        assert r["error"] == "brain offline"


class TestCallerFromEnv:
    def test_no_cli_configured_returns_stub(self, monkeypatch):
        monkeypatch.delenv("PIPELINE_GOVERNANCE_PI_CLI", raising=False)
        c = caller_from_env()
        r = c("prompt")
        assert not r["ok"]
        assert "PIPELINE_GOVERNANCE_PI_CLI" in r["error"]

    def test_cli_configured_returns_callable(self, monkeypatch):
        monkeypatch.setenv("PIPELINE_GOVERNANCE_PI_CLI", "/usr/bin/env")
        c = caller_from_env()
        assert callable(c)


class TestPiRpcCallerProtocol:
    """Protocol-level checks on the caller factory (no real model call)."""

    def test_factory_returns_callable(self):
        c = create_pi_rpc_caller(cli_path="/nonexistent/pi", timeout_ms=500)
        assert callable(c)

    def test_missing_cli_fails_with_exit_info(self):
        c = create_pi_rpc_caller(cli_path="/nonexistent/pi", timeout_ms=2000)
        r = c("prompt")
        assert not r["ok"]
        # subprocess failed to start or exited early — either way not ok
        assert r["error"]
