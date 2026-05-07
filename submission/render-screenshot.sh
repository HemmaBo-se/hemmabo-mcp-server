#!/usr/bin/env bash
# Render submission/screenshot-property-cards.png (706x600) in HemmaBo brand:
# dark navy background, dark cards with subtle borders, blue accent, white text.
# Mirrors the search.properties widget (ui://widget/property-card.html).
set -euo pipefail

OUT="$(dirname "$0")/screenshot-property-cards.png"
FONT="DejaVu-Sans"
FONT_BOLD="DejaVu-Sans-Bold"

# Brand palette (sampled from hemmabo.se)
BG="#0a0e27"          # deep navy backdrop
CARD_BG="#111634"     # slightly lighter navy for cards
CARD_BORDER="#1f2547" # subtle border
TEXT="#f5f7ff"        # near-white
TEXT_MUTED="#8b93b8"  # muted blue-gray
ACCENT="#5b8def"      # HemmaBo blue
PRICE_OLD="#5a6088"   # struck-through price
BADGE_BG="#0f3a2a"    # dark mint badge bg
BADGE_TEXT="#34d399"  # mint badge text

# Top bar (header) shows HemmaBo wordmark + Vera label, like the live site.
# 4 cards in 2x2 grid below header.

# Per-card: image color (warm overlay), country code accent, title, location, sleeps, list price, deal price, discount.
declare -a CARDS=(
  "1e3a8a|7dd3fc|SE|Villa Akerlyckan|Skane, Sweden|Sleeps 8|SEK 18,900|SEK 16,200|-14%"
  "713f12|fbbf24|SE|Stuga Skane|Skane, Sweden|Sleeps 6|SEK 14,000|SEK 12,600|-10%"
  "14532d|86efac|IT|Casa Toscana|Toscana, Italy|Sleeps 10|EUR 2,400|EUR 2,040|-15%"
  "7f1d1d|fda4af|DE|Cabin Bavaria|Bavaria, Germany|Sleeps 4|EUR 1,800|EUR 1,548|-14%"
)

# Canvas
magick -size 706x600 "xc:$BG" "$OUT"

# Header strip with HemmaBo wordmark + Vera tag (no localizable copy, brand only)
magick "$OUT" -fill "$TEXT" -font "$FONT_BOLD" -pointsize 18 -draw "text 24,38 'HemmaBo'" "$OUT"
# small accent dot before wordmark
magick "$OUT" -fill "$ACCENT" -draw "circle 16,32 16,36" "$OUT"
# Vera pill on the right
magick "$OUT" -fill "$CARD_BG" -stroke "$CARD_BORDER" -strokewidth 1 -draw "roundrectangle 612,20 682,46 13,13" "$OUT"
magick "$OUT" -fill "$ACCENT" -stroke none -draw "circle 626,33 626,30" "$OUT"
magick "$OUT" -fill "$TEXT" -font "$FONT_BOLD" -pointsize 12 -draw "text 638,38 'Vera'" "$OUT"

# Subtle divider under header
magick "$OUT" -fill "$CARD_BORDER" -draw "rectangle 24,62 682,63" "$OUT"

draw_card() {
  local x=$1 y=$2 imgcolor=$3 labelcolor=$4 cc=$5 title=$6 loc=$7 sleeps=$8 listp=$9 dealp=${10} disc=${11}
  local x2=$((x+312)) y2=$((y+248))
  local imgy2=$((y+148))

  # card body (dark) with subtle border
  magick "$OUT" -fill "$CARD_BG" -stroke "$CARD_BORDER" -strokewidth 1 -draw "roundrectangle $x,$y $x2,$y2 14,14" "$OUT"
  # image area top
  magick "$OUT" -fill "#$imgcolor" -stroke none -draw "roundrectangle $x,$y $x2,$imgy2 14,14" "$OUT"
  magick "$OUT" -fill "#$imgcolor" -draw "rectangle $x,$((imgy2-14)) $x2,$imgy2" "$OUT"
  # country code accent in image
  magick "$OUT" -fill "#$labelcolor" -font "$FONT_BOLD" -pointsize 40 -draw "text $((x+18)),$((y+72)) '$cc'" "$OUT"
  # title
  magick "$OUT" -fill "$TEXT" -stroke none -font "$FONT_BOLD" -pointsize 15 -draw "text $((x+16)),$((y+178)) '$title'" "$OUT"
  # location
  magick "$OUT" -fill "$TEXT_MUTED" -font "$FONT" -pointsize 12 -draw "text $((x+16)),$((y+198)) '$loc'" "$OUT"
  # sleeps
  magick "$OUT" -fill "$TEXT_MUTED" -font "$FONT" -pointsize 12 -draw "text $((x+16)),$((y+214)) '$sleeps'" "$OUT"
  # list price (strikethrough)
  magick "$OUT" -fill "$PRICE_OLD" -font "$FONT" -pointsize 13 -draw "text $((x+16)),$((y+236)) '$listp'" "$OUT"
  magick "$OUT" -fill "$PRICE_OLD" -draw "rectangle $((x+16)),$((y+231)) $((x+96)),$((y+232))" "$OUT"
  # deal price (bold accent)
  magick "$OUT" -fill "$TEXT" -font "$FONT_BOLD" -pointsize 14 -draw "text $((x+100)),$((y+236)) '$dealp'" "$OUT"
  # discount badge
  magick "$OUT" -fill "$BADGE_BG" -draw "roundrectangle $((x+250)),$((y+222)) $((x+296)),$((y+242)) 10,10" "$OUT"
  magick "$OUT" -fill "$BADGE_TEXT" -font "$FONT_BOLD" -pointsize 11 -draw "text $((x+260)),$((y+236)) '$disc'" "$OUT"
}

# Layout below header (header takes ~80px). Cards 312x248, 22px gap, 24px outer pad.
positions=( "24 80" "370 80" "24 340" "370 340" )

for i in 0 1 2 3; do
  IFS='|' read -ra F <<< "${CARDS[$i]}"
  IFS=' ' read -ra P <<< "${positions[$i]}"
  draw_card "${P[0]}" "${P[1]}" "${F[0]}" "${F[1]}" "${F[2]}" "${F[3]}" "${F[4]}" "${F[5]}" "${F[6]}" "${F[7]}" "${F[8]}"
done

identify "$OUT"
