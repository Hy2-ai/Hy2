#!/usr/bin/env python3
"""토토/프로토 조합(여러 경기 묶음) 기대값 계산.

각 경기는 "확률:배당" 형식 (확률은 % 또는 0~1). 경기 간 결과는 독립이라고 가정합니다.
  python combo_ev.py 55:1.75 48:2.10 30:3.40
"""
from __future__ import annotations

import json
import sys


def parse(token: str) -> tuple[float, float]:
    p_str, o_str = token.split(":")
    p, o = float(p_str), float(o_str)
    if p > 1:
        p /= 100
    if not 0 < p <= 1 or o <= 1:
        raise ValueError(f"잘못된 입력: {token} (확률 0~100, 배당 > 1.0)")
    return p, o


def main() -> int:
    if len(sys.argv) < 3:
        print("경기 2개 이상을 '확률:배당' 형식으로 주세요. 예: 55:1.75 48:2.10", file=sys.stderr)
        return 1
    try:
        legs = [parse(t) for t in sys.argv[1:]]
    except ValueError as e:
        print(f"오류: {e}", file=sys.stderr)
        return 1
    prob, odds = 1.0, 1.0
    for p, o in legs:
        prob *= p
        odds *= o
    ev = prob * odds - 1
    print(json.dumps({
        "legs": [{"prob": round(p, 4), "odds": o, "ev": round(p * o - 1, 4)} for p, o in legs],
        "combo_prob": round(prob, 4),
        "combo_odds": round(odds, 2),
        "combo_ev": round(ev, 4),
        "note": "단일 경기 EV가 음수인 경기가 섞이면 조합 EV도 깎입니다.",
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
