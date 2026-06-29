"""This module has no corresponding test (testing-gap smell)."""


def risky_division(a, b):
    return a / b


def parse_config(raw):
    result = {}
    for line in raw.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            result[k.strip()] = v.strip()
    return result
