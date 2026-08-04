#!/usr/bin/env python3
"""Unit tests for ab_experiment_calculator.py.

Run: python3 -m unittest scripts/test_ab_experiment_calculator.py -v
"""
import json
import math
import subprocess
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "ab_experiment_calculator.py"


def run(*args: str) -> dict:
    out = subprocess.run([sys.executable, str(SCRIPT), *args],
                         capture_output=True, text=True)
    if out.returncode != 0:
        raise AssertionError(f"calc failed: {args} -> {out.stderr}")
    return json.loads(out.stdout)


class TestSampleSizeBinary(unittest.TestCase):
    def test_detects_small_effect_needs_more(self):
        r1 = run("sample-size-binary", "0.05", "0.06", "--alpha", "0.05", "--power", "0.8")
        r2 = run("sample-size-binary", "0.05", "0.10", "--alpha", "0.05", "--power", "0.8")
        self.assertGreater(r1["sampleSizePerGroup"], r2["sampleSizePerGroup"])
        self.assertGreater(r2["sampleSizePerGroup"], 0)

    def test_higher_power_needs_more(self):
        r1 = run("sample-size-binary", "0.1", "0.12", "--alpha", "0.05", "--power", "0.8")
        r2 = run("sample-size-binary", "0.1", "0.12", "--alpha", "0.05", "--power", "0.9")
        self.assertGreater(r2["sampleSizePerGroup"], r1["sampleSizePerGroup"])

    def test_same_rate_rejected(self):
        out = subprocess.run([sys.executable, str(SCRIPT), "sample-size-binary", "0.1", "0.1"],
                             capture_output=True, text=True)
        self.assertEqual(out.returncode, 2)


class TestSampleSizeContinuous(unittest.TestCase):
    def test_smaller_sigma_needs_less(self):
        r1 = run("sample-size-continuous", "2", "0.5", "--alpha", "0.05", "--power", "0.8")
        r2 = run("sample-size-continuous", "1", "0.5", "--alpha", "0.05", "--power", "0.8")
        self.assertGreater(r1["sampleSizePerGroup"], r2["sampleSizePerGroup"])


class TestDuration(unittest.TestCase):
    def test_basic(self):
        r = run("duration", "10000", "1000", "0.5")
        self.assertEqual(r["daysWithoutMaturity"], 20)  # 10000 / (1000*0.5)

    def test_with_maturity(self):
        r = run("duration", "10000", "1000", "0.5", "--maturity-days", "7")
        self.assertEqual(r["totalDays"], 27)


class TestSrm(unittest.TestCase):
    def test_balanced_not_suspected(self):
        r = run("srm", "1", "1", "1000", "1000")
        self.assertFalse(r["srmSuspected"])
        self.assertGreater(r["pValue"], 0.05)

    def test_imbalanced_suspected(self):
        r = run("srm", "1", "1", "1500", "500", "--alpha", "0.001")
        self.assertTrue(r["srmSuspected"])
        self.assertLess(r["pValue"], 0.001)

    def test_srm_ratio_mismatch_direction(self):
        # 90/10 observed vs 50/50 expected must be flagged
        r = run("srm", "1", "1", "1800", "200")
        self.assertTrue(r["srmSuspected"])


class TestAnalyzeBinary(unittest.TestCase):
    def test_significant_positive(self):
        r = run("analyze-binary", "1000", "100", "1000", "150")
        self.assertGreater(r["absoluteEffect"], 0)
        self.assertLess(r["pValue"], 0.05)
        self.assertIn(r["evidence"], ("SIGNIFICANT", "CLEAR_POSITIVE", "POSITIVE_BUT_BELOW_THRESHOLD"))

    def test_not_significant(self):
        r = run("analyze-binary", "1000", "100", "1000", "102")
        self.assertGreater(r["pValue"], 0.05)

    def test_practical_threshold_classification(self):
        r = run("analyze-binary", "1000", "100", "1000", "150",
                "--practical-threshold", "0.02")
        self.assertEqual(r["evidence"], "CLEAR_POSITIVE")


class TestAnalyzeContinuous(unittest.TestCase):
    def test_clear_positive(self):
        r = run("analyze-continuous", "100", "10", "3", "100", "13", "3")
        self.assertGreater(r["absoluteEffect"], 0)
        self.assertLess(r["pValue"], 0.05)
        self.assertGreater(r["ci95"][0], 0)


if __name__ == "__main__":
    unittest.main()
