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

  # --odds 는 여러 번 줄 수 있음 (업체별 배당 → 마진 제거 후 평균)
  #   --odds 1.95 3.60 4.00 --odds 1.92 3.55 4.10

  # 4) 데이터 50% + 분석가(Claude) 판단 50% + 토토 기대값
  python predict.py --lambda-home 1.8 --lambda-away 1.1 --odds 1.95 3.60 4.00 \
                    --analyst 52 25 23 --toto-odds 1.75 3.20 3.55 --ou-odds 1.85 1.80

최종 확률 = (1 - analyst_weight) × 데이터 확률 + analyst_weight × 분석가 판단
데이터 확률 = (1 - market_weight) × 통계 모델 + market_weight × 배당 내재 확률
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


def normalize_triplet(vals: list[float], name: str) -> list[float]:
    """확률 3개(% 또는 0~1)를 합이 1이 되도록 정규화."""
    if len(vals) != 3 or any(v < 0 for v in vals) or sum(vals) <= 0:
        raise ValueError(f"{name} 는 0 이상의 값 3개(홈 무 원정)여야 합니다.")
    s = sum(vals)
    if not (0.95 <= s <= 1.05 or 95 <= s <= 105):
        raise ValueError(f"{name} 합계가 {s:g} 입니다. 합이 100(%) 또는 1이 되게 주세요.")
    return [v / s for v in vals]


def ev_block(prob: float, odds: float) -> dict:
    """기대값(EV)과 1/4 켈리 비중. EV = 확률 × 배당 - 1."""
    ev = prob * odds - 1
    kelly = ev / (odds - 1) if odds > 1 else 0.0
    return {
        "odds": odds,
        "prob": round(prob, 4),
        "fair_odds": round(1 / prob, 2) if prob > 0 else None,
        "ev": round(ev, 4),
        "quarter_kelly": round(max(0.0, kelly) / 4, 4),
    }


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
        # 업체별로 마진을 제거한 뒤 평균 → 한 업체의 이상치 영향 완화
        per_book = [implied_from_odds(o) for o in args.odds]
        market = [sum(col) / len(per_book) for col in zip(*per_book)]
        result["bookmakers_used"] = len(per_book)
        if len(per_book) > 1:
            result["bookmaker_margins"] = [round(sum(1 / x for x in o) - 1, 4) for o in args.odds]
        w = args.market_weight
        final = [(1 - w) * mp + w * kp for mp, kp in zip(model, market)]
        result["market_probs"] = dict(zip(["home", "draw", "away"], (round(p, 4) for p in market)))
        result["market_weight"] = w
        # 모델과 시장의 차이가 큰 쪽 = 모델이 시장과 다르게 보는 지점
        result["model_minus_market"] = dict(
            zip(["home", "draw", "away"], (round(mp - kp, 4) for mp, kp in zip(model, market))))

    data = final
    result["data_probs"] = dict(zip(["home", "draw", "away"], (round(p, 4) for p in data)))

    if args.analyst:
        analyst = normalize_triplet(args.analyst, "--analyst")
        w = args.analyst_weight
        final = [(1 - w) * dp + w * ap for dp, ap in zip(data, analyst)]
        result["analyst_probs"] = dict(zip(["home", "draw", "away"], (round(p, 4) for p in analyst)))
        result["analyst_weight"] = w

    result["final_probs"] = dict(zip(["home", "draw", "away"], (round(p, 4) for p in final)))

    scores = sorted(((m[h][a], f"{h}-{a}") for h in range(MAX_GOALS + 1)
                     for a in range(MAX_GOALS + 1)), reverse=True)[:5]
    result["top_scorelines"] = [{"score": s, "prob": round(p, 4)} for p, s in scores]

    over25 = sum(m[h][a] for h in range(MAX_GOALS + 1) for a in range(MAX_GOALS + 1) if h + a > 2)
    btts = sum(m[h][a] for h in range(1, MAX_GOALS + 1) for a in range(1, MAX_GOALS + 1))
    result["over_2_5"] = round(over25, 4)
    result["btts"] = round(btts, 4)

    bet_odds = args.toto_odds or (args.odds[0] if args.odds else None)
    if bet_odds:
        margin = sum(1 / o for o in bet_odds) - 1
        picks = {k: ev_block(p, o) for k, p, o in zip(["home", "draw", "away"], final, bet_odds)}
        best = max(picks, key=lambda k: picks[k]["ev"])
        result["toto"] = {
            "odds_source": "toto_odds" if args.toto_odds else "odds[0]",
            "bookmaker_margin": round(margin, 4),
            "picks": picks,
            "best_pick": best if picks[best]["ev"] > 0 else None,
        }
        if args.ou_odds:
            # 오버/언더는 분석가 판단 없이 스코어 분포 기준
            result["toto"]["over_2_5"] = ev_block(over25, args.ou_odds[0])
            result["toto"]["under_2_5"] = ev_block(1 - over25, args.ou_odds[1])
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
    p.add_argument("--odds", type=float, nargs=3, action="append", metavar=("HOME", "DRAW", "AWAY"),
                   help="해외 업체 소수 배당 (예: 1.95 3.60 4.00). 업체마다 반복 가능")
    p.add_argument("--market-weight", type=float, default=0.5,
                   help="배당 내재 확률 반영 비중 0~1 (기본 0.5)")
    p.add_argument("--analyst", type=float, nargs=3, metavar=("HOME", "DRAW", "AWAY"),
                   help="분석가(Claude) 독자 판단 확률 (% 또는 0~1, 예: 52 25 23)")
    p.add_argument("--analyst-weight", type=float, default=0.5,
                   help="분석가 판단 반영 비중 0~1 (기본 0.5)")
    p.add_argument("--toto-odds", type=float, nargs=3, metavar=("HOME", "DRAW", "AWAY"),
                   help="실제로 걸 토토/프로토 배당 (없으면 --odds 로 기대값 계산)")
    p.add_argument("--ou-odds", type=float, nargs=2, metavar=("OVER", "UNDER"),
                   help="2.5골 오버/언더 배당")
    args = p.parse_args()

    for name in ("market_weight", "analyst_weight"):
        if not 0 <= getattr(args, name) <= 1:
            p.error(f"--{name.replace('_', '-')} 는 0~1 사이여야 합니다.")
    for name in ("toto_odds", "ou_odds"):
        vals = getattr(args, name)
        if vals and any(o <= 1.0 for o in vals):
            p.error(f"--{name.replace('_', '-')} 는 1.0 보다 큰 소수 배당이어야 합니다.")
    try:
        print(json.dumps(predict(args), ensure_ascii=False, indent=2))
    except ValueError as e:
        print(f"오류: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
