#!/usr/bin/env bash
# tunebridge_stats.sh — TuneBridge download & engagement stats
# Usage: bash tunebridge_stats.sh

REPO="hashansr/tunebridge-releases"

BOLD=$'\033[1m'
DIM=$'\033[2m'
GREEN=$'\033[32m'
BLUE=$'\033[34m'
YELLOW=$'\033[33m'
NC=$'\033[0m'

echo ""
echo -e "${BOLD}📊  TuneBridge Stats${NC}  ${DIM}$(date '+%Y-%m-%d %H:%M')${NC}"
echo -e "${DIM}────────────────────────────────────────────${NC}"

# ── Downloads ────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Downloads${NC}"

RELEASES=$(gh api /repos/${REPO}/releases --jq '
  .[] | select(.prerelease == false) |
  {tag: .tag_name, published: (.published_at | split("T")[0]),
   downloads: ([.assets[].download_count] | add // 0)}
' 2>/dev/null)

if [ -z "$RELEASES" ]; then
  echo -e "  ${DIM}No prod releases found yet.${NC}"
else
  TOTAL=0
  while IFS= read -r line; do
    TAG=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['tag'])")
    DATE=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['published'])")
    DL=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['downloads'])")
    TOTAL=$((TOTAL + DL))
    printf "  %-18s  ${DIM}%s${NC}  ${GREEN}%s downloads${NC}\n" "$TAG" "$DATE" "$DL"
  done <<< "$RELEASES"
  echo -e "${DIM}  ────────────────────────────────────────────${NC}"
  echo -e "  ${BOLD}Total downloads:  ${GREEN}${TOTAL}${NC}"
fi

# ── Repo engagement ───────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Repo Engagement  ${DIM}(github.com/${REPO})${NC}"

REPO_INFO=$(gh api /repos/${REPO} --jq '{stars: .stargazers_count, watchers: .subscribers_count, forks: .forks_count}' 2>/dev/null)
STARS=$(echo "$REPO_INFO"  | python3 -c "import sys,json; print(json.load(sys.stdin)['stars'])")
WATCH=$(echo "$REPO_INFO"  | python3 -c "import sys,json; print(json.load(sys.stdin)['watchers'])")

printf "  %-20s  ${YELLOW}%s${NC}\n" "Stars" "$STARS"
printf "  %-20s  ${YELLOW}%s${NC}\n" "Watchers" "$WATCH"

# ── Traffic (last 14 days) ────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Releases Page Traffic  ${DIM}(last 14 days)${NC}"

VIEWS=$(gh api /repos/${REPO}/traffic/views   --jq '{total: .count, unique: .uniques}' 2>/dev/null)
CLONES=$(gh api /repos/${REPO}/traffic/clones --jq '{total: .count, unique: .uniques}' 2>/dev/null)

if [ -n "$VIEWS" ]; then
  V_TOTAL=$(echo "$VIEWS"  | python3 -c "import sys,json; print(json.load(sys.stdin)['total'])")
  V_UNIQ=$(echo "$VIEWS"   | python3 -c "import sys,json; print(json.load(sys.stdin)['unique'])")
  C_TOTAL=$(echo "$CLONES" | python3 -c "import sys,json; print(json.load(sys.stdin)['total'])")
  C_UNIQ=$(echo "$CLONES"  | python3 -c "import sys,json; print(json.load(sys.stdin)['unique'])")
  printf "  %-20s  %s views  ${DIM}(%s unique)${NC}\n" "Page views" "$V_TOTAL" "$V_UNIQ"
  printf "  %-20s  %s clones ${DIM}(%s unique)${NC}\n" "Repo clones" "$C_TOTAL" "$C_UNIQ"
else
  echo -e "  ${DIM}No traffic data (requires repo push access).${NC}"
fi

# ── Note on active users ──────────────────────────────────────────────────────
echo ""
echo -e "${DIM}  Active users: not directly measurable without telemetry.${NC}"
echo -e "${DIM}  Total downloads is the best proxy for installed user base.${NC}"
echo ""
