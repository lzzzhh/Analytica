#!/usr/bin/env python3
"""Controlled analysis runner helpers for the Data Analysis Subagent.

This module is the Python side of the controlled script runner:
  - validate_script.py  : static checks on analysis.py before execution
  - validate_result.py  : structural checks on analysis-result.json

The runner itself is spawned by the TypeScript layer as `python3 <analysis.py>`
with a whitelisted environment. These helpers never touch the network,
never install packages, and never read credentials.
"""
