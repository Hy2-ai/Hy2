#!/usr/bin/env python3
"""축구 경기 결과 확률 계산기 (Poisson + Dixon-Coles 보정 + 배당 블렌딩).

외부 라이브러리 없이 표준 라이브러리만 사용합니다.

사용 예:
  # 1) 팀 득실 통계로 기대 득점(λ) 계산
  python predict.py --home-scored 2.1 --home-conceded 0.9 \
                    --away-scored 1.4 --away-conceded 1.3 \
                    --league-home 1.55 --league-away 1.25

  # 2) 기대 득점을 직접 지정 (xG 기반 등)
  python predict.py --lambda-home 1.8 --lambda-away 1.1

  # 3) 부상·동기 등 보정 + 배당 블렌딩
  python predict.py --lambda-home 1.8 --lambda-away 1.1 \
                    --home-adj 0.92 --odds 1.95 3.60 4.00 --market-weight 0.5
"""
from __future__ import annotations

import argparse
import json
import math
import sys

MAX_GOALS = 10


def poisson_pmf(k: int, lam: float) -> float:
    return math.exp(-lam) * lam**k / math.factorial(k)


def dixon_coles_tau(h: int, a: int, lh: float, la: float, rho: float) -> float:
    """저득점 스코어(0-0, 1-0, 0-1, 1-1)의 상관관계 보정 계수."""
    if h == 0 and a == 0:
        return 1 - lh * la * rho
    if h == 0 and a == 1:
        return 1 + lh * rho
    if h == 1 and a == 0:
        return 1 + la * rho
    if h == 1 and a == 1:
        return 1 - rho
    return 1.0


def score_matrix(lh: float, la: float, rho: float) -> list[list[float]]:
    m = [
        [max(0.0, poisson_pmf(h, lh) * poisson_pmf(a, la) * dixon_coles_tau(h, a, lh, la, rho))
         for a in range(MAX_GOALS + 1)]
        for h in range(MAX_GOALS + 1)
    ]
    total = sum(map(sum, m))
    return [[p / total for p in row] for row in m]


def implied_from_odds(odds: list[float]) -> list[float]:
    """소수 배당(홈/무/원정)에서 북메이커 마진을 제거한 내재 확률."""
    if len(odds) != 3 or any(o <= 1.0 for o in odds):
        raise ValueError("--odds 는 1.0 보다 큰 소수 배당 3개(홈 무 원정)여야 합니다.")
    raw = [1 / o for o in odds]
    s = sum(raw)
    return [r / s for r in raw]


def expected_goals(args: argparse.Namespace) -> tuple[float, float]:
    if args.lambda_home is not None and args.lambda_away is not None:
        lh, la = args.lambda_home, args.lambda_away
    else:
        needed = ["home_scored", "home_conceded", "away_scored", "away_conceded",
                  "league_home", "league_away"]
        missing = [n for n in needed if getattr(args, n) is None]
        if missing:
            raise ValueError("λ를 직접 주거나 다음 값을 모두 주세요: "
                             + ", ".join("--" + n.replace("_", "-") for n in missing))
        # 공격력 = 팀 득점 / 리그 평균, 수비력 = 팀 실점 / 리그 평균
        home_att = args.home_scored / args.league_home
        home_def = args.home_conceded / args.league_away
        away_att = args.away_scored / args.league_away
        away_def = args.away_conceded / args.league_home
        lh = home_att * away_def * args.league_home
        la = away_att * home_def * args.league_away
    lh *= args.home_adj
    la *= args.away_adj
    if lh <= 0 or la <= 0:
        raise ValueError("기대 득점은 0보다 커야 합니다.")
    return lh, la


def predict(args: argparse.Namespace) -> dict:
    lh, la = expected_goals(args)
    m = score_matrix(lh, la, args.rho)

    home = sum(m[h][a] for h in range(MAX_GOALS + 1) for a in range(MAX_GOALS + 1) if h > a)
    draw = sum(m[i][i] for i in range(MAX_GOALS + 1))
    away = 1 - home - draw
    model = [home, draw, away]

    result: dict = {
        "expected_goals": {"home": round(lh, 2), "away": round(la, 2)},
        "model_probs": dict(zip(["home", "draw", "away"], (round(p, 4) for p in model))),
    }

    final = model
    if args.odds:
        market = implied_from_odds(args.odds)
        w = args.market_weight
        final = [(1 - w) * mp + w * kp for mp, kp in zip(model, market)]
        result["market_probs"] = dict(zip(["home", "draw", "away"], (round(p, 4) for p in market)))
        result["market_weight"] = w
        # 모델과 시장의 차이가 큰 쪽 = 모델이 시장과 다르게 보는 지점
        result["model_minus_market"] = dict(
            zip(["home", "draw", "away"], (round(mp - kp, 4) for mp, kp in zip(model, market))))

    result["final_probs"] = dict(zip(["home", "draw", "away"], (round(p, 4) for p in final)))

    scores = sorted(((m[h][a], f"{h}-{a}") for h in range(MAX_GOALS + 1)
                     for a in range(MAX_GOALS + 1)), reverse=True)[:5]
    result["top_scorelines"] = [{"score": s, "prob": round(p, 4)} for p, s in scores]

    over25 = sum(m[h][a] for h in range(MAX_GOALS + 1) for a in range(MAX_GOALS + 1) if h + a > 2)
    btts = sum(m[h][a] for h in range(1, MAX_GOALS + 1) for a in range(1, MAX_GOALS + 1))
    result["over_2_5"] = round(over25, 4)
    result["btts"] = round(btts, 4)
    return result


def main() -> int:
    p = argparse.ArgumentParser(description="축구 경기 승/무/패 확률 계산")
    p.add_argument("--home-scored", type=float, help="홈팀 경기당 득점(홈 경기 기준 권장)")
    p.add_argument("--home-conceded", type=float, help="홈팀 경기당 실점")
    p.add_argument("--away-scored", type=float, help="원정팀 경기당 득점(원정 경기 기준 권장)")
    p.add_argument("--away-conceded", type=float, help="원정팀 경기당 실점")
    p.add_argument("--league-home", type=float, help="리그 평균 홈팀 득점")
    p.add_argument("--league-away", type=float, help="리그 평균 원정팀 득점")
    p.add_argument("--lambda-home", type=float, help="홈팀 기대 득점 직접 지정")
    p.add_argument("--lambda-away", type=float, help="원정팀 기대 득점 직접 지정")
    p.add_argument("--home-adj", type=float, default=1.0, help="홈 기대 득점 보정 배수 (부상 등)")
    p.add_argument("--away-adj", type=float, default=1.0, help="원정 기대 득점 보정 배수")
    p.add_argument("--rho", type=float, default=-0.1, help="Dixon-Coles 저득점 보정 (기본 -0.1, 0=끔)")
    p.add_argument("--odds", type=float, nargs=3, metavar=("HOME", "DRAW", "AWAY"),
                   help="소수 배당 (예: 1.95 3.60 4.00)")
    p.add_argument("--market-weight", type=float, default=0.5,
                   help="배당 내재 확률 반영 비중 0~1 (기본 0.5)")
    args = p.parse_args()

    if not 0 <= args.market_weight <= 1:
        p.error("--market-weight 는 0~1 사이여야 합니다.")
    try:
        print(json.dumps(predict(args), ensure_ascii=False, indent=2))
    except ValueError as e:
        print(f"오류: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
